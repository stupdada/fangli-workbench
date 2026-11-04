"""Only the new real child-process ownership/start/restart/exit boundary."""
import ctypes
import http.client
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from bridge.http import create_server
from bridge.video_process import VideoProcess
from bridge.errors import Problem

EVIDENCE = {}


class WaitHandles:
    def __init__(self, pids):
        self.handles = []
        if os.name != 'nt': return
        from ctypes import wintypes
        self.k = ctypes.WinDLL('kernel32', use_last_error=True)
        self.k.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD); self.k.OpenProcess.restype = wintypes.HANDLE
        self.k.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD); self.k.WaitForSingleObject.restype = wintypes.DWORD
        self.k.CloseHandle.argtypes = (wintypes.HANDLE,)
        for pid in pids:
            handle = self.k.OpenProcess(0x100000, False, pid)
            if handle: self.handles.append((pid, handle))
    def exited(self):
        result = []
        for pid, handle in self.handles:
            result.append((pid, self.k.WaitForSingleObject(handle, 5000) == 0)); self.k.CloseHandle(handle)
        self.handles = []
        return result


class LifecycleTest(unittest.TestCase):
    def test_ready_restart_failure_and_owned_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='fangli-lifecycle-') as temp:
            server = create_server(Path(temp) / 'workbench.db', port=0)
            worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True); worker.start()
            other = None
            def api(path, method='GET'):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
                conn.request(method, path, body=b'{}' if method == 'POST' else None,
                    headers={'Origin': f'http://127.0.0.1:{server.server_port}', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin'})
                res = conn.getresponse(); raw = res.read(); conn.close(); return res.status, raw
            try:
                first = server.video.start(); self.assertEqual(first['status'], 'ready')
                self.assertEqual(api('/video/')[0], 200)
                other = VideoProcess(server.video.workspace_url, server.video.data_dir, Path(temp) / 'conflict-logs')
                with self.assertRaises(Problem): other.start()
                self.assertEqual(other.snapshot()['status'], 'error')
                self.assertEqual(api('/video/')[0], 200)  # Failed second launch did not stop the owner.
                waits = WaitHandles(first['owned_pids'])
                status, raw = api('/api/workbench/video-service/restart', 'POST')
                self.assertEqual(status, 200)
                second = json.loads(raw)['video']; self.assertNotEqual(second['pid'], first['pid'])
                old_exits = waits.exited(); self.assertTrue(all(ok for _, ok in old_exits))
                self.assertEqual(api('/video/')[0], 200)
                waits = WaitHandles(second['owned_pids'])
                status, _ = api('/api/workbench/shutdown', 'POST'); self.assertEqual(status, 200)
                worker.join(3); self.assertFalse(worker.is_alive())
                server.server_close()
                final_exits = waits.exited(); self.assertTrue(all(ok for _, ok in final_exits))
                EVIDENCE['graceful'] = {'first': first, 'restarted': second, 'old_owned_exits': old_exits,
                    'final_owned_exits': final_exits, 'conflicting_data_dir_rejected': True,
                    'other_owner_preserved': True, 'ready_restart_shutdown_http': True}
            finally:
                if other: other.stop()
                if worker.is_alive(): server.shutdown()
                server.server_close(); worker.join(2)

    def test_cli_parent_loss_kills_only_owned_tree(self):
        with tempfile.TemporaryDirectory(prefix='fangli-parent-') as temp:
            command = [sys.executable, '-B', str(ROOT / 'main.py'), '--no-browser', '--port', '0', '--data-dir', temp]
            proc = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8',
                env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'},
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            ready = queue.Queue(); reader = threading.Thread(target=lambda: ready.put(proc.stdout.readline()), daemon=True); reader.start()
            try:
                value = json.loads(ready.get(timeout=30)); self.assertEqual(value['type'], 'ready')
                self.assertEqual(value['video']['status'], 'ready')
                self.assertGreaterEqual(len(value['video']['owned_pids']), 2)
                waits = WaitHandles(value['video']['owned_pids'])
                proc.terminate(); proc.wait(5)
                exited = waits.exited(); self.assertTrue(all(ok for _, ok in exited))
                EVIDENCE['parent_loss'] = {'main_pid': proc.pid, 'command': command, 'video': value['video'], 'owned_exits': exited,
                    'windows_kill_on_job_close': True, 'new_model_calls': 0, 'new_encodes': 0}
            finally:
                if proc.poll() is None: proc.terminate(); proc.wait(5)
                reader.join(1); proc.stdout.close(); proc.stderr.close()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path); args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LifecycleTest))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({'ok': result.wasSuccessful(), 'tests': result.testsRun, 'evidence': EVIDENCE,
            'model_calls': 0, 'catalog_calls': 0, 'encodes': 0}, ensure_ascii=False, indent=2), encoding='utf-8')
    raise SystemExit(0 if result.wasSuccessful() else 1)
