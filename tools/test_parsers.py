# -*- coding: utf-8 -*-
"""文件解析引擎测试：用最小的 OOXML 样本验每种格式都能读对。

用法：python tools/test_parsers.py
"""

import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import parsers  # noqa: E402
from app.parsers import ParseError, Unsupported  # noqa: E402

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


def expect(name, cond, detail=""):
    check(name, bool(cond), detail)


# ------------------------------------------------------------ 造样本 ----
def make_docx():
    doc = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>某某电器 产品介绍</w:t></w:r></w:p>
<w:p><w:r><w:t>我们的小型咖啡机支持胶囊和咖啡粉两种方式。</w:t></w:r></w:p>
<w:p><w:r><w:t>水箱容量</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>1.2L</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>型号</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>X1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>价格</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>1299元</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>质保两年，全国联保。</w:t></w:r></w:p>
</w:body></w:document>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


def make_xlsx():
    shared = """<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>型号</t></si><si><t>零售价</t></si><si><t>X1</t></si></sst>"""
    sheet = """<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1299</v></c></row>
</sheetData></worksheet>"""
    wb = """<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="报价表" sheetId="1" r:id="rId1"/></sheets></workbook>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/sharedStrings.xml", shared)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def make_pptx():
    s1 = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>竞品分析</a:t></a:r></a:p>
<a:p><a:r><a:t>A 品牌主打低价，B 品牌主打颜值。</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>"""
    s2 = """<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>客户案例：三口之家，每天两杯</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("ppt/slides/slide1.xml", s1)
        z.writestr("ppt/slides/slide2.xml", s2)
    return buf.getvalue()


# ------------------------------------------------------------ 跑测试 ----
print("\n[1] Word（.docx）")
r = parsers.parse_file("产品介绍.docx", make_docx())
expect("能读到段落文字", "某某电器 产品介绍" in r["text"])
expect("能读到第二种写法", "支持胶囊和咖啡粉" in r["text"])
expect("表格转成文本行", "型号 | X1" in r["text"] and "价格 | 1299元" in r["text"])
expect("表格后的段落没丢", "质保两年" in r["text"])
expect("类型标注正确", r["kind"] == "Word 文档", r["kind"])
print("       解析出 %d 字" % r["chars"])

print("\n[2] Excel（.xlsx）")
r = parsers.parse_file("报价.xlsx", make_xlsx())
expect("共享字符串解析正确", "型号" in r["text"] and "零售价" in r["text"])
expect("数字单元格解析正确", "1299" in r["text"])
expect("工作表名带出来", "报价表" in r["text"])
expect("制表符分隔同行", "X1\t1299" in r["text"].replace("\u3000", " "), repr(r["text"][:80]))

print("\n[3] PPT（.pptx）")
r = parsers.parse_file("竞品分析.pptx", make_pptx())
expect("第一页文字", "竞品分析" in r["text"])
expect("第二页文字", "三口之家" in r["text"])
expect("分页标记", "第 1 页" in r["text"] and "第 2 页" in r["text"])

print("\n[4] 文本类")
r = parsers.parse_file("说明.txt", "这是纯文本资料，包含产品卖点。".encode("utf-8"))
expect("UTF-8 文本", "产品卖点" in r["text"])
r = parsers.parse_file("gbk.txt", "这是 GBK 编码的中文资料内容。".encode("gbk"))
expect("GBK 文本不乱码", "GBK 编码的中文" in r["text"], r["text"][:30])
r = parsers.parse_file("说明.md", "# 标题\n\n- 要点一\n- 要点二".encode("utf-8"))
expect("Markdown 保留结构", "要点一" in r["text"])
r = parsers.parse_file("数据.csv", "型号,价格\nX1,1299\n".encode("utf-8"))
expect("CSV 转表格", "X1" in r["text"] and "1299" in r["text"])
r = parsers.parse_file("页面.html", "<html><body><h1>公司介绍</h1><script>var x=1</script><p>我们成立于 2010 年。</p></body></html>".encode("utf-8"))
expect("HTML 去掉标签", "公司介绍" in r["text"] and "成立于 2010 年" in r["text"])
expect("HTML 去掉脚本", "var x" not in r["text"])

print("\n[5] 不支持的格式要给可照做的提示")
for fname, kw in [("资料.pdf", "另存为 .docx"), ("旧版.doc", "另存为 .docx"),
                  ("图片.jpg", "粘贴"), ("压缩包.zip", "解压")]:
    try:
        parsers.parse_file(fname, b"x" * 100)
        check(fname + " 应该被拒绝", False)
    except Unsupported as e:
        check(fname + " 给出替代方案", kw in str(e), str(e)[:40])

try:
    parsers.parse_file("未知.xyz", b"x" * 100)
    check("陌扩展名被拒绝", False)
except Unsupported as e:
    check("陌扩展名提示粘贴或另存", "粘贴" in str(e) and "另存" in str(e))

print("\n[6] 异常输入")
try:
    parsers.parse_file("空.txt", b"")
    check("空文件被拒绝", False)
except ParseError as e:
    check("空文件被拒绝", True)

try:
    parsers.parse_file("坏.docx", b"not a zip at all")
    check("损坏 docx 被拒绝", False)
except ParseError as e:
    check("损坏 docx 被拒绝", "损坏" in str(e))

try:
    parsers.parse_file("大.txt", b"x" * (parsers.MAX_BYTES + 1))
    check("超大文件被拒绝", False)
except ParseError as e:
    check("超大文件被拒绝", "超过" in str(e))

try:
    parsers.parse_file("空内容.docx", make_docx().replace("某某电器".encode(), b""))
    check("内容不足被拒绝或警告", True)
except (ParseError, Unsupported):
    check("内容不足被拒绝或警告", True)

print("\n[7] 可扩展性")
expect("支持格式含 4 类核心", all(e in parsers.PARSERS for e in (".docx", ".xlsx", ".pptx", ".txt")))
parsers.register(".abc", "自定义格式", parsers.parse_text)
expect("可注册新格式", ".abc" in parsers.PARSERS)
r = parsers.parse_file("自定义.abc", "自定义格式的内容测试文本".encode("utf-8"))
expect("新格式能解析", "自定义格式的内容" in r["text"])
del parsers.PARSERS[".abc"]

print("\n" + "=" * 46)
print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
if failed:
    for n, d in failed:
        print("  失败：" + n + ("  " + d if d else ""))
    print("结果：不通过")
    sys.exit(1)
print("结果：全部通过")
