import json
import http.client
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import queue
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from app import llm
from bridge import provider
from bridge.service import Service
from bridge.native import LocalStore
from bridge.errors import Problem

EVIDENCE = {}


class TransportTest(unittest.TestCase):
    def tearDown(self): provider.local.__dict__.clear()

    def test_python_process_protocol_and_stop(self):
        with tempfile.TemporaryDirectory(prefix='fangli-transport-') as temp:
            script = Path(temp) / 'protocol.cjs'
            script.write_text('''let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{
              const p=JSON.parse(raw); const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
              if(p.operation==='models')return emit({type:'models',models:[{id:'deepseek-v4.1-flash'}]});
              if(p.model==='hold')return setTimeout(()=>{},5000);
              if(p.model==='secret')return emit({type:'error',kind:'auth',message:'wbpk_secret_should_never_be_used',status:401});
              emit({type:'delta',text:p.messages[0].content});
              emit({type:'done',finish_reason:p.model==='length'?'length':'stop'});
            });''', encoding='utf-8')
            original = subprocess.Popen
            pids = []
            def launch(args, **kwargs):
                proc = original([args[0], str(script)], **kwargs)
                pids.append(proc)
                return proc
            with patch.object(provider.subprocess, 'Popen', launch):
                self.assertEqual(provider.chat([{'role': 'user', 'content': '中文进程边界'}], {'model': 'ok'}), '中文进程边界')
                with self.assertRaises(llm.LLMError) as length: provider.chat([{'role': 'user', 'content': '截断'}], {'model': 'length'})
                self.assertEqual(length.exception.kind, 'truncated')
                with self.assertRaises(llm.LLMError) as secret: provider.chat([{'role': 'user', 'content': 'x'}], {'model': 'secret'})
                self.assertNotIn('wbpk_', str(secret.exception))
                self.assertEqual(provider.models()[0]['id'], provider.DEFAULT_MODEL)
                cancel = threading.Event(); provider.local.cancel = cancel
                timer = threading.Timer(.1, cancel.set); timer.start()
                try:
                    with self.assertRaises(llm.LLMError) as stopped: provider.chat([{'role': 'user', 'content': 'x'}], {'model': 'hold'})
                    self.assertEqual(stopped.exception.kind, 'cancelled')
                finally: timer.cancel()
            self.assertTrue(all(p.poll() is not None for p in pids))
            self.assertTrue(all(p.stdout.closed and p.stdin.closed for p in pids))
        EVIDENCE['process_boundary'] = {'utf8': True, 'truncated_rejected': True, 'stop_terminates_local_child': True,
            'children_reaped': len(pids), 'secrets_not_in_error': True}

    def test_exact_model_catalog_and_native_parameters(self):
        with tempfile.TemporaryDirectory(prefix='fangli-catalog-') as temp:
            store = LocalStore(Path(temp) / 'db.sqlite')
            service = Service(store)
            calls = []
            def events(payload):
                calls.append(payload)
                if payload.get('operation') == 'models':
                    yield {'type': 'models', 'models': [{'id': 'deepseek-v4.1-flash-approximate'}]}
                else:
                    yield {'type': 'delta', 'text': '{}'}
                    yield {'type': 'done', 'finish_reason': 'stop'}
            with patch.object(provider, 'events', events):
                with self.assertRaises(Problem): service.ensure_model()
                with self.assertRaises(Problem): service.ensure_model()
                self.assertEqual(len(calls), 1)
                self.assertEqual(store.get_settings()['model'], provider.DEFAULT_MODEL)
                payloads = []
                provider.local.trace = lambda kind, value: payloads.append(value) if kind == 'request' else None
                provider.chat([{'role': 'system', 'content': '原文'}], {'model': 'qwen3-test', 'temperature': .8,
                    'max_tokens': 4000, 'disable_thinking': True}, temperature=0, max_tokens=1777, force_json=True)
                self.assertEqual(payloads[0]['temperature'], 0)
                self.assertEqual(payloads[0]['max_tokens'], 1777)
                self.assertTrue(payloads[0]['force_json'])
                self.assertFalse(payloads[0]['enable_thinking'])
            service.close()
        EVIDENCE['model_catalog'] = {'exact_id_required': True, 'cached': True, 'no_silent_switch': True, 'parameter_overrides_preserved': True}

    def test_cli_start_ready_http_and_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='fangli-cli-') as temp:
            command = [sys.executable, str(ROOT / 'main.py'), '--no-browser', '--port', '0', '--data-dir', temp]
            proc = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                encoding='utf-8', env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'})
            inbox = queue.Queue()
            reader = threading.Thread(target=lambda: inbox.put(proc.stdout.readline()), daemon=True); reader.start()
            try:
                ready = json.loads(inbox.get(timeout=5))
                self.assertEqual(ready['type'], 'ready')
                self.assertEqual(ready['pid'], proc.pid)
                conn = http.client.HTTPConnection('127.0.0.1', ready['port'], timeout=3)
                conn.request('GET', '/api/workbench/bootstrap')
                response = conn.getresponse(); data = json.loads(response.read()); conn.close()
                self.assertEqual(response.status, 200)
                self.assertEqual(data['clients'], [])
                self.assertEqual(data['provider_models'], [])
                EVIDENCE['cli_start'] = {'command': 'python main.py --no-browser --port 0 --data-dir <temporary>',
                    'pid_recorded': proc.pid, 'ready_json_and_http': True, 'new_workspace_empty': True, 'model_calls': 0}
            finally:
                proc.terminate(); proc.wait(5); reader.join(1)
                proc.stdout.close(); proc.stderr.close()


if __name__ == '__main__': unittest.main(verbosity=2)
