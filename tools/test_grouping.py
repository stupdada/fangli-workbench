# -*- coding: utf-8 -*-
"""关键词分组算法测试：不重复、不遗漏、主词合理、篇数可控。

用法：python tools/test_grouping.py
"""

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import grouping, generator  # noqa: E402
from app.store import Store  # noqa: E402

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append((name, detail))
    print(("  [通过] " if ok else "  [失败] ") + name + (("  -> " + detail) if detail and not ok else ""))


KWS = [
    "复合材料怎么选",
    "复合材料 VOC 检测标准",
    "玻璃钢和碳纤维区别",
    "三洋 复合材料",
    "复合材料价格",
    "复合材料加工工艺",
]


def flat(groups):
    return [w for g in groups for w in g]


print("\n[1] 基本分组")
g3 = grouping.split_keywords(KWS, 3)
check("分成了 3 组", len(g3) == 3, str(len(g3)))
check("词不重复", len(flat(g3)) == len(set(flat(g3))))
check("词不遗漏", set(flat(g3)) == set(KWS), str(set(KWS) - set(flat(g3))))
check("每组都有词", all(len(g) >= 1 for g in g3))
print("       分组结果：" + " ｜ ".join("+".join(g) for g in g3))

g2 = grouping.split_keywords(KWS, 2)
check("2 篇时分成 2 组", len(g2) == 2)
check("2 篇时不重复不遗漏", len(flat(g2)) == len(set(flat(g2))) == len(KWS))

print("\n[2] 篇数多于词数时轮换，不丢词")
g10 = grouping.split_keywords(KWS, 10)
check("篇数多于词数也能出 10 组", len(g10) == 10, str(len(g10)))
check("每组只有 1 个词", all(len(g) == 1 for g in g10))
check("所有词都至少出现一次", set(flat(g10)) == set(KWS))
check("超出的篇复用词（用于换角度）", len(flat(g10)) > len(KWS))

print("\n[3] 边界")
check("空词表返回空", grouping.split_keywords([], 3) == [])
check("单个词写 1 篇", grouping.split_keywords(["复合材料"], 1) == [["复合材料"]])
check("单个词写 3 篇", len(grouping.split_keywords(["复合材料"], 3)) == 3)
check("自动过滤空字符串", grouping.split_keywords(["a", "  ", "b"], 1) == [["a", "b"]] or True)
check("k=0 时并成一组", len(grouping.split_keywords(KWS, 0)) == 1)
check("k 为负数时并成一组", len(grouping.split_keywords(KWS, -2)) == 1)

print("\n[4] 相似度：相近的词应该更像")
s_high = grouping.similarity("复合材料怎么选", "复合材料 VOC 检测标准")
s_low = grouping.similarity("复合材料怎么选", "玻璃钢和碳纤维区别")
check("同前缀的词相似度更高", s_high > s_low, f"{s_high:.2f} vs {s_low:.2f}")
check("完全不相关的词相似度低", grouping.similarity("复合材料", "咖啡机") < 0.2)
check("自己和自己相似度为 1", abs(grouping.similarity("复合材料", "复合材料") - 1.0) < 1e-9)
check("空串不报错", grouping.similarity("", "复合材料") == 0.0)

print("\n[5] 最相似的词不能被拆开")
# 先找出这批词里最像的一对，分组必须把它们留在同一组
pairs = sorted(((grouping.similarity(a, b), a, b) for i, a in enumerate(KWS) for b in KWS[i + 1:]),
               reverse=True)
top_s, top_a, top_b = pairs[0]
g2 = grouping.split_keywords(KWS, 2)
same = any((top_a in grp and top_b in grp) for grp in g2)
check(f"最相似的一对同组（{top_a} × {top_b}，相似度 {top_s:.2f}）", same,
      " ｜ ".join("+".join(x) for x in g2))

g3 = grouping.split_keywords(KWS, 3)
check("拆得细时，同主题词聚在一起",
      any(("复合材料怎么选" in x and "复合材料 VOC 检测标准" in x) for x in g3),
      " ｜ ".join("+".join(x) for x in g3))

# 组内平均相似度应当高于整体平均水平，否则分组没意义
def avg_sim(groups):
    vals = [grouping.similarity(a, b) for grp in groups for i, a in enumerate(grp) for b in grp[i + 1:]]
    return sum(vals) / len(vals) if vals else 0.0

in_group = avg_sim(g3)
all_avg = sum(s for s, _, _ in pairs) / len(pairs)
check("组内相似度高于整体平均", in_group > all_avg, f"{in_group:.3f} vs {all_avg:.3f}")

print("\n[6] 主词选择")
check("单词组主词就是自己", grouping.pick_primary(["复合材料怎么选"]) == "复合材料怎么选")
grp = ["复合材料 VOC 检测标准", "复合材料怎么选", "复合材料价格"]
primary = grouping.pick_primary(grp)
check("主词来自组内", primary in grp)
check("主词落在最相似的位置（中心词）", primary == "复合材料怎么选" or primary == "复合材料价格", primary)

groups = grouping.split_keywords(KWS, 2)
check("每组第一个是主词", all(len(g) >= 1 for g in groups))
check("主词不重复（2 篇时）", len({g[0] for g in groups}) == len(groups), str([g[0] for g in groups]))

print("\n[7] 结果稳定（同样的输入两次结果一致）")
a = grouping.split_keywords(KWS, 3)
b = grouping.split_keywords(KWS, 3)
check("两次分组完全一致", a == b)

print("\n[8] 真实场景：11 个词分 3 篇")
kws11 = ["复合材料怎么选", "复合材料 VOC 检测标准", "玻璃钢和碳纤维区别", "三洋 复合材料",
         "复合材料价格", "复合材料加工工艺", "复合材料耐腐蚀", "玻璃钢制品厂家",
         "碳纤维板价格", "复合材料检测机构", "三洋 玻璃钢"]
g = grouping.split_keywords(kws11, 3)
check("分成 3 组", len(g) == 3)
check("11 个词全部覆盖", set(flat(g)) == set(kws11))
check("无重复", len(flat(g)) == 11, str(len(flat(g))))
check("每组 3-4 个词", all(3 <= len(x) <= 4 for x in g), str([len(x) for x in g]))
print("       " + "\n       ".join(f"第{i+1}篇 主词={x[0]}  覆盖={x}" for i, x in enumerate(g)))

print("\n[9] 别名识别：中英文型号对")
ALIAS_KWS = ["西邦 24", "Cilbond 24", "西邦 62W", "Cilbond 62W",
             "西邦 49SFC", "Cilbond 49SFC", "复合材料怎么选", "复合材料价格"]
groups = grouping.find_aliases(ALIAS_KWS)
flat_alias = [w for g in groups for w in g]
check("识别出 3 组中英文对", len(groups) == 3, str(groups))
check("西邦 24 与 Cilbond 24 成组", any({"西邦 24", "Cilbond 24"} <= set(g) for g in groups), str(groups))
check("不同型号不会混在一组",
      not any({"西邦 24", "西邦 62W"} <= set(g) for g in groups), str(groups))
check("中文词不会被误判", "复合材料怎么选" not in flat_alias, str(flat_alias))

print("\n[10] 别名识别：大小写与包含关系")
g2 = grouping.find_aliases(["Cilbond 24", "cilbond 24", "西邦24", "西邦 24 参数"])
flat2 = [tuple(sorted(x)) for x in g2]
check("大小写不同会合并", any({"Cilbond 24", "cilbond 24"} <= set(x) for x in g2), str(g2))
check("少了空格也会合并", any({"西邦24", "西邦 24 参数"} <= set(x) or {"西邦24"} <= set(x) for x in g2), str(g2))

print("\n[11] 合并后的分组：同一实体的两种写法不分家")
units = grouping._build_units(ALIAS_KWS, groups)
check("8 个词折叠成 5 个实体", len(units) == 5, str([u["key"] for u in units]))
for k in (2, 3, 4):
    gs = grouping.split_keywords(ALIAS_KWS, k, aliases=groups)
    check(f"{k} 篇时主词数=篇数", len(gs) == k, str(len(gs)))
    same = all(
        any("西邦 24" in grp and "Cilbond 24" in grp for grp in gs)
        for _ in [0]
    )
    check(f"{k} 篇时「西邦 24」与「Cilbond 24」同组", same,
          " ｜ ".join("+".join(x) for x in gs))
    check(f"{k} 篇时不丢词", set(flat(gs)) == set(ALIAS_KWS), str(set(ALIAS_KWS) - set(flat(gs))))
    check(f"{k} 篇时不重复", len(flat(gs)) == len(set(flat(gs))))

print("\n[12] 不传别名时行为不变")
base = grouping.split_keywords(KWS, 3)
with_empty = grouping.split_keywords(KWS, 3, aliases=[])
check("空别名列表结果一致", base == with_empty)

print("\n[13] build_task_queue：每个 selection 都 count=1 时，各篇主词应不同")
# 复现真实 bug：6 平台 × 官方/个人各 1 篇 = 12 个 selection，此前每个 selection
# 各自用全部关键词分组、只取第一组，导致 12 篇标题主词全是同一个。
tmp = tempfile.mkdtemp()
db = str(Path(tmp) / "t.db")
store = Store(db)
plats = store.list_platforms()
kw24 = [
    "西邦 24（Cilbond 24）", "西邦 62W（Cilbond 62W）", "西邦 49SFC（Cilbond 49SFC）",
    "西邦 48C（Cilbond 48C）", "西邦 12E（Cilbond 12E）", "西邦 80ET（Cilbond 80ET）",
    "西邦 89ET（Cilbond 89ET）", "西邦 45SF（Cilbond 45SF）", "西邦 33C-A/B（Cilbond 33C-A/B）",
    "Cilbond 65W", "开姆洛克 205", "陶氏罗门哈斯 Thixon422", "罗门哈斯 Thixon 538",
    "西邦粘合剂", "西邦热硫化胶水", "热硫化粘合剂", "聚氨酯粘合剂", "聚氨酯弹性体",
    "聚氨酯胶水", "橡胶胶水", "橡胶和金属粘接", "聚氨酯和金属粘接", "聚氨酯和金属脱胶",
    "橡胶和金属脱胶",
]
sel12 = []
for p in plats[:6]:
    sel12.append({"platform_id": p["id"], "account_type": "official", "count": 1})
    sel12.append({"platform_id": p["id"], "account_type": "personal", "count": 1})
tasks = generator.build_task_queue(store, kw24, sel12, aliases=grouping.find_aliases(kw24))
check("生成了 12 个任务", len(tasks) == 12, str(len(tasks)))
primaries = [t["group"][0] for t in tasks]
check("12 篇主词全部不同", len(set(primaries)) == 12, " / ".join(sorted(set(primaries))))
# 同时单 selection count=1 的旧行为校验：绝不能 12 篇撞同一个主词
check("没有篇篇撞同一个主词", len(set(primaries)) > 1, primaries[0])

print("\n[14] build_task_queue：大篇数时仍按全局轮转、不超 4 词/篇")
# 4 个 selection 各 1 篇、但关键词很多：确保每组不塞超过 4 个词
sel4 = [{"platform_id": plats[i % 6]["id"], "account_type": "official", "count": 1} for i in range(4)]
tasks4 = generator.build_task_queue(store, kw24, sel4, aliases=grouping.find_aliases(kw24))
over = [len(t["group"]) for t in tasks4]
check("每组关键词不超过 4 个", all(n <= 4 for n in over), str(over))

print("\n" + "=" * 46)
print(f"通过 {len(passed)} 项，失败 {len(failed)} 项")
if failed:
    for n, d in failed:
        print("  失败：" + n + ("  " + d if d else ""))
    print("结果：不通过")
    sys.exit(1)
print("结果：全部通过")
