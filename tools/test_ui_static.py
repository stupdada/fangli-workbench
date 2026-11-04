# -*- coding: utf-8 -*-
"""界面结构与样式的一致性测试（不需要浏览器）。

检查：页面元素与脚本引用是否对得上、新组件样式是否补齐、上传控件接受的格式是否覆盖四类核心文件。

用法：python tools/test_ui_static.py
"""

import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
HTML = (BASE / "web" / "index.html").read_text(encoding="utf-8")
JS = (BASE / "web" / "app.js").read_text(encoding="utf-8")
CSS = (BASE / "web" / "styles.css").read_text(encoding="utf-8")

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


print("\n[1] 页面骨架")
for i in (1, 2, 3, 4):
    check(f"第 {i} 步面板存在", f'id="step{i}"' in HTML)
check("脚本引用 /static/app.js", 'src="/static/app.js"' in HTML)
check("样式引用 /static/styles.css", 'href="/static/styles.css"' in HTML)

print("\n[2] 脚本引用的元素都存在于页面")
ids = set(re.findall(r'id="([^"]+)"', HTML))
used = set(re.findall(r'\$\("#([A-Za-z0-9_]+)"', JS))
dynamic = {"m_level", "m_cat", "m_item", "m_tip", "p_style", "p_len", "p_str", "p_aud",
           "mv_text", "mv_count", "mp_name", "mp_text"}
missing = sorted(u for u in used - ids if u not in dynamic and not u.startswith(("step", "view")))
check("无悬空引用", not missing, "缺少：" + "、".join(missing))

print("\n[3] 新流程的关键控件齐全")
for name, key in [
    ("关键词输入框", 'id="k_input"'),
    ("添加关键词按钮", 'id="btnAddKw"'),
    ("关键词列表容器", 'id="kwList"'),
    ("拖拽上传区", 'id="dropZone"'),
    ("文件选择框", 'id="fileInput"'),
    ("资料列表容器", 'id="matList"'),
    ("粘贴资料按钮", 'id="btnPaste"'),
]:
    check(name, key in HTML)

print("\n[4] 上传控件接受的格式覆盖四类核心文件")
m = re.search(r'id="fileInput"[^>]*accept="([^"]+)"', HTML)
accept = m.group(1) if m else ""
for ext in (".docx", ".xlsx", ".pptx", ".txt"):
    check(f"接受 {ext}", ext in accept, accept[:60])

print("\n[5] 脚本里的新模板样式都已定义")
for cls in ["kw-row", "kw-list", "kw-add", "kb-chip", "kb-input", "rival-box", "rival-title",
            "drop-zone", "mat-item", "mat-list", "mat-tools", "dz-main", "mi-kind", "mi-act"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[6] 旧的单关键词入口已移除（避免两套逻辑并存）")
check("页面不再有 f_keyword", 'id="f_keyword"' not in HTML)
check("脚本不再读 f_keyword", "#f_keyword" not in JS)

print("\n[7] 关键交互函数都已定义")
for fn in ["addKeyword", "renderKeywords", "addFiles", "viewMaterial", "pasteMaterial",
           "renderMaterials", "toStep2", "startWrite", "newPlan",
           "fillFormFromPlan"]:
    check(f"函数 {fn}", re.search(r"(async\s+)?function\s+" + fn + r"\s*\(", JS) is not None)

print("\n[8] 新增资料接口的调用参数正确")
check("上传调用 /api/parse", '"/api/parse"' in JS and "content_b64" in JS)
check("保存调用 /api/materials/bulk", '"/api/materials/bulk"' in JS and "plan_id" in JS)
check("建方案时带 keywords", "keywords: kwTexts()" in JS or "keywords: S.keywords" in JS)
check("建方案时带全局品牌名单", "rivals: S.rivals.slice()" in JS)

print("\n[9] 全局品牌名单的交互齐全")
for fn in ["kwTexts", "mineNames", "addRival", "renderRivals"]:
    check(f"函数 {fn}", re.search(r"function\s+" + fn + r"\s*\(", JS) is not None)
for el, label in [('id="rivalList"', "名单容器"), ('id="rivalInput"', "品牌输入框"),
                  ('id="f_brand"', "品牌名字段"), ('id="f_company"', "公司全称字段")]:
    check(label, el in HTML)
check("品牌输入回车添加", 'addRival' in JS and 'e.key === "Enter"' in JS)
check("品牌可单个删除", "data-rdel" in JS)
check("我方品牌有单独标记", "（我方）" in JS)
check("关键词可原地改名", "kw-text" in JS)

print("\n[10] 每个关键词单独填品牌的做法已移除")
check("脚本里没有 kw-brands 结构", "kw-brands" not in JS)
check("脚本里没有按词存品牌", "kwBrandsMap" not in JS)
check("页面不再提示按词填品牌", "每个词下面可以填" not in HTML)

print("\n[11] 关键词自由组合的界面")
check("前端不再调用分组预览（改成一篇一篇算）", '"/api/preview-groups"' not in JS)
for cls in ["task-plat", "task-plat-head", "task-row", "tr-idx"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)
check("编辑器显示覆盖词", 'id="edWords"' in HTML and "edWords" in JS)
check("稿件列表标注覆盖词数", "覆盖${(a.keywords || []).length}词" in JS)
check("篇数不再乘以关键词数", "perRound * Math.max" not in JS)
check("文案改成点一次自动连写的口径", "点一次自动一篇接一篇写完" in JS)
check("第二步也说明会自动连写", "开始后会一篇接一篇自动写" in JS)
for cls in ["tr-over", "task-tip"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[12] 一篇一篇写 + 流式界面")
for el, label in [('id="streamText"', "流式文本区"), ('id="streamChars"', "字数"),
                  ('id="writeDone"', "写完面板"), ('id="btnWriteNext"', "再写一篇"),
                  ('id="btnBackToSetup2"', "回第二步"), ('id="streamEmpty"', "等待提示")]:
    check(label, el in HTML)
check("旧的批量篇数选择已删除", 'id="batchSize"' not in HTML and "batchSize" not in JS)
check("旧的批次面板已删除", 'id="batchNext"' not in HTML and "btnNextBatch" not in JS)
check("旧的排布表已删除", 'id="taskTable"' not in HTML and "renderTaskTable" not in JS)
check("调用单篇接口", "/write-one" in JS)
check("用 EventSource 接流", "new EventSource" in JS)
check("收到 chunk 就渲染", 'd.type === "chunk"' in JS)
check("收到 end 收尾", 'd.type === "end"' in JS)
check("边写边滚动到底", "scrollTop = wrap.scrollHeight" in JS)
for cls in ["stream-box", "stream-text", "stream-empty", "stream-meta"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[13] 别名合并与品牌信息字段")
for el, label in [('id="aliasBox"', "别名面板"), ('id="aliasList"', "别名列表"),
                  ('id="btnApplyAlias"', "应用合并按钮"),
                  ('id="f_products"', "主营字段")]:
    check(label, el in HTML)
check("提交时带 aliases", "aliases: S.aliases.slice()" in JS)
check("预览分组带 aliases", "aliases: S.aliases" in JS)
check("关键词变化后自动检测别名", "scheduleAliasCheck" in JS and "detectAliases" in JS)
for cls in ["alias-box", "alias-row", "alias-txt", "alias-list"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)
check("官网字段只为官方号采集", 'id="f_website"' in HTML and "only official" not in HTML)
check("主营保留作写作背景", 'id="f_products"' in HTML)
check("目标读者字段已删除", 'f_audience' not in HTML and "f_audience" not in JS)
check("服务区域字段已删除", 'f_area"' not in HTML and "f_area" not in JS)
check("主营说明不再承诺单独列出", "不会在文末单独列出" in HTML)

print("\n[14] 深度思考开关与耗时提示")
check("设置里有开关", 'id="s_no_think"' in HTML)
check("保存时带上开关", 'disable_thinking: $("#s_no_think").checked' in JS)
check("回填开关状态", '$("#s_no_think").checked = s.disable_thinking !== false' in JS)
check("生成过程显示已写字数", 'streamChars").textContent' in JS)
check("样式 .check-row", ".check-row" in CSS)

print("\n[15] Word 导出按钮")
check("导出 Word 按钮存在", 'id="btnExportWord"' in HTML)
check("按钮走 docx 接口", 'exportPlan("docx")' in JS)
check("Markdown 导出保留", 'id="btnExportMd"' in HTML and 'exportPlan("md")' in JS)
check("历史记录导出也是 Word", "data-exp" in JS and "export?fmt=docx" in JS)
check("导出带上勾选的稿件 id", "ids=${ids.join" in JS)
check("没勾选时按钮不可点", "b.disabled = n === 0" in JS)

print("\n[16] 预览页的进度条与续写入口")
for el, label in [('id="progressBanner"', "进度条容器"), ('id="btnResume"', "继续写按钮"),
                  ('id="btnBackToSetup"', "回第二步按钮"), ('id="progressText"', "进度文案")]:
    check(label, el in HTML)
check("加载方案时刷新进度", "refreshProgress()" in JS)
check("显示已写/总数/剩余", "篇没写" in JS and "已全部写完" in JS)
check("续写走自动连写接口", 'startWrite(true, "auto")' in JS)
check("续写有独立入口", JS.count('startWrite(true, "auto")') >= 2,
      str(JS.count('startWrite(true, "auto")')))
check("开始生成也走自动连写", 'startWrite(false, "auto")' in JS)
check("保留只写一篇的入口", 'startWrite(true, "one")' in JS)
check("能回到第二步调整", "function gotoStep2" in JS)
for cls in ["progress-banner"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[17] 补充说明只有一个入口")
check("有统一的补充说明输入框", 'id="f_note"' in HTML)
for gone in ("f_topic", "f_tone", "f_points", "f_extra"):
    check(f"{gone} 已删除", gone not in HTML and gone not in JS)
check("收集时带上 note", 'note: $("#f_note").value.trim()' in JS)
check("老方案的分段内容会拼回", "legacyNote" in JS and "b.topic, b.points, b.extra" in JS)
check("输入框是整段描述", "<textarea id=\"f_note\"" in HTML)

print("\n[18] 官方号 / 个人号分区，各自设篇数")
check("卡片上官方/个人各一行", "官方号" in JS and "个人号" in JS and "pt-row" in JS)
check("每行都有 0-20 的数字输入", 'data-count="${at}"' in JS and "MAX_PER_GROUP = 20" in JS)
check("加减按钮不会误触发选中", 'e.target.closest("[data-step]")' in JS)
check("选中时默认个人号 1 篇", 'S.platformSel[p.id] = { official: 0, personal: 1 }' in JS)
check("两个都是 0 篇会提示", "两个都是 0 篇" in JS)
check("汇总里给总篇数", "共 ${total} 篇" in JS)
check("提交时带 account_type", 'account_type: "official"' in JS and 'account_type: "personal"' in JS)
check("默认取平台的 account_type", "p && p.account_type" in JS)
check("状态里有 platformTypes", "platformTypes: {}" in JS)
check("提交时带上 platform_types", "platform_types:" in JS)
check("回填时恢复类型", "b.platform_types" in JS)
check("回填兼容老的 count 结构", "cur[at] = Math.min(MAX_PER_GROUP" in JS)
for f in ("f_website", "f_phone", "f_address"):
    check(f"{f} 字段存在", f'id="{f}"' in HTML)
check("官网注明只有官方号会写", "只有官方号会写" in HTML)
for cls in ["pc-type", "pt-btn", "pt-hint"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[19] 每个按钮都接上了真接口")
check("平台行有保存按钮", 'data-save="${p.id}"' in JS)
check("平台保存会调 PUT", 'api("/api/platforms/" + b.dataset.save, "PUT"' in JS)
check("平台删除调 DELETE", 'api("/api/platforms/" + b.dataset.del, "DELETE"' in JS)
check("模型删除调 DELETE", 'api("/api/models/" + b.dataset.del, "DELETE"' in JS)
check("风险删除调 DELETE", 'api("/api/risks/" + b.dataset.rid, "DELETE"' in JS)
check("资料删除后会同步", "await syncMaterials()" in JS)
check("资料编辑后会同步", JS.count("await syncMaterials()") >= 3)
check("资料同步抽成公共函数", "function materialItems" in JS and "function syncMaterials" in JS)

print("\n[20] 风险自查结果要看得见")
check("稿件页有自查区块", 'id="riskNotesBox"' in HTML)
check("自查列表容器", 'id="riskNotes"' in HTML)
check("渲染时填充自查", "a.risk_tips" in JS or "(a && a.risk_tips)" in JS)
check("没有自查时收起", 'riskNotesBox").classList.toggle("hidden"' in JS)
check("清单区说明已改为硬约束口径", "硬性约束" in HTML)

print("\n[21] 事实核查的界面")
for el, label in [('id="auditBox"', "核查区块"), ('id="auditList"', "问题清单"),
                  ('id="btnAuditAgain"', "再核一次"), ('id="btnRestore"', "还原按钮"),
                  ('id="auditBadge"', "结论标记")]:
    check(label, el in HTML)
check("切稿件时渲染核查", "renderAudit(a)" in JS)
check("调核查接口", "/audit" in JS)
check("调还原接口", "/restore" in JS)
check("没有核查记录时收起", "if (!au.at)" in JS and 'box.classList.add("hidden")' in JS)
check("写作过程能显示核查阶段", 'd.phase === "audit"' in JS)
check("写完面板带核查结论", "事实核查：" in JS)
for cls in ["audit-list", "audit-item", "audit-q", "audit-why", "audit-fix"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[22] 自动连写的界面")
for el, label in [('id="autoBar"', "进度条容器"), ('id="autoFill"', "进度条"),
                  ('id="autoText"', "进度文案"), ('id="btnPause"', "暂停按钮"),
                  ('id="doneList"', "已完成列表"), ('id="doneItems"', "已完成条目"),
                  ('id="btnContinue"', "继续写完按钮")]:
    check(label, el in HTML)
check("开始后走 auto 接口", "/auto`" in JS)
check("暂停调 stop 接口", "/stop" in JS)
check("暂停在当前篇写完后生效", "这一篇写完后停下" in JS)
check("每篇切换时刷新标题", '"next"' in JS and "pushDoneItem(d.prev)" in JS)
check("进度条按已完成比例走", "setAutoBar" in JS and 'autoFill").style.width' in JS)
check("结束后可以继续补写", "继续写剩下的" in JS)
check("暂停后有明确落点", '"paused"' in JS)
for cls in ["auto-bar", "auto-progress", "done-list", "done-item"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[23] 勾选导出的界面")
check("清单每篇有勾选框", 'class="art-ck"' in JS)
check("默认全选，用「取消勾选」记反选", "unpicked: new Set()" in JS)
check("有已选计数", 'id="pickCount"' in HTML)
for el, label in [('id="btnPickAll"', "全选"), ('id="btnPickNone"', "全不选"),
                  ('id="btnPickGood"', "只留高分")]:
    check(label, el in HTML)
check("勾选框点击不会串到选中稿件", 'ev.target.classList.contains("art-ck")' in JS)
check("导出只取勾中的", "function pickedIds" in JS)
check("换方案时重置勾选", "switched) S.unpicked = new Set()" in JS)
check("按钮上显示篇数", '导出所选 Word（${n} 篇）' in JS)
for cls in ["pick-bar", "pick-count", "link-btn"]:
    check(f"样式 .{cls}", ("." + cls) in CSS)

print("\n[24] 平台名与账号类型各管一件事")
check("卡片标题只渲染平台名", '<span class="pc-name">${esc(p.name)}<em class="pc-tag">' in JS)
check("卡片标出默认号种", '默认${isOff ? "官方号" : "个人号"}' in JS)
check("点选时按默认号种先给 1 篇", 'at0 === "official"' in JS)
check("设置行有账号类型下拉", 'class="a-type"' in JS)
check("保存时把类型一起提交", 'account_type: row.querySelector(".a-type").value' in JS)
check("新增平台也能选类型", 'id="new_plat_type"' in HTML and '$("#new_plat_type").value' in JS)
check("卡片标签样式", ".plat-card .pc-tag" in CSS)
check("类型下拉样式", ".admin-row select" in CSS)
check("设置页提示名称不带后缀", "平台名只写平台本身" in HTML)
check("顶栏显示端口与启动时间", 'id="srvInfo"' in HTML and "renderServerInfo" in JS)
check("样式 .srv-info", ".srv-info" in CSS)

print("\n[25] 预览页能退回写稿页 + 标题前缀开关")
check("第四步有「回到自动写稿」按钮", 'id="btnBackToWrite"' in HTML)
check("返回按钮走 goStep(3)", '$("#btnBackToWrite").onclick' in JS and "goStep(3)" in JS)
check("返回时提示写稿没停", "写稿没有停" in JS)
check("设置里有出稿偏好标签", 'data-tab="writing"' in HTML and 'data-pane="writing"' in HTML)
check("标题前缀开关存在", 'id="s_title_prefix"' in HTML)
check("开关状态回填", '$("#s_title_prefix").checked = s.title_prefix !== false' in JS)
check("开关改动立即保存", "title_prefix: want" in JS)

print("\n" + "=" * 46)
print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
if failed:
    for n, d in failed:
        print("  失败：" + n + ("  " + d if d else ""))
    print("结果：不通过")
    sys.exit(1)
print("结果：全部通过")
