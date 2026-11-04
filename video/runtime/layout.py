"""Local font-measured, complete-text pagination. No encoding or external requests."""
import json
import math
from pathlib import Path
import re
import sys
from bisect import bisect_left
from functools import lru_cache

sys.path.insert(0, str(Path(__file__).parent / 'video-engine'))
import silent_renderer as renderer

STRONG = '。！？；!?;'
CLAUSE = '，：、,:'
CLOSING = '。！？；，、：,.!?;:%)]）】》」』”’'
OPENING = '([（【《「『“‘'
WRAPPERS = ')]）】》」』”’'
CONNECTORS = ('并且', '并逐', '并将', '并把', '同时', '然后', '最后', '因此', '所以', '以便', '但是', '再', '请')


def break_rules(text, protected):
    """Keep known names, Latin words, numbers and technical ranges intact."""
    forbidden = set()
    for match in re.finditer(r'[A-Za-z0-9][A-Za-z0-9_.+%/°℃μ—–−-]*', text):
        forbidden.update(range(match.start() + 1, match.end()))
    for name in protected:
        for match in re.finditer(re.escape(name), text):
            forbidden.update(range(match.start() + 1, match.end()))

    def legal(end):
        after = end
        while after < len(text) and text[after].isspace(): after += 1
        before = end - 1
        while before >= 0 and text[before].isspace(): before -= 1
        return (end not in forbidden and
                (after == len(text) or text[after] not in CLOSING) and
                (before < 0 or text[before] not in OPENING))

    def rank(end):
        terminal = end - 1
        while terminal >= 0 and (text[terminal] in WRAPPERS or text[terminal].isspace()): terminal -= 1
        if terminal >= 0 and text[terminal] in STRONG: return 0
        if terminal >= 0 and text[terminal] in CLAUSE: return 1
        if end < len(text) and text[end] == '—': return 1.5
        if text[end - 1] == '—': return 1.6
        if text[end - 1].isspace() or end < len(text) and text[end].isspace(): return 2
        if text.startswith(CONNECTORS, end): return 2
        return 4
    return legal, rank


def choose_end(text, start, limit, fit, legal, rank, sentence_ends):
    """Prefer complete clauses; look ahead across two real pages before a hard cut.

    A hard cut may fill the current screen while stranding the last character of
    the same sentence on the next. Plan that *sentence remainder* jointly. Short
    independent endings after punctuation are already semantic boundaries and
    are never stretched merely to meet a minimum page length.
    """
    safe = [end for end in range(start + 1, limit + 1) if legal(end)]
    if not safe: raise ValueError('当前画幅无法完整展示名称或连续词，请调整字号后重新分屏')
    if limit == len(text): return limit
    floor = start + max(4, (limit - start) // 3)
    preferred = [end for end in safe if end >= floor and rank(end) == 0]
    preferred = preferred or [end for end in safe if end >= floor and rank(end) == 1]
    if preferred: return preferred[-1]

    index = bisect_left(sentence_ends, limit + 1)
    scope_end = sentence_ends[index] if index < len(sentence_ends) else len(text)
    candidates = []
    if scope_end - start <= 1000:  # two pages are each capped at 500 characters
        for end in safe:
            left, right = text[start:end].strip(), text[end:scope_end].strip()
            if not left or not right or not fit(left) or not fit(right): continue
            left_count = len(re.sub(r'\W|_', '', left))
            right_count = len(re.sub(r'\W|_', '', right))
            quality = rank(end)
            # This penalty applies to artificial continuations, not genuine short
            # sentences/clauses. Balance is a last tie-break only for hard cuts.
            slivers = (max(0, 4 - left_count) + max(0, 4 - right_count)) if quality > 1 else 0
            balance = abs(len(left) - len(right)) if quality == 4 else 0
            candidates.append(((slivers, quality, balance, -end), end))
    if candidates: return min(candidates)[1]
    internal = [end for end in safe if end >= floor and rank(end) < 4]
    if internal: return min(internal, key=lambda end: (rank(end), -end))
    return safe[-1]


def paginate(value):
    body = value['body']
    text = re.sub(r'\s+', ' ', body).strip()
    width, height, style = value['width'], value['height'], value['textStyle']
    size, usable = style['fontSize'], width * .84 - style['fontSize'] * .16
    minimum = value.get('minimumSeconds', 3)
    protected = [x for x in value.get('protectedNames', []) if isinstance(x, str) and 1 < len(x) <= 60]
    legal, rank = break_rules(text, protected)
    sentence_ends = []
    for i, char in enumerate(text):
        if char not in STRONG: continue
        end = i + 1
        while end < len(text) and text[end] in WRAPPERS: end += 1
        if legal(end): sentence_ends.append(end)

    @lru_cache(maxsize=2048)
    def fit(fragment):
        if not fragment or len(fragment) > 500: return False
        lines, advance = 1, 0
        for char in fragment:
            space = size * (.4 if char.isspace() else 1.1 if ord(char) >= 0x2e80 else .7)
            if advance + space > usable: lines, advance = lines + 1, 0
            advance += space
        if lines > 2 or lines * size * 1.35 > height * .32: return False
        try:
            image, displayed, box = renderer.text_layout(fragment, width, height, style)
            image.close()
            return box
        except renderer.v.EngineError as error:
            if error.code in ('TEXT_LAYOUT_TOO_LONG', 'TEXT_LAYOUT_INVALID'): return False
            raise

    pages, cursor = [], 0
    while cursor < len(text):
        while cursor < len(text) and text[cursor].isspace(): cursor += 1
        if cursor == len(text): break
        low, high, end = cursor + 1, min(cursor + 500, len(text)), cursor
        while low <= high:
            middle = (low + high) // 2
            if fit(text[cursor:middle]): end, low = middle, middle + 1
            else: high = middle - 1
        if end == cursor: raise ValueError('当前字号或画幅无法容纳正文，请调整样式后重新分屏')
        end = choose_end(text, cursor, end, fit, legal, rank, sentence_ends)
        fragment = text[cursor:end].strip()
        box = fit(fragment)
        if not box: raise ValueError('文字超出两行安全区域')
        characters = len(re.sub(r'\s', '', fragment))
        seconds = max(3, minimum, characters / 3.5)
        frames = math.ceil(seconds * 25)
        if frames > 60 * 25: raise ValueError('单屏文字需超过60秒阅读，请增大字号或拆分正文')
        pages.append({'id': 'screen-' + str(len(pages) + 1), 'text': fragment,
                      'durationSeconds': frames / 25,
                      'layout': {k: box[k] for k in ('x', 'y', 'width', 'height', 'fontSize', 'lines')}})
        cursor = end
        if len(pages) > 100: raise ValueError('完整正文需要超过100屏，请编辑正文或调整字号；原稿已保留')
    duration = sum(round(p['durationSeconds'] * 25) for p in pages) / 25
    if duration > 600: raise ValueError('完整正文预计超过600秒执行上限，请编辑正文或调整停留设置；原稿已保留')
    assert re.sub(r'\s', '', ''.join(p['text'] for p in pages)) == re.sub(r'\s', '', body)
    return {'segments': pages, 'durationSeconds': duration, 'subtitleCharacters': len(re.sub(r'\s', '', body)),
            'screenCount': len(pages), 'readingCharactersPerSecond': 3.5, 'minimumSeconds': minimum,
            'layoutAlgorithm': 'semantic-lookahead-v2'}


if __name__ == '__main__':
    try: print(json.dumps({'ok': True, **paginate(json.load(sys.stdin))}, ensure_ascii=False))
    except Exception as error:
        code = getattr(error, 'code', '')
        message = str(error) if isinstance(error, ValueError) else '缺少字体或本地布局依赖，请检查后重试'
        print(json.dumps({'ok': False, 'errorCode': code or 'TEXT_TOO_LONG', 'error': message}, ensure_ascii=False))
        sys.exit(1)
