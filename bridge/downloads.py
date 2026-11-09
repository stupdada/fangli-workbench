"""Local delivery folder for finished files: article exports and task archives only."""
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from .errors import Problem

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NAME = '下载'
KEY = 'download_dir'
# Windows keeps these reserved in file names; the same replacement keeps archives readable elsewhere.
INVALID = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

# The page cannot obtain an absolute path from a browser picker, so the folder dialog belongs to
# this machine's own process. The result is written to a UTF-8 side file to avoid console codepages.
PICK_SCRIPT = '''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText('__OUT__', "start`n`n", (New-Object System.Text.UTF8Encoding($false)))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# An invisible owner window makes the dialog come to the front over the browser. A minimized
# owner instead makes ShowDialog return immediately, which looks exactly like a user cancel.
$owner = New-Object System.Windows.Forms.Form
$owner.Text = '选择下载文件夹'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择成品下载文件夹'
$dialog.ShowNewFolderButton = $true
$initial = '__INITIAL__'
if ($initial -ne '' -and (Test-Path -LiteralPath $initial)) { $dialog.SelectedPath = $initial }
$result = $dialog.ShowDialog($owner)
$state = 'cancel'
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $state = 'ok' }
$interactive = [System.Windows.Forms.SystemInformation]::UserInteractive
[IO.File]::WriteAllText('__OUT__', "$state`n$($dialog.SelectedPath)`ninteractive=$interactive", (New-Object System.Text.UTF8Encoding($false)))
$owner.Close()
$owner.Dispose()
'''


def safe_filename(name):
    cleaned = INVALID.sub('_', Path(str(name or '')).name).strip().strip('.')
    return cleaned or '方立导出'


def unique(folder, name):
    """Never overwrite an earlier delivery; add a readable counter instead."""
    candidate = folder / name
    stem, suffix = candidate.stem, candidate.suffix
    counter = 2
    while candidate.exists():
        candidate = folder / f'{stem} ({counter}){suffix}'
        counter += 1
    return candidate


class Downloads:
    """A user-chosen absolute folder on this machine.

    Source documents stay in the data directory; only finished files are delivered here,
    so a missing folder never breaks generation or downloading a customer original.
    """

    def __init__(self, service):
        self.store = service.store
        self.write_lock = threading.Lock()
        with self.store.conn() as c:
            c.execute('CREATE TABLE IF NOT EXISTS wb_local_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)')

    def configured(self):
        with self.store.conn() as c:
            row = c.execute('SELECT value FROM wb_local_settings WHERE key=?', (KEY,)).fetchone()
        return row[0] if row else ''

    def default_path(self):
        return ROOT / DEFAULT_NAME

    def path(self):
        """The effective folder; a configured value must already exist and be writable."""
        raw = self.configured()
        return self.validate(raw) if raw else self.default_path()

    @staticmethod
    def validate(value):
        text = str(value or '').strip()
        if not text:
            raise Problem('下载路径不能为空；恢复默认请选择默认路径')
        if len(text) > 400:
            raise Problem('下载路径过长，请换一个更短的文件夹')
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            raise Problem('下载路径需填写完整的绝对路径，例如 D:\\方立导出')
        if not candidate.exists():
            raise Problem(f'下载路径不存在：{candidate}。请先创建这个文件夹，或改回默认路径')
        if not candidate.is_dir():
            raise Problem(f'下载路径不是文件夹：{candidate}')
        if not os.access(candidate, os.W_OK):
            raise Problem(f'下载路径不可写：{candidate}')
        return candidate

    def save(self, value):
        if not isinstance(value, str):
            raise Problem('下载路径需为文字，留空表示使用默认路径')
        text = value.strip()
        path = self.validate(text) if text else None
        with self.store.conn() as c:
            if path is None:
                c.execute('DELETE FROM wb_local_settings WHERE key=?', (KEY,))
            else:
                c.execute('INSERT INTO wb_local_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (KEY, str(path)))
        return self.public()

    def public(self):
        configured = self.configured()
        return {'download_dir': configured,
                'download_dir_effective': str(Path(configured) if configured else self.default_path()),
                'download_dir_default': str(self.default_path())}

    def pick(self, timeout=90):
        """Choose the folder with this machine's own dialog, then keep it.

        The page cannot read an absolute path out of a browser picker, so the dialog runs in the
        local process. Cancelling changes nothing; a configured folder that has since disappeared
        only affects the dialog's starting point, never the export itself.
        """
        if sys.platform != 'win32':
            raise Problem('当前系统不支持弹出文件夹选择框，请手动填写绝对路径')
        try:
            initial = str(self.path())
        except Problem:
            initial = str(self.default_path())
        with tempfile.TemporaryDirectory(prefix='fangli-pick-') as scratch:
            lines = self._pick_result(Path(scratch), initial, timeout)
        state = (lines[0] if lines else '').strip()
        chosen = (lines[1] if len(lines) > 1 else '').strip()
        if state == 'cancel':
            return {'cancelled': True, 'settings': self.public()}
        if state != 'ok' or not chosen:
            raise Problem('系统文件夹选择框异常退出，未更改下载路径。可展开「手动填写路径」直接填写')
        return {'cancelled': False, 'settings': self.save(chosen)}

    @staticmethod
    def _pick_result(scratch, initial, timeout):
        target = scratch / 'result.txt'
        script_file = scratch / 'pick.ps1'
        script = (PICK_SCRIPT
                  .replace('__OUT__', str(target).replace("'", "''"))
                  .replace('__INITIAL__', initial.replace("'", "''")))
        # The BOM keeps the script readable by Windows PowerShell 5.1.
        script_file.write_text(script, encoding='utf-8-sig')
        try:
            completed = subprocess.run(['powershell.exe', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', str(script_file)],
                                       capture_output=True, encoding='utf-8', errors='replace', timeout=timeout,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except subprocess.TimeoutExpired:
            raise Problem('文件夹选择框长时间没有响应，未更改下载路径') from None
        except OSError as exc:
            raise Problem(f'无法打开系统文件夹选择框：{exc.strerror or exc}。可展开「手动填写路径」直接填写') from None
        if not target.exists():
            if completed.returncode:
                raise Problem('系统文件夹选择框启动失败。可展开「手动填写路径」直接填写')
            raise Problem('系统文件夹选择框没有返回结果，可展开「手动填写路径」直接填写')
        return target.read_text(encoding='utf-8-sig').splitlines()

    def write(self, name, body):
        folder = self.path()
        temp = None
        try:
            folder.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=folder, prefix='.fangli-', suffix='.part', delete=False) as out:
                temp = Path(out.name)
                out.write(body)
                out.flush()
                os.fsync(out.fileno())
            with self.write_lock:
                target = unique(folder, safe_filename(name))
                with target.open('xb'):
                    pass
                try:
                    temp.replace(target)
                except OSError:
                    target.unlink(missing_ok=True)
                    raise
        except OSError as exc:
            raise Problem(f'写入下载路径失败：{folder}（{exc.strerror or exc}）') from None
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)
        return target
