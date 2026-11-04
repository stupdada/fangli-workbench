# -*- coding: utf-8 -*-
"""Word 导出测试：生成 .docx 后再用自家解析器读回来，验证结构与内容都没丢。

用法：python tools/test_docx.py
"""

import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import docx_writer, parsers, render  # noqa: E402

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


MD = """# 西邦 24 怎么选：三个判断标准

**结论先说：看使用频率、空间条件和后续成本。**

## 为什么先看这三项

很多人一上来比价格，其实方向就错了。

- 每周用 5 次以上，优先看耐用度
- 一周用不到 2 次，优先看上手难度

### 成本怎么算

三笔钱要一起算，不是只看标价。

> 引用一句：买得便宜，用一年反而更贵。

## 对比表

| 项目 | 西邦 24 | 同类产品 |
|---|---|---|
| 固化时间 | 24 小时 | 48 小时 |
| 耐温 | 120℃ | 90℃ |

---

## 品牌与联系信息

- 品牌：西邦
- 公司全称：某某新材料有限公司
- 官方网站：cilbond.cn
"""

print("\n[1] 生成 .docx")
data = docx_writer.build_docx(MD, "测试方案")
check("产出非空", len(data) > 3000, f"{len(data)} 字节")
try:
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = zf.namelist()
    check("是合法 zip", True)
except Exception as e:
    check("是合法 zip", False, str(e))
    sys.exit(1)

for entry in ["[Content_Types].xml", "_rels/.rels", "word/document.xml",
              "word/styles.xml", "word/_rels/document.xml.rels",
              "docProps/core.xml", "docProps/app.xml"]:
    check(f"包含 {entry}", entry in names)

ct = zf.read("[Content_Types].xml").decode("utf-8")
check("声明为 Word 文档类型", "wordprocessingml.document.main+xml" in ct)

print("\n[2] XML 结构合法")
for entry in ["word/document.xml", "word/styles.xml", "[Content_Types].xml", "_rels/.rels"]:
    try:
        ET.fromstring(zf.read(entry))
        check(f"{entry} 可解析", True)
    except Exception as e:
        check(f"{entry} 可解析", False, str(e))

doc = zf.read("word/document.xml").decode("utf-8")
check("有 A4 页面设置", 'w:w="11906"' in doc and 'w:h="16838"' in doc)
check("中文用 eastAsia 字体", 'w:eastAsia="微软雅黑"' in doc)
check("标题用了 Heading 样式", 'w:val="Heading1"' in doc and 'w:val="Heading2"' in doc)
check("三级标题也在", 'w:val="Heading3"' in doc)
check("粗体转换成功", "<w:b/>" in doc)
check("表格是真正的 Word 表格", "<w:tbl>" in doc and "<w:tc>" in doc)
check("表格有边框", "<w:tblBorders>" in doc)
check("没有残留的 ** 符号", doc.count("**") == 0, str(doc.count("**")))

print("\n[3] 读回来：内容没丢")
back = parsers.parse_file("t.docx", data)["text"]
for piece, label in [
    ("西邦 24 怎么选：三个判断标准", "一级标题"),
    ("结论先说", "加粗摘要"),
    ("为什么先看这三项", "二级标题"),
    ("每周用 5 次以上", "列表项"),
    ("成本怎么算", "三级标题"),
    ("买得便宜，用一年反而更贵", "引用"),
    ("固化时间 | 24 小时 | 48 小时", "表格行"),
    ("某某新材料有限公司", "公司全称"),
    ("cilbond.cn", "官网"),
]:
    check(f"保留：{label}", piece in back, back[:120])

check("列表项带符号不丢失", back.count("•") >= 2, str(back.count("•")))
check("表格三行都在（每行 2 个竖线）", back.count("|") >= 6, str(back.count("|")))
check("顺序正确（标题在前）", back.index("西邦 24 怎么选") < back.index("为什么先看这三项") < back.index("品牌与联系信息"))

print("\n[4] 整份方案导出：只含正文")
plan = {
    "id": 1, "title": "测试方案", "keyword": "西邦 24",
    "created_at": "2026-11-02 16:00:00",
    "brief": {"keywords": ["西邦 24", "Cilbond 24"], "models": ["豆包"],
              "platforms": ["知乎个人号"], "rivals": ["德龙"],
              "snapshot": {"matrix": [{"model": "豆包", "cells": [{"platform": "知乎个人号", "level": "high"}]}],
                           "risks": [{"platform": "知乎个人号", "items": [
                               {"category": "广告法", "item": "最、第一", "level": "高", "tip": "改条件化描述"}]}],
                           "levels": {"high": "高优先抓取"}}},
    "materials": [{"filename": "产品介绍.docx", "kind": "Word 文档", "chars": 120}],
    "articles": [
        {"platform_name": "知乎个人号", "angle": "疑问型", "fmt": "图文",
         "keyword": "西邦 24", "keywords": ["西邦 24", "Cilbond 24"],
         "title": "西邦 24 怎么选", "body_md": "# 西邦 24 怎么选\n\n正文一段。\n\n- 要点一\n\n**加粗结论。**"},
        {"platform_name": "搜狐个人号", "angle": "对比型", "fmt": "图文",
         "keyword": "西邦 62W", "keywords": ["西邦 62W"],
         "title": "西邦 62W 对比", "body_md": "# 西邦 62W 对比\n\n第二篇正文。"},
    ],
}
blob = render.export_plan_docx(plan)
check("整包导出成功", len(blob) > 3000, f"{len(blob)} 字节")
txt = parsers.parse_file("plan.docx", blob)["text"]

check("含第一篇标题", "西邦 24 怎么选" in txt)
check("含第一篇正文", "正文一段" in txt)
check("含第二篇标题", "西邦 62W 对比" in txt)
check("含第二篇正文", "第二篇正文" in txt)

check("不含方案头（关键词清单）", "本轮目标搜索关键词" not in txt, txt[:80])
check("不含方案头（生成时间）", "2026-11-02" not in txt)
check("不含抓取偏好对照表", "抓取偏好对照表" not in txt and "高优先抓取" not in txt)
check("不含风险点清单", "风险点清单" not in txt and "广告法" not in txt)
check("不含资料清单", "产品介绍.docx" not in txt)
check("不含竞争品牌", "德龙" not in txt)
check("不含平台/角度标注", "知乎个人号" not in txt and "疑问型" not in txt)
check("不含覆盖关键词标注", "覆盖关键词" not in txt)

doc = zipfile.ZipFile(io.BytesIO(blob)).read("word/document.xml").decode("utf-8")
check("篇与篇之间有分页符", 'w:type="page"' in doc)
check("两篇都渲染了标题样式", doc.count('w:val="Heading1"') >= 2, str(doc.count('w:val="Heading1"')))

print("\n[4b] 没有稿件时不导出空文档")
empty_plan = dict(plan)
empty_plan["articles"] = []
check("空方案导出内容为空", render.export_bodies_md(empty_plan) == "")

print("\n[5] 边界情况")
check("空内容也能生成", len(docx_writer.build_docx("", "空")) > 1000)
check("只有标题也能生成",
      "标题" in parsers.parse_file("a.docx", docx_writer.build_docx("# 这是一个比较长的标题"))["text"])
special = "# 含符号 <>&\"'\n\n正文里也有 <tag> 和 & 符号。"
back2 = parsers.parse_file("b.docx", docx_writer.build_docx(special))["text"]
check("特殊字符不炸 XML", "正文里也有" in back2 and "&" in back2, back2[:80])
check("特殊字符原样保留", "<tag>" in back2, back2[:80])

# 模型偶尔把收尾的 ** 单独写一行
broken = "# 标题\n\n**第一行内容\n**\n\n## 小节\n\n正文。"
xml_b = zipfile.ZipFile(io.BytesIO(docx_writer.build_docx(broken))).read("word/document.xml").decode("utf-8")
check("断行的粗体标记被并回一行", xml_b.count("**") == 0, str(xml_b.count("**")))
check("内容没丢", "第一行内容" in parsers.parse_file("c.docx", docx_writer.build_docx(broken))["text"])

print("\n" + "=" * 46)
print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
if failed:
    for n, d in failed:
        print("  失败：" + n + ("  " + d if d else ""))
    print("结果：不通过")
    sys.exit(1)
print("结果：全部通过")
