# -*- coding: utf-8 -*-
"""官方号 / 个人号分区的测试：类型判定、提示词分叉、自检差异。"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from app import generator, prompts, render, seeds  # noqa: E402

passed, failed = [], []


def check(name, cond, extra=""):
    if cond:
        passed.append(name)
        print(f"  [通过] {name}")
    else:
        failed.append(name)
        print(f"  [失败] {name}" + (f"  -> {extra}" if extra else ""))


PLAT_O = {"id": 1, "name": "抖音企业号", "account_type": "official",
          "style": "口语化", "length_hint": "300-600 字", "structure_hint": "钩子→要点→收尾",
          "audience": "刷短视频的人", "formats": ["图文"]}
PLAT_P = {"id": 2, "name": "知乎个人号", "account_type": "personal",
          "style": "第一人称", "length_hint": "1200-2000 字", "structure_hint": "先判断后理由",
          "audience": "带问题来找答案的人", "formats": ["图文"]}
BRIEF = {"brand": "西邦", "company": "三洋物产贸易（上海）有限公司",
         "website": "cilbond.cn", "phone": "400-123-4567",
         "address": "上海市嘉定区××路 88 号", "keywords": ["橡胶粘接"]}


def main():
    print("\n[1] 平台默认类型")
    names = {p["name"]: p.get("account_type") for p in seeds.PLATFORMS}
    check("抖音默认是官方号", names.get("抖音") == "official", str(names))
    check("其余 5 个是个人号",
          all(v == "personal" for k, v in names.items() if k != "抖音"), str(names))
    check("平台名不含账号类型后缀",
          all(not any(k in n for k in ("企业号", "个人号", "官方号", "机构号")) for n in names),
          str(list(names)))
    check("按名字推断：企业号 → 官方", seeds.guess_account_type("搜狐企业号") == "official")
    check("按名字推断：机构号 → 官方", seeds.guess_account_type("知乎机构号") == "official")
    check("按名字推断：个人号 → 个人", seeds.guess_account_type("头条个人号") == "personal")
    check("没有关键字时算个人号", seeds.guess_account_type("小红书") == "personal")
    check("名字带后缀时拆出平台名与类型",
          seeds.split_platform_name("抖音企业号") == ("抖音", "official"),
          str(seeds.split_platform_name("抖音企业号")))
    check("「百家号个人号」不会把「号」误剥",
          seeds.split_platform_name("百家号个人号") == ("百家号", "personal"),
          str(seeds.split_platform_name("百家号个人号")))
    check("没有后缀时不擅自指定类型",
          seeds.split_platform_name("小红书") == ("小红书", None))
    check("名称本身就是后缀时不剥成空",
          seeds.split_platform_name("个人号") == ("个人号", None),
          str(seeds.split_platform_name("个人号")))

    print("\n[2] 方案里的选择优先于平台默认")
    check("抖音默认官方", generator.account_type_of(PLAT_O) == "official")
    check("方案改成个人号", generator.account_type_of(
        PLAT_O, {"platform_types": {"1": "personal"}}) == "personal")
    check("整数键也能识别", generator.account_type_of(
        PLAT_O, {"platform_types": {1: "personal"}}) == "personal")
    check("方案改成官方号", generator.account_type_of(
        PLAT_P, {"platform_types": {"2": "official"}}) == "official")
    check("方案没选就回落到平台默认", generator.account_type_of(
        PLAT_P, {"platform_types": {}}) == "personal")
    check("非法值被忽略", generator.account_type_of(
        PLAT_O, {"platform_types": {"1": "瞎写"}}) == "official")

    print("\n[3] 系统提示词分叉")
    sys_o = prompts.build_system(PLAT_O, [], "high", "橡胶粘接", "西邦",
                                 "三洋物产贸易（上海）有限公司", account_type="official")
    sys_p = prompts.build_system(PLAT_P, [], "high", "橡胶粘接", "西邦",
                                 "三洋物产贸易（上海）有限公司", account_type="personal")
    check("官方号写明可写官网电话地址",
          "官网域名" in sys_o and "400 客服电话" in sys_o and "公司地址" in sys_o)
    check("官方号要求自然带出、不单独成节", "不要单独列成一节" in sys_o)
    check("官方号仍禁个人手机号微信",
          "个人手机号" in sys_o and "微信" in sys_o)
    check("个人号写明不出现官网电话邮箱", "不出现官网域名、电话、邮箱、公司地址" in sys_p)
    check("个人号不承诺可写联系方式", "可以写：官网域名" not in sys_p)
    check("默认不传参数就是个人号",
          "账号类型：个人号" in prompts.build_system(PLAT_P, [], "mid", "k"))

    print("\n[4] 单篇提示词给不给官方信息")
    user_o = prompts.build_user(BRIEF, PLAT_O, prompts.ANGLES[0], "图文", [], "新手",
                                1, 1, keyword="橡胶粘接", account_type="official")
    user_p = prompts.build_user(BRIEF, PLAT_P, prompts.ANGLES[0], "图文", [], "新手",
                                1, 1, keyword="橡胶粘接", account_type="personal")
    check("官方号带上官网", "cilbond.cn" in user_o)
    check("官方号带上电话", "400-123-4567" in user_o)
    check("官方号带上地址", "上海市嘉定区" in user_o)
    check("官方号说明写几次", "2-3 次" in user_o)
    check("个人号完全不带官网", "cilbond.cn" not in user_p, user_p[:80])
    check("个人号完全不带电话", "400-123-4567" not in user_p)
    check("个人号完全不带地址", "上海市嘉定区" not in user_p)

    empty_o = prompts.build_user({"brand": "X", "keywords": ["k"]}, PLAT_O, prompts.ANGLES[0],
                                 "图文", [], "新手", 1, 1, keyword="k", account_type="official")
    check("官方号没填联系方式时不硬塞", "可用的官方信息" not in empty_o)

    print("\n[5] 自检按类型判定")
    body_o = ("# 橡胶粘接怎么选\n\n西邦的单涂型方案适合热硫化工艺。参数表在官网 cilbond.cn 上，"
              "客服 400-123-4567 可以问到具体型号。售后网点覆盖华东，地址在上海市嘉定区。\n\n"
              "## 判断标准\n\n看基材和温度。\n\n#橡胶粘接 #西邦 #单涂型 #热硫化 #选型\n\n声明：含AI生成内容")
    art_o = {"title": "橡胶粘接怎么选", "body_md": body_o, "tags": ["#a"] * 5,
             "decl": ["含AI生成内容"]}
    g_o = {c["name"]: c for c in render.geo_check(
        art_o, "橡胶粘接", "西邦", [], [], account_type="official")["checks"]}
    check("官方号：官方信息已带出", g_o["官方信息已带出"]["ok"])
    check("官方号：不检查「未出现官方联系方式」", "未出现官方联系方式" not in g_o)
    check("官方号：没有私人导流", g_o["无导流信息"]["ok"])

    g_p = {c["name"]: c for c in render.geo_check(
        art_o, "橡胶粘接", "西邦", [], [], account_type="personal")["checks"]}
    check("个人号：判定出现了官方联系方式", not g_p["未出现官方联系方式"]["ok"])
    check("个人号：提示说清命中什么",
          "官网域名" in g_p["未出现官方联系方式"]["hint"], g_p["未出现官方联系方式"]["hint"])

    print("\n[6] 官方号也不能写微信号和个人手机号")
    bad = ("# 橡胶粘接怎么选\n\n西邦的方案不错，加我微信 xb2024，或者打 13812345678。\n\n"
           "## 判断\n\n看基材。\n\n#a #b #c #d #e\n\n声明：含AI生成内容")
    g_bad = {c["name"]: c for c in render.geo_check(
        {"title": "橡胶粘接怎么选", "body_md": bad, "tags": ["#a"] * 5, "decl": ["声明"]},
        "橡胶粘接", "西邦", [], [], account_type="official")["checks"]}
    check("官方号仍拦微信", not g_bad["无导流信息"]["ok"], g_bad["无导流信息"]["hint"])
    check("提示里点出命中类型", "导流" in g_bad["无导流信息"]["hint"])

    print("\n[7] 个人号没写联系方式时不算问题")
    plain = ("# 橡胶粘接怎么选\n\n西邦的单涂型方案适合热硫化工艺。\n\n## 判断标准\n\n看基材和温度。\n\n"
             "#橡胶粘接 #西邦 #单涂型 #热硫化 #选型\n\n声明：含AI生成内容")
    g_plain = {c["name"]: c for c in render.geo_check(
        {"title": "橡胶粘接怎么选", "body_md": plain, "tags": ["#a"] * 5, "decl": ["声明"]},
        "橡胶粘接", "西邦", [], [], account_type="personal")["checks"]}
    check("个人号：没有联系方式就是通过", g_plain["未出现官方联系方式"]["ok"])
    check("个人号：不要求官方信息", "官方信息已带出" not in g_plain)

    print("\n[8] 品牌露出上限按类型区分")
    many = ("# 橡胶粘接怎么选\n\n" + "西邦" * 7 + " 的方案。\n\n" +
            "## 判断\n\n看基材。\n\n#a #b #c #d #e\n\n声明：含AI生成内容")
    art_many = {"title": "橡胶粘接怎么选", "body_md": many, "tags": ["#a"] * 5, "decl": ["声明"]}
    cnt = many.count("西邦")
    gp = {c["name"]: c for c in render.geo_check(
        art_many, "橡胶粘接", "西邦", [], [], account_type="personal")["checks"]}
    go = {c["name"]: c for c in render.geo_check(
        art_many, "橡胶粘接", "西邦", [], [], account_type="official")["checks"]}
    check("个人号上限更严", cnt > 6 and not gp["品牌露出适度"]["ok"], f"出现 {cnt} 次")
    check("官方号上限放宽到 8", cnt <= 8 and go["品牌露出适度"]["ok"], f"出现 {cnt} 次")

    print("\n[9] 老库的平台名后缀迁移成 account_type")
    import tempfile
    from app.store import Store
    tmp = Path(tempfile.mkdtemp()) / "geo.db"
    s1 = Store(tmp)
    with s1.conn() as c:
        c.execute("UPDATE platforms SET name='抖音企业号' WHERE name='抖音'")
        c.execute("UPDATE platforms SET name='百家号个人号' WHERE name='百家号'")
        c.execute("DELETE FROM meta WHERE k='platform_norm_v1'")
        pid = c.execute("SELECT id FROM platforms WHERE name='抖音企业号'").fetchone()["id"]
        c.execute("INSERT INTO articles(plan_id,platform_id,platform_name,title,body_md,"
                  "tags,decl,sort) VALUES(?,?,?,?,?,?,?,0)",
                  (1, pid, "抖音企业号", "老稿", "正文", "[]", "[]"))
    s2 = Store(tmp)
    ps = {p["name"]: p for p in s2.list_platforms()}
    check("名字去掉「企业号」", "抖音" in ps and "抖音企业号" not in ps, str(list(ps)))
    check("类型落成官方号", ps.get("抖音", {}).get("account_type") == "official")
    check("「百家号个人号」收敛成「百家号」", "百家号" in ps, str(list(ps)))
    with s2.conn() as c:
        row = c.execute("SELECT platform_name FROM articles ORDER BY id DESC LIMIT 1").fetchone()
        mark = c.execute("SELECT COUNT(*) FROM meta WHERE k='platform_norm_v1'").fetchone()[0]
    check("历史稿件的平台名同步", row["platform_name"] == "抖音", str(row["platform_name"]))
    check("迁移留了标记，不会反复跑", mark == 1)

    print("\n[10] 标题前缀【平台 + 号种】")
    from app import render as _r
    check("官方号前缀", _r.title_prefix("抖音", "official") == "【抖音官方号】")
    check("个人号前缀", _r.title_prefix("知乎", "personal") == "【知乎个人号】")
    check("加前缀", _r.apply_title_prefix("橡胶胶水怎么选", "抖音", "official")
          == "【抖音官方号】橡胶胶水怎么选")
    check("已有前缀不会重复",
          _r.apply_title_prefix("【抖音官方号】橡胶胶水怎么选", "抖音", "official")
          == "【抖音官方号】橡胶胶水怎么选")
    check("换平台时旧前缀被替换",
          _r.apply_title_prefix("【知乎个人号】橡胶胶水怎么选", "抖音", "official")
          == "【抖音官方号】橡胶胶水怎么选")
    check("正文中间的【】不动", _r.strip_title_prefix("橡胶【A】粘接") == "橡胶【A】粘接")

    pf = {"id": 1, "name": "抖音", "account_type": "official", "formats": ["图文"],
          "style": "口语", "length_hint": "300-600 字", "structure_hint": "钩子", "audience": "普通人"}
    br = {"keyword": "橡胶粘接", "brand": "西邦", "keywords": ["橡胶粘接"]}
    ang = {"name": "疑问型"}
    raw = {"title": "橡胶粘接怎么选", "summary": "先看基材", "tags": ["#a"], "declarations": [],
           "sections": [{"heading": "怎么判断", "paragraphs": ["看基材。"]}]}

    def _mk(on):
        import copy
        return generator._finalize(copy.deepcopy(raw), br, pf, ang, "图文",
                                   {"model": "m", "title_prefix": on}, "橡胶粘接")

    on_art = _mk(True)
    check("标题带前缀", on_art["title"] == "【抖音官方号】橡胶粘接怎么选", on_art["title"])
    check("正文首行 H1 也带前缀", on_art["body_md"].startswith("# 【抖音官方号】"),
          on_art["body_md"][:30])
    off_art = _mk(False)
    check("开关关闭时标题不加前缀", off_art["title"] == "橡胶粘接怎么选", off_art["title"])
    check("开关关闭时正文首行也不加", off_art["body_md"].startswith("# 橡胶粘接怎么选"))

    plan = {"title": "方案", "keyword": "橡胶粘接", "brief": {}, "materials": [],
            "articles": [{"title": "【抖音官方号】橡胶粘接怎么选",
                          "body_md": "# 【抖音官方号】橡胶粘接怎么选\n\n正文",
                          "platform_name": "抖音", "angle": "疑问型", "fmt": "图文",
                          "keywords": ["橡胶粘接"]}]}
    sp = _r.strip_plan_prefix(plan)
    check("导出时标题去掉前缀", sp["articles"][0]["title"] == "橡胶粘接怎么选")
    check("导出时正文 H1 去掉前缀", sp["articles"][0]["body_md"].startswith("# 橡胶粘接怎么选"))
    check("剥离不改动原方案", plan["articles"][0]["title"] == "【抖音官方号】橡胶粘接怎么选")

    print("\n" + "=" * 46)
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
    if failed:
        print("  失败：" + "、".join(failed))
        print("结果：不通过")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
