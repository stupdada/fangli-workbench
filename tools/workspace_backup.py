"""Back up and restore one stopped Fangli workbench, including its media."""
import argparse
import hashlib
import json
import shutil
import sqlite3
import stat
import sys
import tempfile
from contextlib import ExitStack, closing
from pathlib import Path, PurePosixPath, PureWindowsPath
from zipfile import BadZipFile, ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.errors import Problem
from bridge.http import DatabaseLease

DATABASES = ('workbench.db', 'video/video.sqlite3')
OPTIONAL_DATABASES = ('writing-lab.sqlite3',)
MANIFEST = 'manifest.json'
VIDEO_RUNTIME = {'service.lock', 'video.sqlite3', 'video.sqlite3-wal',
                 'video.sqlite3-shm', 'video.sqlite3-journal'}


def video_runtime(path):
    return (len(path.parts) > 1 and path.parts[0] == 'video'
            and (path.parts[1] in VIDEO_RUNTIME or path.parts[1:3] == ('narrated', 'health')))


def stored_path(name):
    path = PurePosixPath(name)
    if (not path.parts or path.is_absolute() or path.as_posix() != name
            or any(part == '..' or any(c in part for c in '<>:"\\|?*') or PureWindowsPath(part).is_reserved()
                   or part.endswith((' ', '.')) for part in path.parts)):
        return False
    if name in (*DATABASES, *OPTIONAL_DATABASES):
        return True
    return len(path.parts) > 1 and path.parts[0] in ('clients', 'video') and not video_runtime(path)


def workspace_files(root, path):
    if not path.exists() and not path.is_symlink():
        return
    attrs = getattr(path.lstat(), 'st_file_attributes', 0)
    if path.is_symlink() or attrs & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError(f'备份范围内存在链接：{path.relative_to(root)}')
    if path.is_dir():
        for child in sorted(path.iterdir()):
            relative = child.relative_to(root)
            if video_runtime(relative):
                continue
            if not stored_path(relative.as_posix()):
                raise ValueError(f'备份路径无法安全恢复：{relative}')
            yield from workspace_files(root, child)
    elif path.is_file():
        yield path
    else:
        raise ValueError(f'备份范围内存在特殊文件：{path.relative_to(root)}')


def open_database(path):
    return closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True))


def database_version(path):
    with open_database(path) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError(f'数据库完整性检查失败：{path.name}')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError(f'数据库外键检查失败：{path.name}')
        return db.execute('PRAGMA user_version').fetchone()[0]


def transfer(source, target):
    digest = hashlib.sha256()
    size = 0
    for data in iter(lambda: source.read(1024 * 1024), b''):
        target.write(data)
        digest.update(data)
        size += len(data)
    return {'size': size, 'sha256': digest.hexdigest()}


def require_new(path):
    if path.exists() or path.is_symlink():
        raise ValueError(f'目标已存在：{path}')


def backup(source, destination):
    require_new(destination)
    if destination.is_relative_to(source):
        raise ValueError('备份文件须放在源工作区之外')
    for name in DATABASES:
        path = source / name
        if not path.is_file() or path.resolve() != path:
            raise ValueError(f'缺少本地数据库：{name}')
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary, ExitStack() as leases:
        staging = Path(temporary)
        for name, lock in zip(DATABASES, (None, 'service.lock')):
            leases.callback(DatabaseLease(source / name, lock_name=lock).close)
        databases = list(DATABASES)
        for name in OPTIONAL_DATABASES:
            path = source / name
            if path.exists() or path.is_symlink():
                if not path.is_file() or path.resolve() != path:
                    raise ValueError(f'无法读取本地数据库：{name}')
                databases.append(name)
        manifest = {'format': 1, 'databases': {}, 'files': {}}
        package = staging / 'workspace.zip'
        with ZipFile(package, 'x') as archive:
            for name in databases:
                snapshot = staging / Path(name).name
                with open_database(source / name) as db, closing(sqlite3.connect(snapshot)) as copy:
                    db.backup(copy)
                manifest['databases'][name] = database_version(snapshot)
                with snapshot.open('rb') as stream, archive.open(name, 'w', force_zip64=True) as entry:
                    manifest['files'][name] = transfer(stream, entry)
            for folder in ('clients', 'video'):
                for path in workspace_files(source, source / folder):
                    name = path.relative_to(source).as_posix()
                    with path.open('rb') as stream, archive.open(name, 'w', force_zip64=True) as entry:
                        manifest['files'][name] = transfer(stream, entry)
            archive.writestr(MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2))
        require_new(destination)
        package.rename(destination)
    return manifest


def restore(source, destination):
    require_new(destination)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary, ZipFile(source) as archive:
        staging = Path(temporary) / 'workspace'
        staging.mkdir()
        manifest = json.loads(archive.read(MANIFEST))
        files = manifest['files']
        names = archive.namelist()
        databases = set(manifest['databases'])
        if (manifest['format'] != 1 or not set(DATABASES) <= databases <= {*DATABASES, *OPTIONAL_DATABASES}
                or databases != files.keys() & {*DATABASES, *OPTIONAL_DATABASES}
                or len(names) != len(files) + 1 or set(names) != {MANIFEST, *files}
                or not all(stored_path(name) for name in files)):
            raise ValueError('备份清单与实际文件不符')
        for name, expected in files.items():
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as stream, target.open('xb') as file:
                if transfer(stream, file) != expected:
                    raise ValueError(f'文件校验失败：{name}')
        for name, version in manifest['databases'].items():
            if database_version(staging / name) != version:
                raise ValueError(f'数据库结构版本不符：{name}')
        require_new(destination)
        staging.rename(destination)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('backup', 'restore'))
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    # Resolve parent paths but keep an existing final-component link visible to require_new.
    destination = args.destination.parent.resolve() / args.destination.name
    action = backup if args.operation == 'backup' else restore
    try:
        manifest = action(args.source.resolve(), destination)
    except (Problem, OSError, sqlite3.Error, BadZipFile, KeyError, TypeError, ValueError) as error:
        parser.exit(1, f'{error}\n')
    print(json.dumps({'destination': str(destination), 'files': len(manifest['files']),
                      'databases': manifest['databases']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
