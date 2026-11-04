"""One owned video CLI, a private lifecycle pipe, and bounded process-tree cleanup."""
import ctypes
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from .errors import Conflict, Problem

ROOT = Path(__file__).resolve().parent.parent


class OwnedJob:
    """On Windows the handle dies with this parent, killing only our child tree."""
    def __init__(self):
        self.handle = None
        self.lock = threading.Lock()
        if os.name != 'nt': return
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_longlong), ('PerJobUserTimeLimit', ctypes.c_longlong),
                        ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                        'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]
        class Extended(ctypes.Structure):
            _fields_ = [('BasicLimitInformation', Basic), ('IoInfo', IO), ('ProcessMemoryLimit', ctypes.c_size_t),
                        ('JobMemoryLimit', ctypes.c_size_t), ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.kernel.QueryInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p)
        self.kernel.QueryInformationJobObject.restype = wintypes.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle: raise OSError(ctypes.get_last_error(), 'CreateJobObject failed')
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close(); raise OSError(ctypes.get_last_error(), 'SetInformationJobObject failed')

    def assign(self, proc):
        if self.handle and not self.kernel.AssignProcessToJobObject(self.handle, int(proc._handle)):
            raise OSError(ctypes.get_last_error(), 'AssignProcessToJobObject failed')

    def close(self):
        with self.lock:
            if self.handle:
                self.kernel.CloseHandle(self.handle)
                self.handle = None

    def pids(self):
        if os.name != 'nt': return []
        class Pids(ctypes.Structure):
            _fields_ = [('assigned', ctypes.c_uint32), ('count', ctypes.c_uint32), ('pids', ctypes.c_size_t * 128)]
        result = Pids()
        with self.lock:
            if not self.handle or not self.kernel.QueryInformationJobObject(self.handle, 3, ctypes.byref(result), ctypes.sizeof(result), None): return []
        return list(result.pids[:result.count])


class VideoProcess:
    def __init__(self, workspace_url, data_dir, log_dir, node=None, entry=None):
        self.workspace_url = workspace_url
        self.data_dir = Path(data_dir).resolve()
        self.log_dir = Path(log_dir).resolve()
        self.node = node or os.environ.get('GEO_NODE', 'node')
        self.entry = Path(entry or ROOT / 'video/server.cjs').resolve()
        self.lifecycle, self.state_lock = threading.RLock(), threading.Lock()
        self.proc = self.job = self.reader = None
        self.status, self.port, self.error, self.start_count = 'stopped', None, '', 0
        self.stopping = False

    def snapshot(self):
        with self.state_lock:
            return {'status': self.status, 'pid': self.proc.pid if self.proc else None, 'port': self.port,
                    'start_count': self.start_count, 'error': self.error, 'owned_pids': self.job.pids() if self.job else []}

    def _record(self, event, **values):
        self.log_dir.mkdir(parents=True, exist_ok=True)
        with (self.log_dir / 'video-lifecycle.jsonl').open('a', encoding='utf-8') as file:
            file.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'event': event, **values}, ensure_ascii=False) + '\n')

    def endpoint(self):
        with self.state_lock:
            if self.status != 'ready' or not self.proc or self.proc.poll() is not None:
                return None
            return '127.0.0.1', self.port

    def start(self):
        with self.lifecycle:
            if self.proc and self.proc.poll() is None: raise Conflict('视频子服务已在运行')
            node = shutil.which(self.node)
            if not node: raise Problem('缺少Node.js，无法启动视频子服务')
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.log_dir.mkdir(parents=True, exist_ok=True)
            command = [node, '--require', str(ROOT / 'bridge/video_bootstrap.cjs'), str(self.entry),
                       '--port', '0', '--workspace-base', self.workspace_url, '--data-dir', str(self.data_dir)]
            ready_queue = queue.Queue()
            stderr = (self.log_dir / 'video.stderr.log').open('ab', buffering=0)
            proc = None
            job = OwnedJob()
            try:
                proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                    cwd=ROOT, env={**os.environ, 'FANGLI_PYTHON': sys.executable, 'PYTHONUTF8': '1',
                                   'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'},
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), start_new_session=os.name != 'nt')
                # The preload blocks on boot, so no descendant exists before job assignment.
                job.assign(proc)
                with self.state_lock:
                    self.proc, self.job = proc, job
                    self.status, self.port, self.error, self.stopping = 'starting', None, '', False
                    self.start_count += 1
                self._record('starting', pid=proc.pid, command=command, data_dir=str(self.data_dir))
                def read_stdout():
                    count = 0
                    try:
                        with (self.log_dir / 'video.stdout.log').open('ab', buffering=0) as log:
                            for line in proc.stdout:
                                log.write(line)
                                if not line.strip(): continue
                                count += 1
                                try: value = json.loads(line.decode('utf-8'))
                                except (ValueError, UnicodeError): value = {}
                                if count == 1: ready_queue.put(value)
                                else:
                                    with self.state_lock:
                                        if self.proc is proc: self.status, self.error = 'error', '视频子服务违反就绪协议'
                                    self._record('stdout-protocol-error', pid=proc.pid)
                    finally:
                        code = proc.wait()
                        job.close()
                        with self.state_lock:
                            if self.proc is proc:
                                self.status = 'stopped' if self.stopping else 'error'
                                if not self.stopping: self.error = '视频子服务已退出，请明确重启'
                                self.port = None
                        ready_queue.put(None)
                        self._record('exited', pid=proc.pid, returncode=code)
                self.reader = threading.Thread(target=read_stdout, name='video-owned-stdout', daemon=True)
                self.reader.start()
                proc.stdin.write(b'{"type":"boot"}\n'); proc.stdin.flush()
                ready = ready_queue.get(timeout=25)
                if not isinstance(ready, dict) or ready.get('type') != 'ready' or ready.get('pid') != proc.pid or type(ready.get('port')) is not int or not 1 <= ready['port'] <= 65535:
                    raise Problem('视频子服务未正确就绪，请查看私有视频日志')
                with self.state_lock:
                    if proc.poll() is not None: raise Problem('视频子服务在就绪后退出')
                    self.port, self.status = ready['port'], 'ready'
                self._record('ready', pid=proc.pid, port=ready['port'])
                return self.snapshot()
            except (OSError, queue.Empty, Problem):
                if proc:
                    self._stop_owned(proc, job)
                else: job.close()
                with self.state_lock:
                    self.status, self.port, self.error = 'error', None, '视频子服务启动失败，请查看私有视频日志'
                self._record('start-failed', pid=proc.pid if proc else None)
                raise Problem(self.error) from None
            finally:
                stderr.close()

    def _stop_owned(self, proc, job):
        with self.state_lock:
            if self.proc is proc: self.stopping = True
        if proc.poll() is None:
            try: proc.stdin.write(b'{"type":"shutdown"}\n'); proc.stdin.flush()
            except (OSError, ValueError): pass
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self._record('forced-stop', pid=proc.pid)
                if os.name == 'nt': job.close()
                else:
                    try: os.killpg(proc.pid, signal.SIGTERM)
                    except ProcessLookupError: pass
                try: proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.wait(timeout=3)
        job.close()
        if self.reader and self.reader is not threading.current_thread(): self.reader.join(timeout=3)
        if proc.stdin and not proc.stdin.closed: proc.stdin.close()
        if proc.stdout and not proc.stdout.closed: proc.stdout.close()

    def stop(self):
        with self.lifecycle:
            proc, job = self.proc, self.job
            if proc and job: self._stop_owned(proc, job)
            with self.state_lock:
                self.status, self.port = 'stopped', None
            return self.snapshot()

    def restart(self):
        with self.lifecycle:
            self.stop()
            return self.start()
