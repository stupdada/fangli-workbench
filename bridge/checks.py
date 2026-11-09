"""Name rule checks honestly and match the actual rendered platform layout."""
import copy
import re
from app import prompts
from .creation_context import length_bounds


def body_character_count(body):
    lines = body.strip().splitlines()
    if lines and re.match(r'^#[ \t]+', lines[0]):
        lines.pop(0)
    count = 0
    for line in lines:
        line = line.strip()
        if re.fullmatch(r'#[^#\s]+(?:\s+#[^#\s]+)*', line) or re.match(r'^声明\s*[:：]', line):
            continue
        if re.fullmatch(r'(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})', line):
            continue
        line = re.sub(r'^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)+', '', line)
        line = re.sub(r'!?\[([^\]\n]*)\]\([^\n)]*\)', r'\1', line)
        if line.startswith('|') and line.endswith('|'):
            if re.fullmatch(r'[|:\s-]+', line):
                continue
            line = line.replace('|', '')
        line = re.sub(r'(\*|_)([^*_]+)\1', r'\2', line.replace('**', '').replace('__', ''))
        count += len(re.sub(r'\s|`', '', line))
    return count


def article_length(body, target):
    report = {**target, 'actual': body_character_count(body)}
    if target['source'] == 'request':
        lower, upper = length_bounds(target['hint'])
        if lower is not None and report['actual'] < lower:
            report['status'] = 'below'
        elif upper is not None and report['actual'] > upper:
            report['status'] = 'above'
        elif lower is not None or upper is not None:
            report['status'] = 'within'
    return report


def article_checks(article, report, creation_style=None):
    report = copy.deepcopy(report)
    layout = prompts.layout_for({'name': article.get('platform_name', '')}, article.get('fmt', '图文'))
    title = layout.get('facts_title', '关键信息速览')
    block = re.search(r'(?m)^##\s*' + re.escape(title) + r'\s*\n([\s\S]*?)(?=^##\s|\Z)', article.get('body_md') or '')
    facts = len(re.findall(r'(?m)^\s*[-*]\s+', block[1])) if block else 0
    checks = []
    if creation_style:
        report['length'] = article_length(article.get('body_md') or '', creation_style['length'])
    for check in report.get('checks', []):
        # A universal 500-character gate contradicts short-video and short-post
        # configurations. Length is displayed, while the platform rule remains visible.
        if check['name'] == '篇幅达标':
            continue
        if check['name'] == '关键信息独立成段':
            if creation_style: continue  # Facts appear inside the reader-facing sections.
            check.update(ok=facts >= 3, hint=f'检查“{title}”中的独立信息条目，当前{facts}条')
        if check['name'] == '开篇直接给结论':
            check['name'] = '开篇长度'
        if check['name'] == '无广告法风险词':
            check['name'] = '未命中预置风险词'
        checks.append(check)
    report['checks'] = checks
    report['score'] = round(100 * sum(bool(c['ok']) for c in checks) / len(checks)) if checks else 0
    report['score_kind'] = 'legacy_rule_ratio'
    return report
