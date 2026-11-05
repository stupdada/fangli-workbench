"""Name rule checks honestly and match the actual rendered platform layout."""
import copy
import re
from app import prompts


def article_checks(article, report, creation_style=None):
    report = copy.deepcopy(report)
    layout = prompts.layout_for({'name': article.get('platform_name', '')}, article.get('fmt', '图文'))
    title = layout.get('facts_title', '关键信息速览')
    block = re.search(r'(?m)^##\s*' + re.escape(title) + r'\s*\n([\s\S]*?)(?=^##\s|\Z)', article.get('body_md') or '')
    facts = len(re.findall(r'(?m)^\s*[-*]\s+', block[1])) if block else 0
    checks = []
    if creation_style:
        body = article.get('body_md') or ''
        plain = '\n'.join(line for line in body.splitlines() if not re.match(r'^(#\s|#(?!#)\S|声明[:：])', line))
        plain = re.sub(r'(?m)^\s*(?:#{2,6}\s+|[-*]\s+|\d+\.\s+)', '', plain)
        measured = len(re.sub(r'\s|\*\*|__|`', '', plain))
        report['length'] = {**creation_style['length'], 'actual': measured}
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
