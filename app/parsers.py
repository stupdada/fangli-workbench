# -*- coding: utf-8 -*-
"""客户资料文件解析：docx / xlsx / pptx / txt / md / csv / html 等，纯标准库实现。

设计要点
- 只依赖标准库（zipfile + xml.etree），无需安装任何东西
- 每种格式一个解析函数，注册在 PARSERS 里，后续加新格式只需 register()
- 解析失败不抛给用户看堆栈，统一返回可读的中文提示
- 未知格式给出明确的"改存为什么格式"或"直接粘贴"指引
"""

import csv
import io
import re
import zipfile
from html import unescape
from xml.etree import ElementTree as ET

MAX_BYTES = 8 * 1024 * 1024      # 单个文件上限 8MB
MAX_TEXT = 200_000               # 解析出的正文上限 20 万字符

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


class Unsupported(Exception):
    """不支持的格式，消息直接给用户看。"""


class ParseError(Exception):
    pass


def _clean(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _cap(text):
    if len(text) > MAX_TEXT:
        return text[:MAX_TEXT] + "\n\n【提示】文件太长，只保留了前 20 万字。"
    return text


# ------------------------------------------------------------------ docx ----
def parse_docx(data):
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ParseError("这个 .docx 文件已损坏或不是 Word 文档")
    names = zf.namelist()
    target = "word/document.xml"
    if target not in names:
        raise ParseError("这个 .docx 里没有正文内容（可能是仅含图片的文档）")
    root = ET.fromstring(zf.read(target))
    body = root.find(W + "body")
    if body is None:
        return ""

    out = []

    def para_text(p):
        buf = []
        for node in p.iter():
            tag = node.tag
            if tag == W + "t":
                buf.append(node.text or "")
            elif tag == W + "br":
                buf.append("\n")
            elif tag == W + "tab":
                buf.append("\t")
        return "".join(buf).strip()

    def walk(container):
        for child in container:
            if child.tag == W + "p":
                t = para_text(child)
                if t:
                    out.append(t)
            elif child.tag == W + "tbl":
                out.append("")
                for tr in child.findall(W + "tr"):
                    cells = []
                    for tc in tr.findall(W + "tc"):
                        ct = " ".join(para_text(p) for p in tc.iter(W + "p"))
                        cells.append(ct.strip())
                    if any(cells):
                        out.append(" | ".join(cells))
                out.append("")
            elif child.tag == W + "sdt":
                content = child.find(W + "sdtContent")
                if content is not None:
                    walk(content)

    walk(body)
    return _clean("\n".join(out))


# ------------------------------------------------------------------ xlsx ----
def _xlsx_shared(zf):
    shared = []
    if "xl/sharedStrings.xml" not in zf.namelist():
        return shared
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    for si in root.findall(S + "si"):
        shared.append("".join(t.text or "" for t in si.iter(S + "t")))
    return shared


def parse_xlsx(data):
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ParseError("这个 .xlsx 文件已损坏或不是 Excel 文档")
    names = zf.namelist()
    shared = _xlsx_shared(zf)

    sheet_files = sorted(
        [n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)],
        key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)),
    )
    if not sheet_files:
        raise ParseError("这个 .xlsx 里没有工作表")

    title_map = {}
    if "xl/workbook.xml" in names:
        try:
            wb = ET.fromstring(zf.read("xl/workbook.xml"))
            for i, sh in enumerate(wb.iter(S + "sheet"), 1):
                title_map[i] = sh.get("name") or f"工作表{i}"
        except Exception:
            pass

    out = []
    for idx, fn in enumerate(sheet_files, 1):
        out.append(f"## {title_map.get(idx, '工作表%d' % idx)}")
        try:
            root = ET.fromstring(zf.read(fn))
        except Exception:
            continue
        rows = root.iter(S + "row")
        count = 0
        for row in rows:
            cells = []
            for c in row.findall(S + "c"):
                t = c.get("t")
                v = c.find(S + "v")
                if t == "inlineStr":
                    is_ = c.find(S + "is")
                    txt = "".join(x.text or "" for x in is_.iter(S + "t")) if is_ is not None else ""
                elif t == "s" and v is not None and v.text:
                    try:
                        txt = shared[int(v.text)]
                    except Exception:
                        txt = ""
                else:
                    txt = (v.text if v is not None else "") or ""
                cells.append(txt.strip())
            while cells and not cells[-1]:
                cells.pop()
            if any(cells):
                out.append("\t".join(cells))
                count += 1
            if count > 3000:
                out.append("【提示】这张表行数太多，只保留了前 3000 行。")
                break
        out.append("")
    return _clean("\n".join(out))


# ------------------------------------------------------------------ pptx ----
def parse_pptx(data):
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ParseError("这个 .pptx 文件已损坏或不是 PowerPoint 文档")
    slides = sorted(
        [n for n in zf.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)],
        key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)),
    )
    if not slides:
        raise ParseError("这个 .pptx 里没有幻灯片")
    out = []
    for i, fn in enumerate(slides, 1):
        out.append(f"## 第 {i} 页")
        try:
            root = ET.fromstring(zf.read(fn))
        except Exception:
            continue
        for p in root.iter(A + "p"):
            txt = "".join(t.text or "" for t in p.iter(A + "t")).strip()
            if txt:
                out.append(txt)
        out.append("")
    return _clean("\n".join(out))


# ------------------------------------------------------------- 纯文本类 ----
def _decode(data):
    for enc in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return data.decode("latin-1", "ignore")


def parse_text(data):
    return _clean(_decode(data))


def parse_html(data):
    raw = _decode(data)
    raw = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?i)</(p|div|li|h[1-6]|tr)>", "\n", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    return _clean(unescape(raw))


def parse_csv(data):
    raw = _decode(data)
    rows = []
    try:
        dialect = csv.Sniffer().sniff(raw[:4000], delimiters=",;\t")
    except Exception:
        dialect = csv.excel
    for i, row in enumerate(csv.reader(io.StringIO(raw), dialect)):
        rows.append("\t".join(x.strip() for x in row))
        if i > 3000:
            rows.append("【提示】表格行数太多，只保留了前 3000 行。")
            break
    return _clean("\n".join(rows))


# ------------------------------------------------------------------ 注册 ----
PARSERS = {
    ".docx": ("Word 文档", parse_docx),
    ".docm": ("Word 文档", parse_docx),
    ".xlsx": ("Excel 表格", parse_xlsx),
    ".xlsm": ("Excel 表格", parse_xlsx),
    ".pptx": ("PPT 演示稿", parse_pptx),
    ".txt": ("纯文本", parse_text),
    ".md": ("Markdown", parse_text),
    ".markdown": ("Markdown", parse_text),
    ".csv": ("表格文本", parse_csv),
    ".tsv": ("表格文本", parse_csv),
    ".json": ("JSON 文本", parse_text),
    ".html": ("网页", parse_html),
    ".htm": ("网页", parse_html),
    ".log": ("纯文本", parse_text),
}

# 这些格式明确支持但当前不支持，给出可照做的替代方案
KNOWN_UNSUPPORTED = {
    ".pdf": "PDF 暂时读不了。请用 Word 打开后「另存为 .docx」，或者直接把文字复制到「粘贴资料」框里。",
    ".doc": "老版 .doc 格式读不了。请用 Word 打开后「另存为 .docx」。",
    ".xls": "老版 .xls 格式读不了。请用 Excel 打开后「另存为 .xlsx」。",
    ".ppt": "老版 .ppt 格式读不了。请用 PowerPoint 打开后「另存为 .pptx」。",
    ".wps": "WPS 专属格式读不了。请另存为 .docx 再传。",
    ".et": "WPS 表格读不了。请另存为 .xlsx 再传。",
    ".dps": "WPS 演示读不了。请另存为 .pptx 再传。",
    ".jpg": "图片里的文字读不了。请把文字手动贴到「粘贴资料」框里。",
    ".jpeg": "图片里的文字读不了。请把文字手动贴到「粘贴资料」框里。",
    ".png": "图片里的文字读不了。请把文字手动贴到「粘贴资料」框里。",
    ".zip": "压缩包读不了。请解压后单独上传里面的文件。",
    ".rar": "压缩包读不了。请解压后单独上传里面的文件。",
    ".7z": "压缩包读不了。请解压后单独上传里面的文件。",
}


def register(ext, label, fn):
    """后续要加新格式，调这一个函数即可。"""
    PARSERS[ext.lower()] = (label, fn)


def supported_hint():
    labels = []
    for label, _ in PARSERS.values():
        if label not in labels:
            labels.append(label)
    return "、".join(labels)


def parse_file(filename, data):
    """返回 dict：ok / kind / text / chars / warning / message"""
    if not data:
        raise ParseError("文件是空的")
    if len(data) > MAX_BYTES:
        raise ParseError(f"文件超过 {MAX_BYTES // 1024 // 1024}MB，请拆分后再传")

    name = (filename or "").strip() or "未命名"
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""

    if ext in KNOWN_UNSUPPORTED:
        raise Unsupported(KNOWN_UNSUPPORTED[ext])
    if ext not in PARSERS:
        raise Unsupported(
            f"暂不认识 {ext or '这种'} 格式。可以直接把文字粘贴到下面的「粘贴资料」框，"
            f"或者另存为 {supported_hint()} 里的任意一种。"
        )

    kind, fn = PARSERS[ext]
    try:
        text = fn(data)
    except Unsupported:
        raise
    except ParseError:
        raise
    except Exception as e:
        raise ParseError(f"解析失败（{kind}）：{e}。建议另存为 .txt 后再试，或直接粘贴文字。")

    if not text or len(text.strip()) < 10:
        raise ParseError(f"这个 {kind} 里没读到有效文字（可能全是图片或表格截图）")

    text = _cap(text)
    warning = ""
    if len(text) < 60:
        warning = "读到的内容很少，建议核对一下是不是传错文件了"
    return {"ok": True, "kind": kind, "text": text, "chars": len(text), "warning": warning}
