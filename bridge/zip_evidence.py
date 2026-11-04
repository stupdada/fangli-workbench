"""Optional ZIP provenance. Raw model text only, never a trace/request/diagnostic object."""
import copy
import json
import re
from pathlib import Path
from app import generator, llm, prompts
from .storage import Workspace

SECRET_KEYS = {'api_key', 'apikey', 'publishablekey', 'publishable_key', 'authorization', 'access_token', 'refresh_token', 'upload_token'}


def redacted(value):
    if isinstance(value, dict):
        return {k: '[redacted]' if str(k).lower() in SECRET_KEYS else redacted(v) for k, v in value.items()}
    if isinstance(value, list): return [redacted(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'(?i)\bBearer\s+[^\s"\']+', 'Bearer [redacted]', value)
        value = re.sub(r'\b(?:wbpk_|sk-)[A-Za-z0-9_-]+', '[redacted]', value)
        value = re.sub(r'(?i)("(?:api_key|apikey|publishablekey|authorization|access_token|refresh_token|upload_token)"\s*:\s*")[^"]*(")', r'\1[redacted]\2', value)
    return value


def article_metadata(workspace, aid, vid):
    fields = workspace.version_evidence(aid, vid)
    fields = {k: v for k, v in fields.items() if v is not None and v != ''}
    clean = redacted(fields)
    if clean != fields: clean['source_metadata_redacted'] = True
    return clean


def backfill_article(store, aid, trace_root):
    """For an isolated backup: match old output by exact ZIP initial-body replay.

    Ambiguous/absent matches stay absent. No native table writes or model calls.
    """
    ws = Workspace(store)
    if ws.generation_evidence(aid): return {'article_id': aid, 'status': 'already_saved'}
    native = store.get_article(aid)
    versions = [v for v in ws.versions(aid) if v['origin'] == 'zip']
    if not native or not versions: return {'article_id': aid, 'status': 'missing'}
    initial = min(versions, key=lambda v: v['id'])['article']
    snapshot = ws.article_source(aid)
    platform = next((p for p in snapshot.get('platforms', []) if p['id'] == initial['platform_id']), None)
    if not platform: return {'article_id': aid, 'status': 'missing_snapshot'}
    with store.conn() as conn:
        ops = conn.execute("SELECT o.id FROM wb_operations o JOIN wb_conversations c ON c.id=o.conversation_id WHERE c.plan_id=? AND o.kind='writing' ORDER BY o.rowid", (native['plan_id'],)).fetchall()
    matches = []
    for op in ops:
        requests = sorted((Path(trace_root) / op['id']).glob('*-request.json'))
        if len(requests) > 500: continue
        for i, request_file in enumerate(requests):
            response_file = request_file.with_name(request_file.name.replace('-request.json', '-response.json'))
            if not response_file.is_file() or request_file.stat().st_size > 32 * 1024 * 1024 or response_file.stat().st_size > 2 * 1024 * 1024: continue
            request = json.loads(request_file.read_text(encoding='utf-8'))
            messages = request.get('messages') or []
            if not messages or messages[0].get('content') == prompts.AUDIT_RULES: continue
            response = json.loads(response_file.read_text(encoding='utf-8'))
            data = llm.parse_json(response.get('text', ''))
            if response.get('error') or not isinstance(data, dict) or not data.get('title'): continue
            try:
                finalized = generator._finalize(copy.deepcopy(data), snapshot['brief'], platform,
                    {'name': initial['angle']}, initial['fmt'], snapshot['settings'], initial['keyword'],
                    [k for k in initial['keywords'] if k != initial['keyword']], account_type=initial['account_type'])
            except (ValueError, KeyError, TypeError): continue
            if finalized['title'] != initial['title'] or finalized['body_md'] != initial['body_md']: continue
            evidence = {'zip_data': finalized['data'], 'raw_generation': response['text']}
            if i + 1 < len(requests):
                audit_request = json.loads(requests[i + 1].read_text(encoding='utf-8'))
                audit_messages = audit_request.get('messages') or []
                audit_file = requests[i + 1].with_name(requests[i + 1].name.replace('-request.json', '-response.json'))
                if len(audit_messages) >= 2 and audit_messages[0].get('content') == prompts.AUDIT_RULES and initial['body_md'].strip() in audit_messages[1].get('content', '') and audit_file.is_file():
                    raw = json.loads(audit_file.read_text(encoding='utf-8')).get('text')
                    if raw: evidence['raw_audit'] = raw
            matches.append(evidence)
    if len(matches) != 1: return {'article_id': aid, 'status': 'ambiguous' if matches else 'no_exact_match', 'matches': len(matches)}
    ws.save_generation_evidence(aid, **matches[0])
    return {'article_id': aid, 'status': 'saved', 'fields': sorted(matches[0]), 'exact_initial_body': True}
