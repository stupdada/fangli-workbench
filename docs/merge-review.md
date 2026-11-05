# 两套项目合并的原有功能对照

本文件记录 2026-11-04 对「合并前用户侧项目」与「当前 `main` 合并结果」的功能级对照，用于回答一个问题：合并有没有丢掉有价值的原有能力。对照不只看按钮和文件是否存在，而是沿界面 → 接口 → 处理逻辑 → 存储 → 最终输出逐段确认。

- 对照分支：`feature/merge-review`，基线 `main@13f62c8`。
- 原始证据：用户侧原项目 checkout `C:\Users\34282\fanglidemo\wenzhang`（本机路径，不入库、不随仓库分发）。
- 判定方法：全量 sha256 比对 + 文本差异 + 接口调用链核对 + 界面字符串与交互入口核对 + 现有测试证据复核。

## 一、证据摘要

| 部位 | 合并前 | 当前 main | 判定 |
| --- | --- | --- | --- |
| `app/`（写作、分组、解析、核查、存储、导出核心） | 11 个 .py | 11 个 .py | 逐字节一致（sha256 全同），`tests/zip-core.sha256.json` 校验通过 |
| `tools/`（原项目测试与运维脚本） | 20 个 .py | 同一批 20 个 .py（现存 22 个，多出 `check_handoff.py`、`check_workbuddy.py`） | 文本一致，仅行尾差异 |
| `使用说明.md` | 25,195 字节（CRLF） | 同文本（LF 存储，24,872 字节） | 归一化后 sha256 相同；内容仍是合并前界面的手册 |
| `web/`（界面） | `index.html` + `app.js` + `styles.css`（约 130 KB 单页） | `web/workbench/`（`app.mjs`/`client.mjs`/`model.mjs`/`files.mjs` + 资产） | 界面整体重写，功能需逐项核对 |
| 服务接口 | `app/server.py` 原生接口 | `app/server.py` 保留 + `bridge/http.py` 工作台接口 | 原生接口仍在，工作台写接口禁止绕过锁 |

因此「核心生成能力」不是被重写而是被原样携带；有丢失风险的部分集中在 **界面入口、交互效率、以及只存在于旧前端的展示逻辑**。

## 二、逐项对照

分类口径：已保留 / 换了入口 / 由新机制实现 / 部分缺失 / 确实缺失 / 尚不能确认。

| # | 原功能（合并前实际行为） | 原始证据 | 当前实现 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 多文件拖拽/选择上传，单份 8 MB、单份正文 20 万字上限 | `web/app.js: addFiles/readBase64`；`app/parsers.py: MAX_TEXT` | `web/workbench/files.mjs` 8 MB 前置校验；`bridge/storage.py: put_document` 200000 字上限 | 已保留 |
| 2 | 解析 docx/xlsx/pptx/txt/md/csv/tsv/json/html | `app/parsers.py` | `POST /api/parse` 走同一 `parsers.parse_file` | 已保留 |
| 3 | PDF 需另存 docx 或粘贴 | 使用说明「PDF 传不上去」整节 | 前端 pdf.js 读取文字（≤100 页、≤20 万字），原解析器不回退 | 由新机制实现（能力增强） |
| 4 | 每份资料「核对内容」后可改 | `web/app.js: viewMaterial` | `showDocument` → `reviseDocument` 生成修订资料并替换本次选择，旧资料与冻结输入保留 | 换了入口（语义更严格） |
| 5 | 粘贴一段文字入库 | `pasteMaterial` | `paste()` | 已保留 |
| 6 | 关键词回车/逗号批量添加、去重 | `addKeyword/kwTexts` | `addKeyword` + `splitWords` | 已保留 |
| 7 | 竞品/品牌名单全局一份，自家标「（我方）」 | `addRival/renderRivals` | `option-rivals` + `rival-list`，我方按档案品牌/公司标记 | 已保留 |
| 8 | 别名自动识别 → 勾选「应用合并」 | `detectAliases/renderAliasBox/applyAliases` | `detectAliases()` 弹窗勾选合并，另有手工分组文本框 | 已保留 |
| 9 | 目标大模型多选（与写作模型分开） | `renderModelChips` | `targetsBlock()`，`settings.model` 独立 | 已保留 |
| 10 | 平台卡片：官方号/个人号分别 0–20 篇、点击默认 1 篇、合计 | `renderPlatformCards/platCount/setPlatCount` | `platformDialog()` + `setCount/togglePlatform/planSummary`，左侧「平台与篇数」入口 | 已保留 |
| 11 | 发布形态选择 | 旧实现按平台 `formats` 取值 | `format_overrides` 逐平台勾选，失效形态强制报错 | 由新机制实现（更强约束） |
| 12 | 抓取偏好对照表（高/中/低） | `renderPrefTable` | `configBlock()` 矩阵，仅显示本次已选平台的列 | 部分缺失（见三.3） |
| 13 | 49 条风险清单展示/增删改 | `renderRiskList/editRisk` | `configBlock()` + `editRisk/deleteRisk/add-risk` | 已保留 |
| 14 | 自动连写、平台轮换、角度轮换、词未覆盖优先 | `app/generator.py` | 同一 `generator`，`start/write-one` 接线 | 已保留 |
| 15 | 流式输出、暂停（当前篇收尾）、「继续写剩下的 N 篇」 | `startWrite/pauseWrite/finishWrite` | SSE `/api/jobs/{id}/stream` + `liveView`，「暂停后续」/「继续未完成安排」 | 已保留 |
| 16 | 写作中实时字数 | `renderStream(raw, chars)` | `streamReducer` 保留 `chars`；交接版本重做写作视图后改为阶段耗时 + 篇数，本机不再单独补字数 | 部分缺失（取舍，见第七节） |
| 17 | 单篇失败跳过并在结尾汇总 | `finishWrite` 的 `items[].state==='error'` | `notices()` 显示后台错误，失败篇不计完成 | 已保留（汇总文案较简） |
| 18 | 自动事实核查 + 核查清单（原句/问题/改成什么） | `renderAudit` | `factMarkup()` 渲染 `findings` | 已保留 |
| 19 | 「还原到核查前」 | `restoreArticle` | 版本列表「恢复此版」（原生核查前版本作为可恢复版本留存） | 换了入口 |
| 20 | 「再核一次」 | `auditAgain` | `native-audit`（`zip_audit`） | 换了入口 |
| 21 | 「重新写这篇」 | `regenArticle` | `native-regenerate`（`zip_regenerate`，接原生核查） | 换了入口 |
| 22 | 稿件标题/标签/发布声明/正文编辑 | `selectArticle/saveArticle` | `articleView` + `saveArticle`，版本 CAS 与锁 | 已保留（声明由固定复选改为自由文本） |
| 23 | 发布前自检 13 项打分 + 逐项修改提示 + 分数色标 | `renderGeo/geoList`；`app/render.py: geo_check` | 数据随 `article.geo` 返回；本机补成逐项 `✓/!` 清单，但界面与导出都不展示总分 | 部分缺失 → 恢复逐项、放弃总分（见第七节） |
| 24 | 勾选导出（全选/全不选/只留 85 分以上）、docx/md/json | `updatePickBar/exportPlan` | `exportDialog()`，另加 txt；交接版本取消了「85 分以上」筛选 | 已保留（85 分筛选按总分不可靠而移除） |
| 25 | 「确认无误，上传服务器」+ 本地归档 | `uploadPlan`（`HttpUploadAdapter`） | 改为「下载本地归档」+ 视频工作区入口，接口合同明确取消上传 | 由新机制实现（已写进 `docs/integration-contract.md`） |
| 26 | 设置 → 大模型接口（地址/模型/Key/深度思考/测连通） | `fillSettings/btnTestLLM` | 服务端读 `config/workbuddy.json`；界面保留模型、温度、上限、深度思考、标题前缀 | 由新机制实现（凭据不再进前端） |
| 27 | 设置 → 目标大模型 / 分发平台 CRUD | `renderModelAdmin/renderPlatformAdmin` | `configAdmin()` + `editPlatform/editTarget/deleteCatalogue` | 已保留（能力更多） |
| 28 | 历史方案列表、打开、复用 | `loadHistory` | 侧栏「最近任务」「查找任务」，`clone-task` 复用同客户安排 | 已保留 |
| 29 | 关键词分组排布预览（`/api/preview-groups`） | `app/server.py` 有接口 | 旧前端已主动不用（`tools/test_ui_static.py:96` 断言），现行同样按篇计算 | 已保留原状 |
| 30 | 清理旧硬广块、qwen 诊断脚本 | `tools/clean_ad_block.py`、`tools/diag_qwen.py` | 原样保留 | 已保留 |
| 31 | 旧界面静态结构测试（237 项） | `tools/test_ui_static.py` | 脚本仍指向 `web/app.js`、`web/styles.css`，干净克隆必然崩溃 | 确实缺失（校验能力）→ 本次处理 |

## 三、需要说明的差异

1. **「上传服务器」与旧大模型接口设置**属于明确的产品合同变化，不是合并事故：现行边界是「本机工作台 + 本地归档 + 独立视频工作区」，凭据只在服务端读取。已在 `docs/integration-contract.md`「原生显式操作与版本边界」写明。此处不恢复旧接口，避免把凭据和外部投递重新引回前端。
2. **发布声明**从固定复选改为自由文本：同一字段、同一存储（`decl` 字符串数组），表达更宽，不影响生成与导出语义。
3. **抓取偏好矩阵只显示已选平台列**：合并前渲染全部平台列。当前实现避免了「未选平台也显示偏好」的困惑，但少了一次性横向比较。属可用性取舍，未改。
4. **「已写完」列表**原本显示每篇自检分。交接版本改为「平台 · 正在核查/已保存」，并取消了导出侧的总分筛选。本机随该取向调整，不再补总分。
5. **`使用说明.md` 仍是合并前界面的手册**：按钮名（「开始写第一篇」「确认无误，上传服务器」）与现行界面不一致。这是文档问题而非功能丢失。不在本次未授权范围内改写用户原文档，列为待办。

## 四、本次恢复（最小完整）

| 项 | 改动 | 依据 |
| --- | --- | --- |
| 具体检查项 | `model.mjs` 的 `selfCheck()` 读 `article.geo.checks`；`资料` 面板把 13 项渲染成逐项 `✓/!`，未通过项显示原 `geo_check` 的 `hint`，原始返回可展开 | 数据本来就在 `article.geo`，旧界面只当 JSON 打印，用户看不到「哪几项没过、怎么改」；按交接版本取向不展示总分 |
| 旧界面静态测试 | `tools/test_ui_static.py` 在缺少 `web/app.js`、`web/styles.css` 时明确「跳过」并说明现行覆盖位置 | 合并删除了它读取的文件，导致 `运行全部测试.bat` 必然中断；不伪造通过，也不把缺失当失败 |
| 本机连接检查 | 新增 `tools/check_workbuddy.py` | 见第五节 |

未改 `app/`：核心哈希合同与保真测试要求其字节不变；自检评分本身的既有缺陷（见「未验证项」）单独记录。

## 五、WorkBuddy 连接检查

`python tools/check_workbuddy.py` 默认离线执行：

- Node 是否存在、是否 ≥ 20；Python 是否 ≥ 3.10。
- `vendor/workbuddy-sdk.js` 能否在隔离 vm 上下文加载，并核对 SDK 自身的配置契约（合法配置被接受、错误 key 前缀被拒、非法 URL 被拒）。
- `config/workbuddy.json` 是否存在；`endpoint` 是否为绝对 http(s) 地址、`publishableKey` 是否以 `wbpk_` 开头、`oauthRelayBaseUrl` 是否可留空或为绝对地址；占位值单独标记。只输出端点主机名与 key 长度，不回显凭据。

`--live` 只做一次模型目录查询（不产生正文 token）；`--live-chat` 才做一次最小对话，会消耗账号额度。两者都要求配置先通过离线检查。

填写本机配置用 `python tools/setup_workbuddy.py`：逐项提示、`publishableKey` 输入不回显、只写 `config/workbuddy.json`（Git 忽略）。三个值来自 WorkBuddy 云服务控制台该应用的 `publicConfig`，不能从域名约定或本机其他文件推导。

## 六、未验证项与待办

1. **真实模型连通已在本机完成（2026-11-05）。** 用当前登录账号在 WorkBuddy 云服务里为这个项目开通了独立应用（未使用他人的应用 ID），`publicConfig` 写入本机 `config/workbuddy.json`，未进 Git。验证到三步：离线格式与 SDK 加载通过；模型目录查询返回 34 个模型且含 `deepseek-v4.1-flash`；一次最小对话 `finish_reason=stop`、消耗 1 次内容调用。应用只开通云服务、未发布、未上传任何客户资料。应用 ID、endpoint 与 publishableKey 属于账号配置，只留在本机。
2. **`geo_check` 既有缺陷（合并前就有，非本次引入）**：`app/render.py: geo_check` 的「关键信息独立成段」硬编码匹配 `## 关键信息速览`，而小节名由 `prompts.layout_for()` 决定，导致非默认平台该判定恒为失败、总分被压低。修它要动受哈希保护的 `app/`，需单独授权，本次仅记录。
3. **浏览器交互验收**：本次用本机离线接口替身 + 无头浏览器截图核对自检区排版，未做完整点击流程回归；`tests/frontend/*.test.mjs` 已覆盖契约层。
4. **两个前端测试依赖外部夹具**：`tests/frontend/core-shape.test.mjs`、`unified-contract.test.mjs` 读取 `../output/geo-merge-20261104/...`（原工作区产物），干净克隆缺省必然失败。属交接说明已记录的前提缺失，未伪造夹具。
5. **视频模块**未改动，沿用 `video-005` 证据；本次未重跑编码。

## 七、与交接版本（feature/customer-batch-storage）的合并记录

2026-11-05 在 `feature/customer-batch-integration` 上合并固定提交 `9e69a7e`（`origin/main` 是它的祖先），目的：在保留本机 WorkBuddy 适配与审查成果的前提下接入客户批次、消息审阅、连续创作与内部指南等新实现。

**保留的本机适配**

- `config/workbuddy.json`、`.wbapp_*.genie`、`.workbuddy/` 全部留在本机未入库；`.gitignore` 同时保留远程的 `/.codex/tasks/`、`/.finesse/` 与本机的忽略规则。
- `AGENTS.md` 的长期协作规则（含「推送与建 PR 需单独授权」）。
- `tools/check_workbuddy.py`、`tools/setup_workbuddy.py`、`tools/test_ui_static.py` 的跳过保护。
- 具体检查项逐项清单（数据源 `article.geo.checks`，不含总分）。

**冲突与取舍**

| 文件 | 冲突性质 | 处理 |
| --- | --- | --- |
| `docs/HANDOFF.md` | 双方都改「当前待办」 | 保留远程新增的视觉动效/内部指南与干净克隆条目，再接本机的检查项、使用说明、`geo_check` 与对照文档四条，重新编号 |
| `web/workbench/app.mjs` | 远程重写写作视图与稿件页布局；本机在稿件页插入自检块、字数与分数 | 采用远程的 `liveMarkup`、`article-scroll` 结构；自检改为只渲染逐项（含原始提示、可展开原始返回），**不再显示总分**，随之移除本机新增的稿件页折叠块与「已写 N 字」 |
| `README.md`、`.gitignore`、`model.mjs`、`workbench.css` | 自动合并 | 逐项核对：README 保留远程新段与本机的连接工具说明；`selfCheck()` 去掉 `score/tone`，只返回逐项与字数；CSS 删除未使用的总分胶囊与折叠块样式 |

**为何放弃总分**：远程版本用 `checksOnly()` 显式剥离 `score`，并取消了导出侧「仅选自检 ≥85 分」；这与本机记录的 `geo_check`「关键信息独立成段」硬编码 `## 关键信息速览`、非默认平台恒失败一致。总分不可作为选稿依据，逐项清单才是可用信息。

**连接代码**：交接提交未改动 `bridge/workbuddy.cjs`、`bridge/provider.py`、`vendor/workbuddy-sdk.js`、`main.py`、`config/`，本机 `Origin: http://127.0.0.1` 适配原样保留。

**本次合并的启动与真实调用验证（2026-11-05）**

- 独立数据目录 `data/dev-integration`（未提交，`.gitignore` 已忽略），`python main.py --no-browser --port 0` 正常拉起主站在 61747、视频子服务在 61749，`/api/workbench/runtime` 报 `video: ready`；`/api/workbench/shutdown` 可正常关闭，两个端口均已释放。
- 真实写作 1 篇（抖音官方号 · 图文，`deepseek-v4.1-flash`，合成资料）：约 15 秒完成生成与原生核查，成稿 1561 字，版本 `ZIP 成稿`，核查 `ok=true / applied=true / 2 处`，`geo.checks` 12 项、未通过 1 项（品牌露出适度）。后端仍保存 `geo.score`，界面按合同不展示。
- 本机 `config/workbuddy.json` 与合并前备份 sha256 一致（`7d23c9c1…`），未被覆盖。
