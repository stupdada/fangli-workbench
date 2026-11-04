# -*- coding: utf-8 -*-
"""关键词自动分组：把一批关键词按语义相近度排序后，均匀分到指定篇数里。

规则
- 每个平台独立分组：该平台写几篇，就切成几组
- 组与组之间不重叠，词不重复（篇数多于词数时才会轮换复用）
- 每组选一个「主关键词」进标题，其余作为辅词在正文覆盖
- 排序用字符二元组相似度做贪心链，尽量让相近的词落在同一组
"""

import re


def _grams(s):
    s = re.sub(r"\s+", "", s or "")
    if len(s) <= 1:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def similarity(a, b):
    """字符二元组 Jaccard 相似度，0~1。中文短词上比编辑距离稳。"""
    A, B = _grams(a), _grams(b)
    if not A or not B:
        return 0.0
    return len(A & B) / len(A | B)


def order_by_similarity(keywords):
    """贪心链排序：每次接上跟当前词最像的未用词，让相近的词相邻。"""
    remaining = [k for k in keywords if k and k.strip()]
    if len(remaining) <= 2:
        return remaining
    chain = [remaining.pop(0)]
    while remaining:
        last = chain[-1]
        best = max(remaining, key=lambda x: (similarity(last, x), len(x)))
        remaining.remove(best)
        chain.append(best)
    return chain


def pick_primary(group):
    """组内选主词：跟其他词最像的那个（最能代表这组），同分取更长的。"""
    if len(group) == 1:
        return group[0]
    best, best_score = group[0], -1.0
    for w in group:
        score = sum(similarity(w, o) for o in group if o != w)
        if score > best_score + 1e-9 or (abs(score - best_score) < 1e-9 and len(w) > len(best)):
            best, best_score = w, score
    return best


def _cluster(words, k):
    """并查集聚类：按相似度从高到低合并，直到剩 k 个簇，再平衡各簇大小。"""
    n = len(words)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    pairs = sorted(
        ((similarity(words[i], words[j]), i, j) for i in range(n) for j in range(i + 1, n)),
        reverse=True,
    )
    count = n
    for _sim, i, j in pairs:
        if count <= k:
            break
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri
            count -= 1

    buckets = {}
    for i, w in enumerate(words):
        buckets.setdefault(find(i), []).append(w)
    groups = list(buckets.values())
    if not groups:
        return groups

    # 平衡：把最大簇里最"边缘"的词挪到最小簇，直到大小差不超过 1
    guard = 0
    while guard < n * 3:
        guard += 1
        groups.sort(key=len, reverse=True)
        if len(groups[0]) - len(groups[-1]) <= 1 or len(groups[0]) <= 1:
            break
        big, small = groups[0], groups[-1]
        victim = min(
            big,
            key=lambda w: sum(similarity(w, o) for o in big if o != w) / max(1, len(big) - 1),
        )
        big.remove(victim)
        small.append(victim)
    return [g for g in groups if g]


def _model_token(s):
    """取型号片段：24 / 62W / 49SFC 等。"""
    m = re.search(r"(\d+[A-Za-z]*)", s or "")
    return m.group(1).lower() if m else ""


def _norm(s):
    return re.sub(r"[\s\-\u00b7_/]+", "", (s or "")).lower()


def _is_cjk(s):
    return bool(re.search(r"[\u4e00-\u9fff]", s or ""))


def find_aliases(keywords):
    """找疑似同一个东西的多种写法（中英文别名、大小写、包含关系）。

    只给候选，最终由用户确认。返回 [[w1, w2, ...], ...]
    """
    words = [w.strip() for w in (keywords or []) if w and w.strip()]
    n = len(words)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        for j in range(i + 1, n):
            a, b = words[i], words[j]
            na, nb = _norm(a), _norm(b)
            if not na or not nb:
                continue
            ta, tb = _model_token(a), _model_token(b)
            if na == nb:
                union(i, j)
                continue
            if ta and ta == tb:
                pa = na.replace(ta, "")
                pb = nb.replace(tb, "")
                # 型号相同、前缀不同 → 常见的中英文对或品牌写法差异
                if pa and pb and pa != pb and (_is_cjk(pa) != _is_cjk(pb) or len(pa) <= 8):
                    union(i, j)
                    continue
            if len(na) >= 3 and len(nb) >= 3 and (na in nb or nb in na):
                union(i, j)

    buckets = {}
    for i, w in enumerate(words):
        buckets.setdefault(find(i), []).append(w)
    return [g for g in buckets.values() if len(g) > 1]


def _build_units(words, aliases):
    """把别名组合并成单元：(代表词, [所有写法])。"""
    alias_of = {}
    for grp in aliases or []:
        grp = [w for w in grp if w in words]
        if len(grp) < 2:
            continue
        canon = grp[0]
        for w in grp[1:]:
            alias_of[w] = canon

    units, seen = [], set()
    for w in words:
        canon = alias_of.get(w, w)
        if canon in seen:
            continue
        seen.add(canon)
        forms = [canon] + [x for x, c in alias_of.items() if c == canon]
        units.append({"key": canon, "forms": forms})
    return units


def _unit_sim(u1, u2):
    return max(similarity(a, b) for a in u1["forms"] for b in u2["forms"])


def _cluster_units(units, k):
    n = len(units)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    pairs = sorted((( _unit_sim(units[i], units[j]), i, j) for i in range(n) for j in range(i + 1, n)),
                   reverse=True)
    count = n
    for _sim, i, j in pairs:
        if count <= k:
            break
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri
            count -= 1

    buckets = {}
    for i, u in enumerate(units):
        buckets.setdefault(find(i), []).append(u)
    groups = list(buckets.values())

    guard = 0
    while guard < n * 3:
        guard += 1
        groups.sort(key=len, reverse=True)
        if len(groups[0]) - len(groups[-1]) <= 1 or len(groups[0]) <= 1:
            break
        big, small = groups[0], groups[-1]
        victim = min(big, key=lambda u: sum(_unit_sim(u, o) for o in big if o is not u) / max(1, len(big) - 1))
        big.remove(victim)
        small.append(victim)
    return [g for g in groups if g]


def split_keywords(keywords, k, aliases=None):
    """把关键词分成 k 组，返回 [[主词, 其他写法...], ...]。

    - aliases 里的词先合并成一个单元（如 西邦 24 + Cilbond 24 算一个实体）
    - k <= 0 时全部并成一组
    - 词比篇数多：按语义聚类后均衡切分，词不重复不遗漏
    - 篇数比词多：每个单元一篇，多出来的轮换复用（靠不同角度区分）
    """
    words = [w.strip() for w in (keywords or []) if w and w.strip()]
    if not words:
        return []
    k = max(1, int(k or 1))
    units = _build_units(words, aliases)
    if not units:
        return []

    if k >= len(units):
        groups = [[units[i % len(units)]] for i in range(k)]
    else:
        groups = _cluster_units(units, k)
        order = {u["key"]: i for i, u in enumerate(units)}
        groups.sort(key=lambda g: min(order.get(u["key"], 999) for u in g))

    out = []
    for g in groups:
        all_forms = [f for u in g for f in u["forms"]]
        # 组内代表词：与同组其他单元最相似的那个单元里的主写法
        if len(g) == 1:
            primary = g[0]["forms"][0]
        else:
            best_unit = max(
                g,
                key=lambda u: sum(_unit_sim(u, o) for o in g if o is not u),
            )
            primary = best_unit["forms"][0]
        rest = [w for w in all_forms if w != primary]
        out.append([primary] + rest)
    return out
