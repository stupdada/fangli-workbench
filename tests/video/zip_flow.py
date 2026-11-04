"""Run the byte-identical ZIP prompt/render/audit code without its HTTP transport."""
import json
from pathlib import Path
import re
import sys

BASE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BASE / 'video/comparison'))
from zip_native import generator, llm, prompts, seeds

OUT = BASE.parent / 'output/geo-merge-20261104/video'
COMMON = json.loads((OUT / 'common-inputs.json').read_text(encoding='utf-8'))


def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def config(case):
    platform = dict(seeds.PLATFORMS[0], id=1)
    risks = [dict(zip(('category', 'item', 'level', 'tip'), row), platform_id=None)
             for row in seeds.COMMON_RISKS]
    risks += [dict(zip(('category', 'item', 'level', 'tip'), row), platform_id=1)
              for row in seeds.PLATFORM_RISKS['抖音']]
    brief = {'brand': case['name'], 'company': case['company'], 'industry': case['industry'],
             'products': case['products'], 'keyword': case['keyword'], 'keywords': [case['keyword']],
             'note': case['topic'] + '\n' + COMMON['requirement']}
    materials = [{'filename': d['name'], 'kind': d['role'], 'text': d['content']} for d in case['documents']]
    return platform, risks, brief, materials


class Store:
    def __init__(self, platform, risks, brief, materials, article=None):
        self.platform, self.risks, self.brief, self.materials = platform, risks, brief, materials
        self.article = article

    def list_risks(self): return self.risks
    def get_article(self, ident): return self.article
    def get_plan(self, ident): return {'brief': self.brief}
    def list_materials(self, ident): return self.materials
    def update_article(self, ident, **changes): self.article.update(changes)
    def list_platforms(self): return [self.platform]


def partition(body):
    # Preserve every nonblank rendered line; do not pass storyboard or declarations as narration.
    rows, section = [], ''
    for raw in body.splitlines():
        line = raw.strip()
        if not line: continue
        if line.startswith('# '): kind = 'title'
        elif line.startswith('## '):
            section = line[3:]
            kind = 'timeline_or_heading'
        elif line.startswith('声明：'): kind = 'publication_declaration'
        elif line.startswith('#'): kind = 'publication_tags'
        elif line.startswith('- ') and section != '关键数据': kind = 'visual_instruction'
        else: kind = 'display_text'
        text = re.sub(r'^-\s+', '', line).replace('**', '') if kind == 'display_text' else line
        rows.append({'kind': kind, 'raw': raw, 'text': text})
    display = '\n'.join(r['text'] for r in rows if r['kind'] == 'display_text')
    return {'rows': rows, 'displayBody': display, 'displayCharacters': len(re.sub(r'\s', '', display)),
            'allNonblankLinesClassified': len(rows) == sum(bool(x.strip()) for x in body.splitlines()),
            'policy': 'summary + all section narration + rendered key_facts; timeline, visual instructions, title, tags and publication declarations separately retained'}


def main():
    action = sys.argv[1]
    for case in COMMON['cases']:
        if len(sys.argv) > 2 and sys.argv[2] != case['id']: continue
        platform, risks, brief, materials = config(case)
        store = Store(platform, risks, brief, materials)
        directory = OUT / 'comparison' / case['id'] / 'zip'
        directory.mkdir(parents=True, exist_ok=True)
        selected = prompts.build_materials_text(materials, focus=[case['keyword']])
        if action == 'prepare':
            messages = generator.build_messages(store, brief, platform, seeds.ANGLES[0],
                prompts.SUB_ANGLES[0], '短视频', 'mid', [], 1, 1, keyword=case['keyword'],
                materials_text=selected, account_type='official')
            write(directory / 'request.json', {'model': COMMON['model'], 'messages': messages,
                'temperature': .8, 'max_tokens': 4000, 'response_format': {'type': 'json_object'}, 'stream': True})
            write(directory / 'selection.json', {'materials_text': selected, 'platform': platform,
                'brief': brief, 'risk_items': risks, 'layout': prompts.layout_for(platform, '短视频')})
        elif action == 'finalize':
            response = (directory / 'raw-generation.txt').read_text(encoding='utf-8')
            data = llm.parse_json(response)
            if not isinstance(data, dict) or not data.get('title'): raise ValueError('ZIP native JSON parse failed')
            result = generator._finalize(data, brief, platform, seeds.ANGLES[0], '短视频',
                {'model': COMMON['model'], 'title_prefix': True}, case['keyword'], account_type='official')
            result.update(id=1, plan_id=1)
            write(directory / 'model-draft.json', result)
            (directory / 'model-draft.md').write_text(result['body_md'], encoding='utf-8')
            write(directory / 'draft-display.json', partition(result['body_md']))
            audit_materials = prompts.build_materials_text(materials, budget=20000, per_file=8000)
            write(directory / 'audit-request.json', {'model': COMMON['model'],
                'messages': prompts.build_audit(result['body_md'], audit_materials, brief['note']),
                'temperature': .8, 'max_tokens': 8000, 'response_format': {'type': 'json_object'}, 'stream': True})
        elif action == 'audit':
            store.article = json.loads((directory / 'model-draft.json').read_text(encoding='utf-8'))
            raw = (directory / 'raw-audit.txt').read_text(encoding='utf-8')
            llm.chat_with_retry = lambda *args, **kwargs: raw
            result = generator.audit_article(store, {'model': COMMON['model']}, 1, brief)
            write(directory / 'native-audit.json', result)
            write(directory / 'audited-article.json', store.article)
            (directory / 'audited-article.md').write_text(store.article['body_md'], encoding='utf-8')
            write(directory / 'audited-display.json', partition(store.article['body_md']))
    print(json.dumps({'action': action, 'ok': True}))


if __name__ == '__main__':
    main()
