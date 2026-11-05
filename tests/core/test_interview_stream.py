"""Reply projection, transactional publication and event-driven HTTP delivery."""
import http.client
import json
import threading
import unittest
from unittest.mock import patch

import test_effective_inputs as effective
from bridge import interview, provider
from bridge.interview_stream import project_reply


class ReplyProjectionTest(unittest.TestCase):
    def test_all_cut_positions_escapes_surrogates_and_nested_decoy(self):
        reply = '可以，先聊聊你的方向。\n**重点**与"引号"、反斜线\\和😊。'
        raw = json.dumps({'other': {'understanding': '不展示嵌套字段'}, 'understanding': reply,
                          'options': {'note': '内部安排不出现在回复'}}, ensure_ascii=True)
        for end in range(len(raw) + 1):
            text, complete = project_reply(raw[:end])
            self.assertTrue(reply.startswith(text), (end, text))
            text.encode('utf-8')
            if complete: self.assertEqual(text, reply)
        self.assertEqual(project_reply(raw), (reply, True))
        self.assertEqual(project_reply('{"understanding":"可\\uD83D'), ('可', False))

    def test_reply_is_bounded_and_never_projects_options(self):
        self.assertEqual(project_reply('{"options":{"note":"秘密"}}'), ('', False))
        text, complete = project_reply(json.dumps({'understanding': '好' * 5000}))
        self.assertEqual(len(text), 4000); self.assertTrue(complete)


class InterviewStreamTest(unittest.TestCase):
    setUp = effective.EffectiveInputTest.setUp
    tearDown = effective.EffectiveInputTest.tearDown
    http = effective.EffectiveInputTest.http
    draft = effective.EffectiveInputTest.draft
    executable = effective.EffectiveInputTest.executable

    def stream(self, ident):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request('GET', '/api/workbench/operations/' + ident + '/stream')
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn('text/event-stream', response.getheader('Content-Type'))
        return connection, response

    def next_state(self, response):
        for _ in range(15):
            line = response.readline()
            if line.startswith(b'data: '): return json.loads(line[6:])['operation']
            if not line: self.fail('缺少操作终态')
        self.fail('状态事件超过范围')

    def terminal(self, ident):
        connection, response = self.stream(ident)
        try:
            for _ in range(12):
                state = self.next_state(response)
                if state['status'] != 'running': return state
            self.fail('未收到终态')
        finally: connection.close()

    def gated_events(self, *, invalid=False):
        entered, release, calls = threading.Event(), threading.Event(), []
        reply = '可以，我们先聊聊你想写的方向。'
        def events(payload):
            calls.append(payload)
            yield {'type': 'delta', 'text': '{"understanding":"' + reply}
            entered.set()
            if not release.wait(5): raise AssertionError('未释放回复夹具')
            tail = '","options":' + json.dumps({} if invalid else {'note': '新的完整写作说明'}, ensure_ascii=False) + ',"questions":[],"ready":true}'
            yield {'type': 'delta', 'text': tail}
            yield {'type': 'done', 'finish_reason': 'stop'}
        return events, entered, release, calls, reply

    def test_incremental_reply_precedes_commit_and_replays_terminal(self):
        before = self.executable({'note': '原来的完整说明'})['brief']
        events, entered, release, calls, reply = self.gated_events()
        with patch.object(provider, 'events', events):
            ident = self.http(self.path + '/chat', 'POST', {'text': '换个写作方向'})['operation_id']
            try:
                self.assertTrue(entered.wait(3))
                current = self.http(self.path)['conversation']
                self.assertEqual(current['brief'], before)
                self.assertEqual(current['messages'][-1]['role'], 'user')
                connection, response = self.stream(ident)
                try:
                    first = self.next_state(response)
                    self.assertEqual(first['status'], 'running')
                    self.assertEqual(first['result']['understanding'], reply)
                    self.assertNotIn('options', first['result'])
                    release.set()
                    for _ in range(10):
                        final = self.next_state(response)
                        if final['status'] != 'running': break
                    self.assertEqual(final['status'], 'done')
                finally: connection.close()
                self.assertEqual(self.terminal(ident)['status'], 'done')
                current = self.http(self.path)['conversation']
                self.assertEqual(current['brief']['note'], '新的完整写作说明')
                self.assertEqual(current['messages'][-1]['content']['understanding'], reply)
                self.assertEqual(current['messages'][-1]['content']['operation_id'], ident)
                self.assertEqual(len(calls), 1)
            finally: release.set()

    def test_invalid_arrangement_keeps_reply_and_original_brief(self):
        before = self.executable({'note': '保留原条件'})['brief']
        events, entered, release, calls, reply = self.gated_events(invalid=True)
        with patch.object(provider, 'events', events):
            ident = self.http(self.path + '/chat', 'POST', {'text': '写一个新方向'})['operation_id']
            try:
                self.assertTrue(entered.wait(3)); release.set()
                final = self.terminal(ident)
                self.assertEqual(final['status'], 'error')
                self.assertEqual(final['result']['error_status'], 400)
                self.assertEqual(final['result']['understanding'], reply)
                self.assertTrue(final['result']['partial'])
                self.assertEqual(self.http(self.path)['conversation']['brief'], before)
                self.assertEqual(len(calls), 1)
            finally: release.set()

    def test_stop_before_validation_keeps_partial_reply_and_brief(self):
        before = self.executable({'note': '保持原方向'})['brief']
        events, entered, release, calls, reply = self.gated_events()
        with patch.object(provider, 'events', events):
            ident = self.http(self.path + '/chat', 'POST', {'text': '我们讨论一下'})['operation_id']
            try:
                self.assertTrue(entered.wait(3))
                self.http('/api/workbench/operations/' + ident + '/stop', 'POST', {})
                release.set(); final = self.terminal(ident)
                self.assertEqual(final['status'], 'stopped')
                self.assertEqual(final['result']['understanding'], reply)
                self.assertEqual(self.http(self.path)['conversation']['brief'], before)
                self.assertEqual(len(calls), 1)
            finally: release.set()

    def test_cancel_after_atomic_commit_reports_completed_result(self):
        self.executable({'note': '旧说明'})
        original = interview.conduct
        def events(payload):
            yield {'type':'delta', 'text':json.dumps({'understanding':'可以，我们就按这个方向来。', 'options':{'note':'已提交的完整说明'}, 'questions':[], 'ready':True}, ensure_ascii=False)}
            yield {'type':'done', 'finish_reason':'stop'}
        def conduct(service, conv, op, settings):
            value = original(service, conv, op, settings)
            service.cancellations[op].set()
            return value
        with patch.object(provider, 'events', events), patch.object(interview, 'conduct', conduct):
            ident = self.http(self.path + '/chat', 'POST', {'text':'开始这个方向'})['operation_id']
            final = self.terminal(ident)
            self.assertEqual(final['status'], 'done')
            self.assertEqual(self.http(self.path)['conversation']['brief']['note'], '已提交的完整说明')
