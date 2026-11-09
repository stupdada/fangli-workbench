"""Plan the rows shown before submission and validate the user's selection."""
import copy
import hashlib
import json
from collections import Counter

from app import generator, prompts
from .creation_context import digest, key
from .errors import Problem
from .storage import text_value


TOPICS = {
    '疑问型': '{}怎么选？',
    '对比型': '{}的常见方案怎么比较？',
    '科普型': '{}的原理和适用条件',
    '选型型': '选购{}时需要考虑哪些条件？',
    '避坑型': '{}的常见使用误区',
    '案例实操型': '{}在实际场景中怎么用？',
}


class PreviewPlatforms:
    def __init__(self, snapshot):
        self.platforms = copy.deepcopy(snapshot['platforms'])
        for platform in self.platforms:
            override = snapshot['format_overrides'].get(str(platform['id']))
            if override:
                platform['formats'] = override

    def list_platforms(self):
        return self.platforms


def plan_rows(snapshot, videos):
    brief = snapshot['brief']
    tasks = generator.build_task_queue(PreviewPlatforms(snapshot), brief['keywords'], brief['selections'],
                                       brief.get('aliases'), brief.get('platform_types'))
    tasks.sort(key=lambda task: (task['index'], task['seq']))
    rows = []
    variants = snapshot['creation_context']['style']['variants']
    for position, task in enumerate(tasks, 1):
        angle_index = snapshot['topic_offset'] + position - 1
        angle = prompts.ANGLES[angle_index % len(prompts.ANGLES)]
        words = task['group'][:3]
        variant = variants.get(key(task['platform_id'], task['account_type'], task['fmt']), {})
        direction = ' '.join(words[0].split())[:480]
        topic = TOPICS[angle['name']].format(direction)
        if len(tasks) == 1 and brief.get('topic'):
            topic = ' '.join(brief['topic'].split())[:500] or topic
        rows.append({'id': f'article:{position}', 'kind': 'article', 'position': position, 'topic': topic,
                     'platform_id': task['platform_id'], 'platform_name': task['platform_name'],
                     'account_type': task['account_type'], 'format': task['fmt'], 'keywords': words,
                     'related_keywords': [target for source, target in brief.get('keyword_links', []) if source == words[0]],
                     'angle': angle, 'sub': prompts.SUB_ANGLES[(angle_index * 5) % len(prompts.SUB_ANGLES)],
                     'style_name': angle['name'],
                     'length_hint': variant.get('length', {}).get('hint', '')})
    for position, video in enumerate(videos, 1):
        article = video.get('article_index')
        rows.append({'id': f'video:{position}', 'kind': 'video', 'position': position, 'topic': video['topic'],
                     'platform_name': '通用短视频', 'format': '视频成片', 'style_name': '页面式口播',
                     **({'depends_on': f'article:{article}'} if article else {})})
    # The ZIP export timestamp is generated for each request and does not affect generation.
    stable = {**snapshot, 'zip_snapshot': {k: v for k, v in snapshot['zip_snapshot'].items() if k != 'created_at'}}
    payload = json.dumps([stable, rows, videos], ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return {'revision': hashlib.sha256(payload.encode('utf-8')).hexdigest(), 'rows': rows,
            'documents': [{k: doc[k] for k in ('id', 'filename', 'revision')} for doc in snapshot['documents']]}


def confirm_rows(snapshot, videos, planned, confirmation):
    if not isinstance(confirmation, dict) or set(confirmation) != {'revision', 'rows'}:
        raise Problem('请重新打开逐条预览后提交')
    if confirmation['revision'] != planned['revision']:
        raise Problem('预览依据已更新，请刷新预览后重新确认')
    choices = confirmation['rows']
    if not isinstance(choices, list) or not choices or len(choices) > len(planned['rows']):
        raise Problem('请保留至少一条有效安排')
    rows = {row['id']: row for row in planned['rows']}
    edits = {}
    for choice in choices:
        if not isinstance(choice, dict) or set(choice) - {'id', 'topic'}:
            raise Problem('逐条安排只接受预览条目和换后的题目')
        ident = choice.get('id')
        if not isinstance(ident, str) or ident not in rows or ident in edits:
            raise Problem('逐条安排包含无效或重复的条目')
        topic = text_value(choice.get('topic', rows[ident]['topic']), '选题', 500, empty=False).strip()
        if any(char in topic for char in ('\0', '\r', '\n')):
            raise Problem('选题须为一行文字')
        edits[ident] = topic
    articles, selected_videos = [], []
    for ident, row in rows.items():
        if ident not in edits:
            continue
        if row['kind'] == 'article':
            articles.append({**row, 'topic': edits[ident]})
        else:
            if row.get('depends_on') and row['depends_on'] not in edits:
                raise Problem('请保留视频所引用的文章，或取消这条视频')
            selected_videos.append({**videos[row['position'] - 1], 'topic': edits[ident]})
    counts = Counter((row['platform_id'], row['account_type']) for row in articles)
    selections = [{**item, 'count': counts[item['platform_id'], item['account_type']]}
                  for item in snapshot['brief']['selections'] if counts[item['platform_id'], item['account_type']]]
    snapshot['brief'].update(selections=selections, platforms=list(dict.fromkeys(row['platform_name'] for row in articles)))
    snapshot['options']['selections'] = selections
    context = snapshot['creation_context']
    context['request']['selections'] = selections
    context['digest'] = digest(context)
    snapshot['arranged_articles'] = articles
    return len(articles), selected_videos


def public_preview(preview):
    return {**preview, 'rows': [{k: v for k, v in row.items() if k not in ('angle', 'sub')}
                               for row in preview['rows']]}
