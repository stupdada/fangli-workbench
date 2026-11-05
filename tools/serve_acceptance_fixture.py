"""Explicit isolated UI acceptance server: real HTTP/SQLite, deterministic test model."""
import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests/core'))
from test_workbench import ControlledModel
from bridge import provider
from bridge.http import create_server


class FixtureModel(ControlledModel):
    review_delay = 0
    stream_delay = 0

    def events(self, payload):
        messages = payload.get('messages') or []
        if messages and '本次只执行完整通读、逐段扫描' in messages[0]['content']:
            time.sleep(self.review_delay)
        for event in super().events(payload):
            if self.stream_delay and event.get('type') == 'delta':
                time.sleep(self.stream_delay)
            yield event

    def response(self, payload):
        kind, result = super().response(payload)
        if kind == 'interview':
            request = json.loads(payload['messages'][1]['content'])
            original = request['options'].get('note', '')
            latest = next((m['content'] for m in reversed(request.get('messages', [])) if m['role'] == 'user'), '')
            result['options']['note'] = '\n'.join(value for value in (original, latest) if value)
            result['questions'] = []
            result['understanding'] = '可以，我们先围绕资料中的产品用途和工序条件来写。\n\n我会沿用你已选的平台和账号，分别组织内容。你也可以继续补充想强调的产品特点，或者直接告诉我新的话题。\n\n这些有效要求会整理到本次安排里，方便你随时查看和调整。'
        if kind == 'generate' and self.stream_delay:
            result['sections'].append({'heading': '使用前核对资料', 'paragraphs': [
                '先确认实际使用场景，再逐项核对资料中的适用条件。**保留工序限制**，便于读者判断内容的适用范围。'
                for _ in range(8)] + ['| 核对项 | 依据 |\n| --- | --- |\n| 使用条件 | 客户资料 |\n| 工序安排 | 有效说明 |']})
        if kind == 'style_review':
            result['suggestions'].append({'id': '3', 'tier': 2, 'signal': '具体经历',
                'quote': '核查后判断', 'problem': '增加常客经历需要补充资料',
                'proposal': '补充常客到店时间和选择产品的具体经历。', 'scope': '段',
                'requires_material': True})
        return kind, result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--review-delay', type=float, default=0)
    parser.add_argument('--stream-delay', type=float, default=0)
    args = parser.parse_args()
    model = FixtureModel()
    if not 0 <= args.review_delay <= 10:
        parser.error('review-delay需为0至10秒')
    model.review_delay = args.review_delay
    if not 0 <= args.stream_delay <= 1:
        parser.error('stream-delay需为0至1秒')
    model.stream_delay = args.stream_delay
    provider.events = model.events
    server = create_server(args.data_dir / 'workbench.db', args.port)
    service = server.service
    service.catalog = [{'id': provider.DEFAULT_MODEL}]
    if not service.ws.clients():
        for name in ('仅验收·工业材料', '仅验收·门店内容'):
            customer = service.ws.save_client(name, {'brand': '西邦', 'company': '合成客户公司', 'products': '西邦24', 'website': 'fixture.example'})
            document = service.ws.files.import_document(customer['id'], {
                'filename': '合成客户资料.txt',
                'content_b64': base64.b64encode('本资料仅供软件验收。西邦24用于橡胶与金属粘接，具体操作以提供的有效资料为准。'.encode('utf-8')).decode()})['document']
            platform = service.store.list_platforms()[0]
            service.customers.save_plan(customer['id'], {'options': {
                'keywords': ['西邦24', '工序说明'],
                'selections': [{'platform_id': platform['id'], 'account_type': 'official', 'count': 1}],
                'note': '使用合成资料进行界面验收。'}, 'document_ids': [document['id']]})
    print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}', 'pid': os.getpid(),
                      'data_dir': str(args.data_dir.resolve()), 'model': 'deterministic acceptance fixture',
                      'stop': 'POST /api/workbench/shutdown {}'}, ensure_ascii=False), flush=True)
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
