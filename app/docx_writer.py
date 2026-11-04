# -*- coding: utf-8 -*-
"""Markdown → .docx（Word），纯标准库实现。

docx 本质是 zip 包里的几个 XML，这里按最小可用集生成：
[Content_Types].xml / _rels/.rels / word/document.xml / word/styles.xml
/ word/_rels/document.xml.rels / docProps/core.xml / docProps/app.xml

支持：# ## ### 标题、普通段落、- 列表、**粗体**、| 表格 |、> 引用、--- 分隔线。
"""

import re
import zipfile
from io import BytesIO
from xml.sax.saxutils import escape

FONT_BODY = "微软雅黑"
FONT_HEAD = "微软雅黑"
SIZE_BODY = 22          # 半磅，22 = 11pt
SIZE_H1, SIZE_H2, SIZE_H3 = 36, 30, 25


def _runs(text, bold=False):
    """把 **粗体** 拆成多个 run。"""
    out = []
    for i, seg in enumerate(re.split(r"\*\*(.+?)\*\*", text)):
        seg = seg.replace("**", "")   # 兜底：成不了对的星号不显示在 Word 里
        if not seg:
            continue
        is_bold = bold or (i % 2 == 1)
        rpr = "<w:rPr>"
        rpr += f'<w:rFonts w:ascii="{FONT_BODY}" w:hAnsi="{FONT_BODY}" w:eastAsia="{FONT_BODY}"/>'
        if is_bold:
            rpr += "<w:b/>"
        rpr += "</w:rPr>"
        out.append(
            f'<w:r>{rpr}<w:t xml:space="preserve">{escape(seg)}</w:t></w:r>'
        )
    return "".join(out) or '<w:r><w:t xml:space="preserve"></w:t></w:r>'


def _para(text, style=None, bold=False, align=None, space_before=0, space_after=120, indent=None):
    ppr = "<w:pPr>"
    if style:
        ppr += f'<w:pStyle w:val="{style}"/>'
    if align:
        ppr += f'<w:jc w:val="{align}"/>'
    ppr += f'<w:spacing w:before="{space_before}" w:after="{space_after}" w:line="320" w:lineRule="auto"/>'
    if indent:
        ppr += f'<w:ind w:left="{indent}"/>'
    ppr += "</w:pPr>"
    return f"<w:p>{ppr}{_runs(text, bold)}</w:p>"


def _table(rows):
    """rows: [[cell,...],...] 第一行为表头。"""
    ncol = max(len(r) for r in rows) if rows else 0
    if not ncol:
        return ""
    col_w = int(9000 / ncol)
    grid = "".join(f'<w:gridCol w:w="{col_w}"/>' for _ in range(ncol))
    xml = ['<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>'
           '<w:tblW w:w="5000" w:type="pct"/>'
           '<w:tblBorders>'
           '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/>'
           '<w:left w:val="single" w:sz="4" w:color="BFBFBF"/>'
           '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/>'
           '<w:right w:val="single" w:sz="4" w:color="BFBFBF"/>'
           '<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/>'
           '<w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>'
           '</w:tblBorders></w:tblPr>'
           f"<w:tblGrid>{grid}</w:tblGrid>"]
    for ri, row in enumerate(rows):
        cells = list(row) + [""] * (ncol - len(row))
        xml.append("<w:tr>")
        for cell in cells:
            shade = '<w:shd w:val="clear" w:fill="F2F5F9"/>' if ri == 0 else ""
            xml.append(
                f'<w:tc><w:tcPr><w:tcW w:w="{col_w}" w:type="dxa"/>{shade}'
                '<w:tcMar><w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>'
                '<w:left w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar>'
                "</w:tcPr>"
                + _para(cell, bold=(ri == 0), space_before=0, space_after=0)
                + "</w:tc>"
            )
        xml.append("</w:tr>")
    xml.append("</w:tbl>")
    # 表格后留一点空
    xml.append(_para("", space_before=0, space_after=60))
    return "".join(xml)


def _split_row(line):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return cells


def _is_sep_row(line):
    return bool(re.fullmatch(r"\|?[\s:\-\|]+\|?", line.strip())) and "-" in line


def _merge_orphan_marks(lines):
    """模型偶尔把收尾的 ** 单独写了一行，先并回上一行，避免 Word 里露出星号。"""
    out = []
    for line in lines:
        if line.strip() in ("**", "****") and out:
            out[-1] = out[-1].rstrip() + line.strip()
        else:
            out.append(line)
    return out


def md_to_body(md):
    lines = _merge_orphan_marks((md or "").replace("\r\n", "\n").split("\n"))
    out = []
    i = 0
    in_list = False
    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        # 表格
        if stripped.startswith("|") and i + 1 < len(lines) and _is_sep_row(lines[i + 1]):
            rows = [_split_row(stripped)]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(_split_row(lines[i]))
                i += 1
            out.append(_table(rows))
            in_list = False
            continue

        if "\f" in raw:
            out.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
            in_list = False
            i += 1
            continue

        if not stripped:
            in_list = False
            i += 1
            continue

        if stripped.startswith("#"):
            m = re.match(r"(#{1,6})\s+(.*)", stripped)
            if m:
                level = min(len(m.group(1)), 3)
                style = f"Heading{level}"
                size = {1: SIZE_H1, 2: SIZE_H2, 3: SIZE_H3}[level]
                text = m.group(2).strip()
                ppr = (f'<w:pPr><w:pStyle w:val="{style}"/><w:spacing w:before="240" w:after="120" w:line="320" w:lineRule="auto"/></w:pPr>')
                rpr = (f'<w:rPr><w:rFonts w:ascii="{FONT_HEAD}" w:hAnsi="{FONT_HEAD}" w:eastAsia="{FONT_HEAD}"/>'
                       f'<w:b/><w:sz w:val="{size}"/></w:rPr>')
                out.append(f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>')
                in_list = False
                i += 1
                continue

        if stripped in ("---", "***", "___"):
            out.append('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="D0D7E2"/>'
                       '</w:pBdr><w:spacing w:before="120" w:after="120"/></w:pPr></w:p>')
            in_list = False
            i += 1
            continue

        if stripped.startswith("> "):
            out.append(_para(stripped[2:].strip(), indent=420, space_after=80))
            in_list = False
            i += 1
            continue

        m = re.match(r"^[-*]\s+(.*)", stripped)
        if m:
            out.append(_para("• " + m.group(1), indent=420, space_after=60))
            in_list = True
            i += 1
            continue

        out.append(_para(stripped))
        in_list = False
        i += 1

    if not out:
        out.append(_para("（空文档）"))
    return "".join(out)


STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑" w:cs="微软雅黑"/>
<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="280" w:after="140"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="260" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="1F3A5F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
<w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="220" w:after="100"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="25"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>
<w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:left w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:right w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>
</w:tblBorders></w:tblPr></w:style>
</w:styles>"""

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

APP = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>GEO 内容工作台</Application>
</Properties>"""


def _core(title, author="GEO 内容工作台"):
    return f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>{escape(title or '内容方案')}</dc:title>
<dc:creator>{escape(author)}</dc:creator>
<cp:lastModifiedBy>{escape(author)}</cp:lastModifiedBy>
</cp:coreProperties>"""


def build_docx(md_text, title=""):
    body = md_to_body(md_text)
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>" + body +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1418" '
        'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
        "</w:body></w:document>"
    )
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("docProps/core.xml", _core(title))
        z.writestr("docProps/app.xml", APP)
        z.writestr("word/document.xml", document)
        z.writestr("word/styles.xml", STYLES)
        z.writestr("word/_rels/document.xml.rels", DOC_RELS)
    return buf.getvalue()
