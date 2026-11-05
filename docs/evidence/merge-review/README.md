# 发布前自检：前后对照

同一份离线替身状态（`tests/frontend/preview-server.mjs` + 含 `geo.checks` 的稿件），
分别用 `main@13f62c8` 与 `feature/merge-review` 的 `web/` 渲染，1440×1600 无头浏览器截图。

| 文件 | 来源 | 差别 |
| --- | --- | --- |
| `before-main.png` | `main@13f62c8` | 稿件页脚只有「201 字」；自检数据仅存在于 `article.geo`，界面只在「资料」面板以原始 JSON 展示 |
| `after-selfcheck.png` | 本分支 | 页脚为「自检 85 分 · 201 字」；正文下出现「发布前自检 · 85 分 · 2 项未通过」，含分数、通过数与逐项 `✓/!` 及原 `geo_check` 提示 |

两次截图都只启动本机离线 HTTP 替身，模型调用 0、目录查询 0、媒体编码 0。
稿件正文与客户信息均为合成的示例内容，不是真实客户数据。

注意：`after-selfcheck.png` 记录的是合并交接版本之前的自检视图（带总分）。`feature/customer-batch-storage` 合并后，界面改为不带总分的逐项清单（数据源仍是 `article.geo.checks`），本目录未重新截图；以 `docs/merge-review.md` 第七节为准。
