"""Finished files land in the chosen folder, and a rejected folder never loses the export."""
import http.client
import json
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bridge import downloads, exports
from bridge.http import create_server

SETTINGS = '/api/workbench/downloads/settings'
EXPORT = '/api/workbench/conversations/demo/export?fmt=md'
ARCHIVE = '/api/workbench/conversations/demo/archive'


class DownloadPaths(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fangli-downloads-')
        self.root = Path(self.temp.name)
        self.default_dir = self.root / '下载'
        default_dir = self.default_dir
        self.default_patch = patch.object(downloads.Downloads, 'default_path', lambda _: default_dir)
        self.default_patch.start()
        self.server = create_server(self.root / 'workbench.db', port=0)
        self.s = self.server.service
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.default_patch.stop()
        self.temp.cleanup()

    def raw(self, path, method='GET', body=None, *, local=False):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        headers = {'Content-Type': 'application/json'}
        if local:
            headers['X-Fangli-Local-Download'] = '1'
        conn.request(method, path, json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None,
                     headers)
        response = conn.getresponse()
        data = response.read()
        headers = dict(response.getheaders())
        status = response.status
        conn.close()
        return status, headers, data

    def http(self, path, method='GET', body=None, expected=200, *, local=False):
        status, _, data = self.raw(path, method, body, local=local)
        self.assertEqual(status, expected, data[:800])
        return json.loads(data)

    def settings(self, **patch_body):
        if patch_body:
            return self.http(SETTINGS, 'POST', patch_body, local=True)['settings']
        return self.http('/api/workbench/bootstrap', local=True)['download_settings']

    def deliver(self, name='三洋-GEO.md', body='# 稿'.encode('utf-8')):
        with patch.object(exports, 'export', return_value=(body, 'text/markdown; charset=utf-8', name)):
            return self.raw(EXPORT, 'POST', {}, local=True)

    def test_default_folder_receives_export_and_reports_absolute_path(self):
        status, _, data = self.deliver()
        self.assertEqual(status, 200, data[:800])
        result = json.loads(data)
        path = Path(result['path'])
        self.assertTrue(path.is_file())
        self.assertTrue(path.is_relative_to(self.default_dir))
        self.assertEqual(path.read_text(encoding='utf-8'), '# 稿')
        self.assertEqual(result['name'], '三洋-GEO.md')

    def test_configured_folder_is_used_and_earlier_files_are_never_overwritten(self):
        chosen = self.root / '方立导出'
        chosen.mkdir()
        saved = self.settings(download_dir=str(chosen))
        self.assertEqual(saved['download_dir'], str(chosen))
        self.assertEqual(saved['download_dir_effective'], str(chosen))
        for _ in range(2):
            status, _, data = self.deliver()
            self.assertEqual(status, 200, data[:800])
        first, second = chosen / '三洋-GEO.md', chosen / '三洋-GEO (2).md'
        self.assertTrue(first.is_file())
        self.assertTrue(second.is_file())

    def test_public_settings_distinguish_configured_from_effective_path(self):
        settings = self.settings()
        self.assertEqual(settings['download_dir'], '')
        self.assertEqual(settings['download_dir_effective'], str(self.default_dir))
        self.assertEqual(settings['download_dir_default'], str(self.default_dir))

    def test_relative_missing_or_file_paths_are_rejected_without_changing_settings(self):
        existing = self.root / 'not-a-folder.txt'
        existing.write_text('x', encoding='utf-8')
        for value in ('相对目录', str(self.root / '缺失目录'), str(existing)):
            status, _, data = self.raw(SETTINGS, 'POST', {'download_dir': value}, local=True)
            self.assertEqual(status, 400, data[:800])
            self.assertIn('下载路径', json.loads(data)['error'])
        self.assertEqual(self.settings()['download_dir'], '')

    def test_rejected_folder_still_streams_the_file_and_explains_why(self):
        missing = self.root / '被删除的目录'
        with self.s.store.conn() as c:
            c.execute("INSERT OR REPLACE INTO wb_local_settings VALUES('download_dir', ?)", (str(missing),))
        status, headers, data = self.deliver()
        self.assertEqual(status, 200)
        self.assertEqual(data, '# 稿'.encode('utf-8'))
        self.assertNotIn('application/json', headers['Content-Type'])
        self.assertIn('X-Download-Error', headers)

    def test_browser_download_and_head_are_read_only_and_omit_server_paths(self):
        chosen = self.root / '服务器成品'
        chosen.mkdir()
        self.settings(download_dir=str(chosen))
        self.assertNotIn('download_settings', self.http('/api/workbench/bootstrap'))
        with patch.object(exports, 'export', return_value=('# 稿'.encode('utf-8'), 'text/markdown; charset=utf-8', '三洋-GEO.md')):
            status, headers, data = self.raw(EXPORT + '&save=1')
            self.assertEqual(self.raw(EXPORT + '&save=1', 'HEAD', local=True)[2], b'')
        self.assertEqual(status, 200)
        self.assertEqual(data, '# 稿'.encode('utf-8'))
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertEqual(list(chosen.iterdir()), [])

    def test_server_folder_actions_require_local_browser_request(self):
        for path, body in [(SETTINGS, {'download_dir': str(self.root)}),
                           ('/api/workbench/downloads/pick', {}), (EXPORT, {}), (ARCHIVE, {})]:
            self.http(path, 'POST', body, expected=403)
        self.assertEqual(self.settings()['download_dir'], '')
        self.assertFalse(self.default_dir.exists())

    def test_archive_can_be_saved_on_host_or_downloaded(self):
        with patch.object(exports, 'archive', return_value=(b'ZIP archive', 'application/zip', '归档.zip')):
            saved = self.http(ARCHIVE, 'POST', {}, local=True)
            status, headers, data = self.raw(ARCHIVE)
        self.assertEqual(Path(saved['path']).read_bytes(), b'ZIP archive')
        self.assertEqual((status, data), (200, b'ZIP archive'))
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertEqual(len(list(self.default_dir.iterdir())), 1)

    def run_picker(self, chosen):
        """Drive the real pick() flow with a stand-in for the PowerShell dialog."""
        def fake(argv, **kwargs):
            self.assertIn('-STA', argv)
            self.assertIn('-File', argv)
            script = Path(argv[argv.index('-File') + 1]).read_text(encoding='utf-8-sig')
            self.assertIn("ShowDialog", script)
            target = re.search(r"WriteAllText\('([^']+)'", script).group(1).replace("''", "'")
            if chosen is None:
                Path(target).write_text('cancel\n\ninteractive=True', encoding='utf-8')
            else:
                Path(target).write_text(f'ok\n{chosen}\ninteractive=True', encoding='utf-8')
            return subprocess.CompletedProcess(argv, 0, '', '')
        with patch.object(downloads.subprocess, 'run', fake):
            return self.http('/api/workbench/downloads/pick', 'POST', {}, local=True)

    @unittest.skipUnless(sys.platform == 'win32', 'folder dialog is a Windows capability')
    def test_picker_keeps_the_chosen_folder_and_reports_the_effective_path(self):
        chosen = self.root / '选定目录'
        chosen.mkdir()
        result = self.run_picker(str(chosen))
        self.assertFalse(result['cancelled'])
        self.assertEqual(result['settings']['download_dir'], str(chosen))
        self.assertEqual(result['settings']['download_dir_effective'], str(chosen))

    @unittest.skipUnless(sys.platform == 'win32', 'folder dialog is a Windows capability')
    def test_cancelling_the_dialog_leaves_the_current_folder_untouched(self):
        kept = self.root / '保留目录'
        kept.mkdir()
        self.settings(download_dir=str(kept))
        result = self.run_picker(None)
        self.assertTrue(result['cancelled'])
        self.assertEqual(result['settings']['download_dir'], str(kept))

    @unittest.skipUnless(sys.platform == 'win32', 'folder dialog is a Windows capability')
    def test_failed_dialog_is_reported_instead_of_looking_cancelled(self):
        def fake(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 1, '', 'powershell: 已被安全策略拦截')
        with patch.object(downloads.subprocess, 'run', fake):
            status, _, data = self.raw('/api/workbench/downloads/pick', 'POST', {}, local=True)
        self.assertEqual(status, 400, data[:800])
        self.assertIn('启动失败', json.loads(data)['error'])
        self.assertEqual(self.settings()['download_dir'], '')

    @unittest.skipUnless(sys.platform == 'win32', 'folder dialog is a Windows capability')
    def test_picker_rejects_a_folder_that_vanished_before_saving(self):
        disappeared = self.root / '已删除目录'
        disappeared.mkdir()

        def fake(argv, **kwargs):
            script = Path(argv[argv.index('-File') + 1]).read_text(encoding='utf-8-sig')
            target = re.search(r"WriteAllText\('([^']+)'", script).group(1).replace("''", "'")
            Path(target).write_text(f'ok\n{disappeared}\ninteractive=True', encoding='utf-8')
            disappeared.rmdir()
            return subprocess.CompletedProcess(argv, 0, '', '')

        with patch.object(downloads.subprocess, 'run', fake):
            status, _, data = self.raw('/api/workbench/downloads/pick', 'POST', {}, local=True)
        self.assertEqual(status, 400, data[:800])
        self.assertEqual(self.settings()['download_dir'], '')

    @unittest.skipUnless(sys.platform == 'win32', 'folder dialog is a Windows capability')
    def test_dialog_that_never_returns_is_not_reported_as_cancelled(self):
        def fake(argv, **kwargs):
            script = Path(argv[argv.index('-File') + 1]).read_text(encoding='utf-8-sig')
            target = re.search(r"WriteAllText\('([^']+)'", script).group(1).replace("''", "'")
            Path(target).write_text('start\n\n', encoding='utf-8')
            return subprocess.CompletedProcess(argv, 0, '', '')

        with patch.object(downloads.subprocess, 'run', fake):
            status, _, data = self.raw('/api/workbench/downloads/pick', 'POST', {}, local=True)
        self.assertEqual(status, 400, data[:800])
        self.assertIn('异常退出', json.loads(data)['error'])
        self.assertEqual(self.settings()['download_dir'], '')


if __name__ == '__main__':
    unittest.main()
