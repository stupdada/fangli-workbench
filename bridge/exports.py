"""ZIP renderers consume an adopted-version projection, never mutate generation rows."""
import difflib
import io
import json
import re
import zipfile
from app import render
from .errors import Problem, Conflict
from .zip_evidence import article_metadata, redacted, SECRET_KEYS


def adopted_plan(service, ident, ids=None, *, delivery=False):
    conv = service.ws.conversation(ident)
    plan = service.store.get_plan(conv['plan_id']) if conv['plan_id'] else None
    if not plan: raise Problem('尚无稿件可导出')
    current = [service.ws.current(a['id']) for a in service.ws.visible_articles(conv['plan_id'])]
    if ids is not None:
        available = {a['id'] for a in current}
        if not ids or set(ids) - available: raise Problem('导出稿件不属于当前任务')
    selected = [a for a in current if ids is None or a['id'] in ids]
    if not selected: raise Problem('请先选择已完成的稿件')
    if any(a['locked'] or a['current_version'] is None for a in selected):
        raise Conflict('选中的稿件仍在处理，请待当前篇收尾后导出')
    # Keep the native export JSON fields exact for the ZIP default projection.
    plan['articles'] = [{k: v for k, v in a.items() if k not in ('current_version', 'version_label', 'origin', 'review', 'locked')} for a in current]
    if delivery or not service.store.get_settings().get('title_prefix', True):
        return render.strip_plan_prefix(plan)
    return render.ensure_plan_prefix(plan)


def plain_inline(text):
    def prose(value):
        value = re.sub(r'!?\[([^\]\n]*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)',
                       lambda m: f'{m[1]}（{m[2]}）' if m[1] and m[1] != m[2] else m[2], value)
        value = re.sub(r'(\*\*\*|\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1', r'\2', value)
        value = re.sub(r'(?<!\*)\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)|(?<!\w)_(?=\S)([^_]+?)(?<=\S)_(?!\w)',
                       lambda m: m[1] or m[2], value)
        return re.sub(r'\\([\\`*_{}\[\]()#+\-.!|>])', r'\1', value)

    # Inline code is already literal; only its enclosing backticks are formatting.
    output, end = [], 0
    for code in re.finditer(r'(`+)([^`\n]+?)\1(?!`)', text):
        output.extend((prose(text[end:code.start()]), code[2]))
        end = code.end()
    return ''.join([*output, prose(text[end:])])


def plain_body(markdown):
    lines = markdown.splitlines()
    output, fence, table = [], None, False
    table_rule = re.compile(r'^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$')
    for index, raw in enumerate(lines):
        line = raw.strip()
        if fence:
            if re.fullmatch(re.escape(fence[0]) + '{' + str(len(fence)) + ',}', line):
                fence = None
            else:
                output.append(raw)
            continue
        if opening := re.match(r'^(`{3,}|~{3,})', line):
            fence = opening[1]
            continue
        if table_rule.fullmatch(line):
            continue
        if '|' in line and (table or index + 1 < len(lines) and table_rule.fullmatch(lines[index + 1].strip())):
            table = True
            cells = re.split(r'(?<!\\)\|', line.removeprefix('|').removesuffix('|'))
            output.append('  ·  '.join(plain_inline(cell.strip()) for cell in cells))
            continue
        table = False
        if re.fullmatch(r'(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,}|=+', line):
            continue
        line = re.sub(r'^#{1,6}\s+(.*?)(?:\s+#+)?$', r'\1', line)
        line = re.sub(r'^(?:>\s*)+', '', line)
        line = re.sub(r'^[-*+]\s+', '• ', line)
        output.append(plain_inline(line))
    return '\n'.join(output).strip()


def delivery_text(plan, ids, fmt):
    articles = render.pick_articles(plan, ids)
    bodies = [(article.get('body_md') or '').strip() for article in articles]
    if fmt == 'md':
        return '\n\n---\n\n'.join(filter(None, bodies))
    return '\n\n\n'.join(filter(None, map(plain_body, bodies)))


def export(service, ident, fmt, ids=None, *, scope=None):
    if fmt not in ('docx', 'md', 'txt', 'json'): raise Problem('导出格式不正确')
    if scope is not None and fmt not in {'body': ('md', 'txt'), 'delivery': ('docx', 'md', 'txt')}.get(scope, ()):
        raise Problem('所选格式不支持此导出范围')
    with service.guard:
        plan = adopted_plan(service, ident, ids, delivery=scope == 'delivery')
        if fmt == 'docx':
            body = render.export_plan_docx(plan, ids)
            ctype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        else:
            if scope == 'delivery':
                result = delivery_text(plan, ids, fmt)
            else:
                function = (render.export_bodies_md if scope == 'body' else
                            {'md': render.export_plan_md, 'txt': render.export_plan_txt, 'json': render.export_plan_json}[fmt])
                result = function(plan, ids)
            body = result.encode('utf-8')
            ctype = {'md': 'text/markdown', 'txt': 'text/plain', 'json': 'application/json'}[fmt] + '; charset=utf-8'
        name = render.safe_name(plan['title'] or plan['keyword']) + '.' + fmt
    return body, ctype, name


def compare(service, ident, aid, vid):
    service.article_context(ident, aid)
    candidate = service.ws.version(aid, vid)
    if not candidate['parent_id']: raise Problem('此版本没有可比较的基稿')
    base = service.ws.version(aid, candidate['parent_id'])
    diff = '\n'.join(difflib.unified_diff(base['article']['body_md'].splitlines(), candidate['article']['body_md'].splitlines(),
        fromfile=f"base-{base['id']}", tofile=f"candidate-{candidate['id']}", lineterm=''))
    return {'base': base, 'candidate': candidate, 'diff': diff, 'review': candidate['review'],
            'review_records': [r for r in service.ws.review_records(aid) if r['candidate_version'] == vid]}


def compare_markdown(data):
    return '\n\n'.join(['# 稿件版本比较', '## 基稿', data['base']['article']['body_md'],
        '## 候选稿', data['candidate']['article']['body_md'], '## 差异', '```diff\n' + data['diff'] + '\n```',
        '## 修改与复核', '```json\n' + json.dumps({'metadata': data['candidate'].get('metadata', {}), 'review': data['review']}, ensure_ascii=False, indent=2) + '\n```',
        '## 真实审阅与用户评语', '```json\n' + json.dumps(data['review_records'], ensure_ascii=False, indent=2) + '\n```'])


def archive(service, ident):
    """A task-only local ZIP, built from explicit content records, never a data-directory dump."""
    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if str(k).lower() not in SECRET_KEYS | {'api_base', 'upload_url', 'upload_mode', 'trace', 'trace_path', 'path', 'private_path'}}
        if isinstance(value, list): return [clean(v) for v in value]
        return redacted(value)
    with service.guard:
        conv = service.require_stopped(ident)
        documents = {d['id']: d for d in service.ws.selected_documents(conv)}
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as zipped:
            def put(name, value):
                zipped.writestr(name, json.dumps(clean(value), ensure_ascii=False, indent=2).encode('utf-8'))
            put('manifest.json', {'format': 'fangli-local-archive-v1', 'conversation_id': ident,
                'contents': ['effective arrangement', 'parsed documents', 'native generation references', 'working versions', 'native audits', 'style comparisons', 'submitted review notes', 'current exports'],
                'export_policy': '当前采用且未删除版本；历史与逻辑删除记录单独留档'})
            put('task.json', {k: conv[k] for k in ('id', 'client_id', 'title', 'brief', 'document_ids', 'messages', 'mode', 'followup', 'draft_revision', 'created_at', 'updated_at', 'parent_conversation_id')})
            visible = service.ws.visible_articles(conv['plan_id']) if conv['plan_id'] else []
            all_articles = service.store.list_articles(conv['plan_id']) if conv['plan_id'] else []
            for article in all_articles:
                aid = article['id']
                current = service.ws.current(aid)
                if current['locked'] or current['current_version'] is None: raise Conflict('仍有稿件未收尾，暂不能归档')
                root = f'articles/{aid}/'
                put(root + 'native-reference.json', article)
                put(root + 'state.json', {'current_version': current['current_version'], 'deleted': service.ws.is_deleted_article(aid)})
                put(root + 'review-notes.json', service.ws.review_records(aid))
                for version in service.ws.versions(aid):
                    vid = version['id']
                    put(root + f'versions/{vid}.json', version)
                    put(root + f'provenance/{vid}.json', article_metadata(service.ws, aid, vid))
                    source = service.ws.version_source(aid, vid)
                    put(root + f'inputs/{vid}.json', source)
                    for doc in source.get('documents', []):
                        if isinstance(doc, dict) and doc.get('id'): documents[doc['id']] = doc
                    if version['parent_id']:
                        base = service.ws.version(aid, version['parent_id'])
                        data = {'base': base, 'candidate': version, 'diff': '\n'.join(difflib.unified_diff(base['article']['body_md'].splitlines(), version['article']['body_md'].splitlines(), fromfile=str(base['id']), tofile=str(vid), lineterm='')),
                                'review': version['review'], 'review_records': [r for r in service.ws.review_records(aid) if r['candidate_version'] == vid]}
                        zipped.writestr(root + f'comparisons/{vid}.md', compare_markdown(clean(data)).encode('utf-8'))
            put('documents.json', [{k: d.get(k) for k in ('id', 'filename', 'kind', 'digest', 'text')} for d in documents.values()])
            # Review results are content; request/response diagnostics and raw settings are excluded by construction.
            operations = service.ws.operations_for(ident)
            put('editorial-operations.json', [{k: o[k] for k in ('id', 'kind', 'article_id', 'status', 'result', 'created_at')} for o in operations if o['kind'] in ('style_review', 'style_rewrite', 'revision')])
            if visible:
                for fmt in ('docx', 'md', 'txt', 'json'):
                    body, _, _ = export(service, ident, fmt)
                    zipped.writestr('exports/current.' + fmt, body)
        name = render.safe_name(conv['title']) + '-本地归档.zip'
        return output.getvalue(), 'application/zip', name
