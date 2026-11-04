# -*- coding: utf-8 -*-
"""二次核查（事实核查）的测试。

覆盖：提示词有没有把资料带进去 → 正常改写并保留原文 → 无需修改 → 大幅删减不替换
      → 没给修订版 → 返回坏 JSON → 没资料时的提示

用法：python tools/test_audit.py
"""

import json
import os
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from app import generator, llm, prompts, store as st  # noqa: E402

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name +
          (("  -> " + detail) if detail and not ok else ""))


ART = """# 橡胶粘接怎么选

西邦的单涂型方案耐温 300℃，可以用 5 年。

## 判断标准

看基材和温度，除油是前提。

## 常见问题

### 单涂和双涂怎么选？

单涂省一道工序。

#橡胶粘接 #西邦 #单涂型 #热硫化 #选型

声明：含AI生成内容
"""


def make_store():
    tmp = tempfile.mkdtemp()
    S = st.Store(os.path.join(tmp, "t.db"))
    pid = S.create_plan("橡胶粘接", "测试方案",
                        {"keywords": ["橡胶粘接"], "brand": "西邦",
                         "note": "重点讲单涂工艺，不要提价格"})
    S.add_material(pid, "产品介绍.txt", "纯文本",
                   "西邦热硫化粘合剂，单涂型，适用于橡胶与金属粘接。耐温 300℃。")
    aid = S.add_article(
        pid, platform_id=1, platform_name="搜狐个人号", fmt="图文", model_name="m",
        angle="疑问型", keyword="橡胶粘接", keywords=["橡胶粘接"],
        title="橡胶粘接怎么选", body_md=ART, tags=["#橡胶粘接"],
        decl=["含AI生成内容"], risk_tips=["第1条：已规避", "第2条：已规避", "第3条：已规避"],
        geo={"score": 90, "checks": [], "chars": len(ART)})
    return S, pid, aid


def fake_llm(reply):
    """把 chat_with_retry 换成一个固定回包。"""
    def _call(messages, settings, **kw):
        if isinstance(reply, Exception):
            raise reply
        return reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
    return _call


def main():
    real_chat = llm.chat_with_retry

    print("\n[1] 提示词把资料和补充说明都带上了")
    S, pid, aid = make_store()
    art = S.get_article(aid)
    mats = prompts.build_materials_text(S.list_materials(pid), budget=20000)
    msgs = prompts.build_audit(art["body_md"], mats, "重点讲单涂工艺，不要提价格")
    check("系统提示是核查员角色", "事实核查员" in msgs[0]["content"])
    check("带上客户资料", "耐温 300℃" in msgs[1]["content"])
    check("带上补充说明", "不要提价格" in msgs[1]["content"])
    check("带上待核查正文", art["title"] in msgs[1]["content"])
    check("明确要求保留有依据的数字", "有资料支撑的数字必须原样保留" in msgs[0]["content"])
    check("明确要求不要过度修改", "不要过度修改" in msgs[0]["content"])
    check("要求输出 findings 和 revised_body",
          "revised_body" in msgs[1]["content"] and "findings" in msgs[1]["content"])
    check("没有资料时也给出说明",
          "客户没有提供资料" in prompts.build_audit(ART, "", "")[1]["content"])

    print("\n[2] 正常核查：挑出无依据的数字并改写")
    revised = ART.replace("可以用 5 年", "可以长期使用")
    llm.chat_with_retry = fake_llm({
        "findings": [{"quote": "可以用 5 年", "kind": "无依据",
                      "why": "客户资料里没有使用年限", "revised": "可以长期使用"}],
        "revised_body": revised, "verdict": "revised"})
    try:
        r = generator.audit_article(S, S.get_settings(), aid)
    finally:
        llm.chat_with_retry = real_chat
    check("核查成功", r.get("ok"), str(r)[:120])
    check("找到 1 处问题", r.get("count") == 1, str(r.get("count")))
    check("问题里带原文", r["findings"][0]["quote"] == "可以用 5 年")
    check("判定为无依据", r["findings"][0]["kind"] == "无依据")
    check("已应用修改", r.get("applied") is True, str(r.get("reason")))
    after = S.get_article(aid)
    check("正文已替换", "可以长期使用" in after["body_md"])
    check("没依据的数字被去掉", "可以用 5 年" not in after["body_md"])
    check("有依据的 300℃ 还在", "300℃" in after["body_md"])
    check("保留了核查前原文", after["body_original"].strip() == ART.strip(),
          str(len(after.get("body_original") or "")))
    check("audit 落库", after["audit"].get("count") == 1)
    check("正文结构没被破坏", after["body_md"].count("## ") == ART.count("## "))
    check("标签和声明还在", "#橡胶粘接" in after["body_md"] and "声明：" in after["body_md"])

    print("\n[3] 无需修改的情形")
    S2, pid2, aid2 = make_store()
    llm.chat_with_retry = fake_llm({"findings": [], "revised_body": ART, "verdict": "clean"})
    try:
        r2 = generator.audit_article(S2, S2.get_settings(), aid2)
    finally:
        llm.chat_with_retry = real_chat
    check("判定无需修改", r2.get("applied") is False and "无需修改" in r2.get("reason", ""),
          str(r2.get("reason")))
    check("正文一个字没动", S2.get_article(aid2)["body_md"] == ART)
    check("没有留下原文快照", not S2.get_article(aid2)["body_original"])

    print("\n[4] 安全阀：模型把文章砍太多，不替换")
    S3, pid3, aid3 = make_store()
    llm.chat_with_retry = fake_llm({
        "findings": [{"quote": "可以用 5 年", "kind": "无依据", "why": "无", "revised": ""}],
        "revised_body": "# 橡胶粘接怎么选\n\n短短几句。", "verdict": "revised"})
    try:
        r3 = generator.audit_article(S3, S3.get_settings(), aid3)
    finally:
        llm.chat_with_retry = real_chat
    check("判定不替换", r3.get("applied") is False, str(r3.get("reason")))
    check("说明原因是删太多", "少了三成" in r3.get("reason", ""), r3.get("reason", ""))
    check("正文保持原样", S3.get_article(aid3)["body_md"] == ART)
    check("保留了问题清单", r3.get("count") == 1)
    check("留了修订版预览", "revised_preview" in r3)

    print("\n[5] 模型没给修订版")
    S4, pid4, aid4 = make_store()
    llm.chat_with_retry = fake_llm({
        "findings": [{"quote": "可以用 5 年", "kind": "无依据", "why": "无", "revised": ""}],
        "revised_body": "", "verdict": "revised"})
    try:
        r4 = generator.audit_article(S4, S4.get_settings(), aid4)
    finally:
        llm.chat_with_retry = real_chat
    check("不替换正文", r4.get("applied") is False)
    check("说明没给修订版", "没给修订版" in r4.get("reason", ""), r4.get("reason", ""))
    check("原正文还在", S4.get_article(aid4)["body_md"] == ART)

    print("\n[6] 异常情况")
    S5, pid5, aid5 = make_store()
    llm.chat_with_retry = fake_llm("这不是 JSON，只是一段话")
    try:
        r5 = generator.audit_article(S5, S5.get_settings(), aid5)
    finally:
        llm.chat_with_retry = real_chat
    check("坏 JSON 不崩", isinstance(r5, dict), str(r5)[:120])
    check("原正文没被破坏", S5.get_article(aid5)["body_md"] == ART)

    llm.chat_with_retry = fake_llm(llm.LLMError("接口炸了", "server"))
    try:
        generator.audit_article(S5, S5.get_settings(), aid5)
        raised = False
    except llm.LLMError:
        raised = True
    finally:
        llm.chat_with_retry = real_chat
    check("接口异常向外抛（由上层兜住，不吞）", raised)
    check("异常后正文仍是原文", S5.get_article(aid5)["body_md"] == ART)

    check("稿件不存在时给明确错误",
          generator.audit_article(S5, S5.get_settings(), 99999).get("ok") is False)

    print("\n[7] 还原：拿回核查前的版本")
    S6, pid6, aid6 = make_store()
    llm.chat_with_retry = fake_llm({
        "findings": [{"quote": "可以用 5 年", "kind": "无依据", "why": "无",
                      "revised": "可以长期使用"}],
        "revised_body": ART.replace("可以用 5 年", "可以长期使用"), "verdict": "revised"})
    try:
        generator.audit_article(S6, S6.get_settings(), aid6)
    finally:
        llm.chat_with_retry = real_chat
    a6 = S6.get_article(aid6)
    check("核查后正文变了", "长期使用" in a6["body_md"])
    S6.update_article(aid6, body_md=a6["body_original"], body_original="", audit={})
    back = S6.get_article(aid6)
    check("还原后回到原文", back["body_md"].strip() == ART.strip())
    check("还原后清掉快照", not back["body_original"])
    check("还原后清掉核查记录", back["audit"] == {})

    print("\n" + "=" * 46)
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        print("  失败：" + "、".join(n for n, _ in failed))
        print("结果：不通过")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
