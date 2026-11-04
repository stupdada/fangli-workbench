"""清理历史稿件里像硬广的内容：文末「品牌与联系信息」小节 + 官网/生产商类问答。

用法：
    python tools/clean_ad_block.py --dry-run   # 只看会改什么，不写库
    python tools/clean_ad_block.py             # 真正执行
"""
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

from app import render          # noqa: E402
from app.store import Store     # noqa: E402

MARKERS = ("品牌与联系信息", "的官网是多少", "是哪家公司生产的")


def main():
    dry = "--dry-run" in sys.argv
    store = Store(BASE / "data" / "geo.db")
    articles = []
    for p in store.list_plans():
        articles.extend(store.list_articles(p["id"]))

    changed = 0
    for a in articles:
        body = a.get("body_md") or ""
        if not any(m in body for m in MARKERS):
            continue
        new = render.strip_ad_block(body)
        if new.strip() == body.strip():
            continue
        changed += 1
        print(f"[{a['id']}] {a['platform_name']} | {a['title'][:26]}")
        print(f"      {len(body)} → {len(new)} 字（-{len(body) - len(new)}）")
        if dry:
            tail = new.strip().split("\n")[-4:]
            print("      清理后结尾：", " / ".join(x[:36] for x in tail))
        else:
            store.update_article(a["id"], body_md=new)
            geo = render.geo_check(
                dict(a, body_md=new), a.get("keyword") or "",
                "", [], a.get("keywords")[1:] if a.get("keywords") else [])
            store.update_article(a["id"], geo=geo)

    print(f"\n共 {len(articles)} 篇稿件，命中 {changed} 篇" +
          ("（预览模式，未写库）" if dry else "，已清理"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
