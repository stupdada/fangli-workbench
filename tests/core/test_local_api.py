import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen

from app import llm
from bridge import provider
from bridge.errors import Problem
from bridge.http import create_server


def serve(test, server):
    worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
    worker.start()
    test.addCleanup(worker.join, 2)
    test.addCleanup(server.server_close)
    test.addCleanup(server.shutdown)


class LocalApiTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        requests = self.requests

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, self.headers['Authorization'], body))
                model = body['model']
                if model == 'denied':
                    self.send_response(403)
                    self.end_headers()
                    self.wfile.write(b'fixture-credential')
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.end_headers()
                finish = 'length' if model == 'truncated' else 'stop'
                for item in ({'choices': [{'delta': {'content': '本机测试'}}]},
                             {'choices': [{'finish_reason': finish}], 'usage': {'total_tokens': 7}}):
                    data = json.dumps(item, ensure_ascii=False)
                    self.wfile.write(f'data: {data}\r\n\r\n'.encode('utf-8'))
                if model != 'interrupted':
                    self.wfile.write(b'data: [DONE]\r\n\r\n')

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        serve(self, upstream)
        config = patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fixture-credential',
            'DEEPSEEK_BASE_URL': f'http://127.0.0.1:{upstream.server_port}/v1',
            'DEEPSEEK_MODEL': 'fixture-model', 'DASHSCOPE_API_KEY': '', 'GEO_LLM_API_KEY': ''})
        config.start()
        self.addCleanup(config.stop)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.server = create_server(Path(temp.name) / 'workbench.db', port=0)
        serve(self, self.server)
        self.addCleanup(provider.local.__dict__.clear)

    def call(self, path, payload=None):
        body = json.dumps(payload).encode('utf-8') if payload is not None else None
        req = Request(f'http://127.0.0.1:{self.server.server_port}/api/workbench/{path}', body,
                      {'Content-Type': 'application/json'})
        with urlopen(req, timeout=5) as response:
            return json.load(response)

    def test_discovery_save_and_frozen_transport(self):
        boot = self.call('bootstrap')
        self.assertEqual(boot['settings']['transport'], 'workbuddy')
        self.assertEqual([source['id'] for source in boot['local_api_sources'] if source['configured']], ['deepseek'])
        self.assertNotIn('fixture-credential', json.dumps(boot))
        self.assertNotIn('base_url', json.dumps(boot))
        with self.assertRaises(Problem):
            self.server.service.save_settings({'transport': 'dashscope', 'model': 'qwen-plus'})
        frozen = self.call('settings', {'transport': 'deepseek', 'model': 'fixture-model'})['settings']
        self.assertEqual(self.call('bootstrap')['settings'], frozen)
        self.call('settings', {'transport': 'workbuddy', 'model': provider.DEFAULT_MODEL})
        self.assertEqual(self.requests, [])
        self.server.service.ensure_model(frozen)
        provider.local.usage = []
        traces = []
        provider.local.trace = lambda _, data: traces.append(data)
        self.assertEqual(llm.chat([{'role': 'user', 'content': '中文'}], frozen, force_json=True), '本机测试')
        self.assertEqual(provider.local.usage, [{'total_tokens': 7}])
        path, auth, body = self.requests[0]
        self.assertEqual((path, auth), ('/v1/chat/completions', 'Bearer fixture-credential'))
        self.assertEqual(body['model'], 'fixture-model')
        self.assertEqual(body['thinking'], {'type': 'disabled'})
        self.assertEqual(body['response_format'], {'type': 'json_object'})
        self.assertNotIn('fixture-credential', json.dumps(traces))

    def test_failed_streams_are_not_complete(self):
        for model, kind in [('truncated', 'truncated'), ('interrupted', 'uncertain'), ('denied', 'auth')]:
            with self.subTest(model=model), self.assertRaises(llm.LLMError) as raised:
                llm.chat([], {'transport': 'deepseek', 'model': model})
            self.assertEqual(raised.exception.kind, kind)
            self.assertNotIn('fixture-credential', str(raised.exception))
        self.assertEqual(len(self.requests), 3)
