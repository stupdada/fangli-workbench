"""Project only the top-level reply string from an unfinished JSON response."""
import json


def string_prefix(text):
    result, i = [], 0
    escapes = {'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}
    while i < len(text):
        char = text[i]
        if char == '"':
            return ''.join(result)[:4000], True
        if char == '\\':
            if i + 1 >= len(text): break
            kind = text[i + 1]
            if kind == 'u':
                if i + 6 > len(text): break
                try: code = int(text[i + 2:i + 6], 16)
                except ValueError: break
                if 0xD800 <= code <= 0xDBFF:
                    if i + 12 > len(text) or text[i + 6:i + 8] != '\\u': break
                    try: low = int(text[i + 8:i + 12], 16)
                    except ValueError: break
                    if not 0xDC00 <= low <= 0xDFFF: break
                    char = chr(0x10000 + ((code - 0xD800) << 10) + low - 0xDC00)
                    i += 12
                elif 0xDC00 <= code <= 0xDFFF:
                    break
                else:
                    char = chr(code); i += 6
            elif kind in escapes:
                char = escapes[kind]; i += 2
            else: break
        else:
            if ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF: break
            i += 1
        if len(result) < 4000: result.append(char)
    return ''.join(result), False


def project_reply(raw):
    start = raw.find('{')
    if start < 0: return '', False
    depth, quoted, escaped, key, expect_key, token = 0, False, False, '', True, 0
    for i in range(start, len(raw)):
        char = raw[i]
        if quoted:
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == '"':
                quoted = False
                if depth == 1 and expect_key:
                    try: key = json.loads(raw[token:i + 1])
                    except ValueError: return '', False
                    expect_key = False
            continue
        if char == '"':
            if depth == 1 and not expect_key and key == 'understanding':
                return string_prefix(raw[i + 1:])
            quoted, token = True, i
        elif char in '{[': depth += 1
        elif char in '}]': depth -= 1
        elif char == ',' and depth == 1: expect_key, key = True, ''
    return '', False
