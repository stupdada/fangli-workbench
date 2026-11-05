# 方立内容工作台开发交接

本项目把客户资料、文章创作、生成后编辑、版本采用、导出与无声视频制作放在同一个本机工作台中。仓库为 <https://github.com/stupdada/fangli-workbench>。2026-11-05 交接分支为 `feature/customer-batch-storage`，以交接者提供的提交 SHA 固定版本；接手可直接从该版本创建自己的功能分支，无需等待合并 `main`。

本文在 2026-11-04 快照上更新至 2026-11-05。开始新任务时，先核对交接提交、当前文件和已有验收记录。本文说明完整项目，具体任务可沿业务链修改必要代码。交接后，工作台视觉动效和首页后续优化由原开发者继续负责，同事在自己的功能分支推进本次指定任务。

同日新增的客户长期资产与多批生成实现见 [客户与批次合同](customer-batch-contract.md)：bridge/customers.py、documents.py、batches.py 分别维护独立客户/常用方案、原件/修订和持久队列。普通任务档案默认仅本次，显式保存为默认才同步客户；新任务优先带出方案。批次不按日期去重，只按一次提交request_key去重。资料保存在当前数据目录的clients/，历史文本记录原ID保留，原件缺失如实标注。新增测试入口 tests/core/test_customers_batches.py；工作台层还补齐核查档案、跨任务参考和平台检查，不修改app/原始字节。前端本轮由“优化工作台前端设计”聊天负责，阶段终验以该轮证据为准。

## 先读什么

1. 本文与 [README.md](../README.md)：范围、运行方式、当前能力。
2. [PRODUCT.md](../PRODUCT.md) 与 [integration-contract.md](integration-contract.md)：产品意图、接口、状态和版本语义。
3. [video/README.md](../video/README.md)：视频来源、分屏、队列和媒体边界。
4. [AGENT_START.md](AGENT_START.md)：可直接交给开发 Agent 的完整接手提示词。
5. [证据索引](evidence/README.md)：本次交接整理的代表性合成样稿、对比、质量评审和阶段证据。

文档之间出现阶段状态差异时，结合对应提交、源码和该状态的验收证据判断。例如，较早产品文档中记载配置写接口尚未接通，后续 `core-003` 已实现后台合同，而前端完整接线仍在单独验收。不能仅凭较早的一行状态重做整个功能。

## 项目结构与主链路

| 路径 | 作用 |
| --- | --- |
| `main.py`、启动脚本 | 主站入口，托管本次启动的视频子服务，输出实际端口和进程信息 |
| `app/` | 原源码 ZIP 的写作、分组、资料解析、原生核查、存储和导出核心 |
| `bridge/` | WorkBuddy 传输、任务与版本、有效输入、配置接口、生成后编辑、HTTP 和视频生命周期 |
| `web/` | 首页、对话创作与 ZIP 分步创作，两个入口共享任务状态 |
| `config/` | 写作及生成后审阅配置；连接配置在本机单独维护 |
| `style-library/` | 便携平台风格与认可表达配置，包含来源与哈希记录 |
| `vendor/workbuddy-sdk.js` | 服务端使用的捆绑 SDK |
| `video/` | 独立视频工作区、只读文章来源适配、完整分屏、媒体和无声合成 |
| `tests/` | 核心、前端合同、视频及传输边界测试 |
| `tools/check_handoff.py` | 离线交接检查，支持工作区、暂存区和运行依赖检查 |
| `data/` | 本机运行数据、模型记录、日志与视频媒体，属于运行环境 |

业务链路为：选择客户与资料 → 保存本次有效安排 → 可选需求访谈 → 冻结输入与配置 → 原 ZIP 写作和原生核查 → 保存初稿、成稿及来源证据 → 人工编辑或生成后候选 → 明确采用版本 → 导出；需要视频时，再手动把具体采用版本传入视频工作区。

`app/` 的原 ZIP 字节是历史保真基线。普通任务首次生成在 `app/generator.py` 和 `app/prompts.py` 接入有效风格、篇幅和当前资料；原始哈希留在 `tests/zip-core.sha256.json`，当前两个变更文件的验收哈希在 `tests/first-generation-core.sha256.json`。新行为见接口合同与 `test_first_generation_style.py`。

## 已实现的关键行为

- 对话与分步入口共享客户、任务、资料、安排、草稿、文章、版本与运行状态；切换入口会保存草稿。
- 品牌、公司、产品分别维护。八项客户字段和当前有效说明以任务 `brief` 为准，明确清空值保持为空；客户档案用于以后新任务的默认值。
- 新任务平台空选、已启用目标 AI 默认全选。目标 AI 是内容投向配置，写作模型由 `settings.model` 单独决定。
- 批次冻结资料和有效配置。正在处理的稿件有后端锁；已完成稿可编辑。生成中改变要求会暂停后续，确认后继续。
- 初稿、原生核查后稿、人工工作版本与候选分开保存。写操作检查 `expected_version`，冲突为 409；人工修改会清空沿用的旧审核与评分。
- 显式原生重写、再次核查、写下一篇、文章与任务逻辑删除、同客户任务复用、当前版本四格式导出和本地 ZIP 归档已有后台实现，前端覆盖以最新验收为准。
- WorkBuddy 超时、断线、截断和非完整结束不作为成功，不自动重复不确定调用。打开首页、保存草稿与配置不调用模型。
- 视频使用明确采用或曾采用过的固定文章版本，未采用候选返回 409，归属错误返回 404。后续文章编辑不会替换已有视频来源。
- 视频支持独立手填或导入文章、编辑、完整分屏、素材轮换、队列、停止与重试、成片预览和下载；当前是无声视频。

## 文案优化应从哪里接手

后续主要工作是提高稿件的实际可读性、事实边界和风格一致性。先区分三条真实调用路径，再决定修改位置：

| 路径 | 当前入口与规则 | 状态变化 |
| --- | --- | --- |
| 首次文章生成 | `app/generator.py`、`app/prompts.py`，经 `bridge/native.py` 等接入 | 原生生成与核查后保存工作版本 |
| 手动去味审阅与候选改写 | `bridge/editing.py` 的 `style_review` / `style_rewrite`，读取 `config/de-ai-taste.md`；审阅同时读取 `config/ai-taste-signals.md` 与适用风格参考 | 用户选择建议后生成候选，随后一次只读事实复核，明确采用才切换当前稿 |
| 网页“修改当前稿” | `bridge/editing.py` 的 `revise`，使用该函数自己的修改提示词 | 基于当前正文生成修改候选，默认不采用，也不自动走上述去味复核 |

网页的“去味”是应用通过 WorkBuddy 执行仓库规则，模型实际为 `deepseek-v4.1-flash`。它不等同于开发 Agent 在宿主里直接运行同名技能。当前应用审阅返回 `default_mode: full`，`style_rewrite` 默认也为 `full`；本机宿主去味技能的默认幅度为 `standard`。比较两者效果时必须记录所用入口、规则版本、建议选择和改写幅度，不能假定行为相同。

`bridge/style_library.py` 为普通任务首次生成和生成后审阅选择适用的风格及认可表达。首次生成的版本和资料随 `creation_context` 冻结；后置去味信号统一维护在 `config/ai-taste-signals.md`。客户限定认可表达需要实际客户绑定，规则与认可表达用于写法，当前档案和资料提供业务事实。

真实合成样稿表明，删除重复段落与内部过程说明有收益；但工艺推论仍可能缺依据，事实审核仍有漏报和误报。模型链路接通、JSON 成功解析、某次复核 `pass` 都不能证明内容质量普遍通过。保留原稿、候选、差异、所用资料和实际人工意见，才能判断修改的净收益。

建议先读 [样稿质量评审](evidence/quality/quality-review.md)，对照同目录的工业稿原稿、候选和资料定位具体问题，再做最小完整修改。既可以调整提示词、规则、风格参考，也可以修正资料传递、候选状态、审核和界面呈现；范围由当前任务的真实原因决定。事实缺项与制作过程提示放在编辑侧，正文可以写有依据的一般介绍和建议，具体经历、数字、客户关系和服务承诺必须有来源。

## 运行环境与本机配置

推荐 Windows、Python 3.11、Node.js 20+。`app/` 和 `bridge/` 的 Python 业务代码使用标准库，捆绑 SDK 不需要 `npm install`。完整启动会托管视频模块，因此还需要 Pillow、PATH 中可用的 FFmpeg / ffprobe 及视频渲染器支持的中文字体。浏览器的 woff2 字体不能代替 Pillow 渲染字体。

在仓库根目录使用 PowerShell 7：

```powershell
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
python --version
node --version
python -c "import PIL; print(PIL.__version__)"
ffmpeg -version
ffprobe -version
```

若 Python 环境缺 Pillow，可在自己的虚拟环境安装：

```powershell
python -m venv .venv
& ./.venv/Scripts/Activate.ps1
python -m pip install -r requirements-video.txt
```

这部分是完整视频运行依赖；仅执行 `pip install -r requirements.txt` 不会安装 Pillow。中文字体候选见 `video/runtime/video-engine/silent_renderer.py`。原机 Windows 字体及特定字体哈希属于历史验收条件，新设备需核对字体选择和实际排版。

WorkBuddy 连接保存在各自本机的 `config/workbuddy.json`，仅在该文件不存在时从 `config/workbuddy.example.json` 创建，再通过安全渠道填写自己的连接参数。该文件被 Git 忽略且未被跟踪，正常更新源码不会替换已有连接。换目录克隆时需自行迁移本机配置。同事对 `bridge/workbuddy.cjs`、`bridge/provider.py` 或 `vendor/workbuddy-sdk.js` 的本地适配属于源码修改，接手前先保存，再合并交接代码并检查适配行为。真实连接配置由服务端读取，身份凭据不写入仓库、前端、样稿、日志附件或 PR。SDK 文件随源码提供。默认模型精确 ID 为 `deepseek-v4.1-flash`，明确执行模型操作时会核对目录并缓存；目录缺该 ID 时停止，不自动换模型。

风格库位于仓库内 `style-library/`，`config/style-library.json` 使用相对路径，由 `bridge/style_library.py` 按仓库位置解析，与启动时的工作目录无关。来源见 [style-library/README.md](../style-library/README.md) 及同目录 `provenance.json`。客户绑定仍需按当前环境真实标识配置。

完成依赖和本机连接配置后，运行：

```powershell
python main.py --no-browser --port 0
```

终端就绪记录给出实际主站地址和视频子服务信息。页面为 `/`、`/workbench`、`/workbench/zip`、`/video/`；默认固定端口为 8770，也可双击 `启动.bat` 或 `启动_开发模式.bat`。开发需隔离数据时：

```powershell
python main.py --no-browser --port 0 --data-dir ./data/dev-workbench
```

默认数据库为 `data/workbench/workbench.db`，新环境客户和稿件为空，仅初始化配置种子。每个数据目录只运行一个主服务。运行数据、模型调用记录、私有诊断和视频媒体单独保管；Git 源码不是客户数据备份。

主站自动管理本次视频子服务。`GET /api/workbench/runtime` 读取状态；`POST /api/workbench/video-service/restart` 携带 `{}` 明确重载本次子服务；`POST /api/workbench/shutdown` 正常关闭。重载前确认本次队列无活动任务并协调使用者。启动失败会退出主站，日志位于相应数据目录的 `logs/`。一次启动不会生成文章或编码视频。

## 验证与证据

先运行交接自检；需要启动完整工作台时增加运行依赖检查：

```powershell
python tools/check_handoff.py
python tools/check_handoff.py --runtime
```

默认检查可入库文件中的凭据和私有运行文件、ZIP 核心的历史及当前验收哈希、相对风格库加载、连接示例与交接文档；`--runtime` 额外检查 Node、Python、Pillow、FFmpeg / ffprobe 和中文字体。`--staged` 检查暂存区中的确切内容，适合提交前使用。这些检查不调用外部模型或编码，内容质量需要另行阅读实际稿件。

后续修改选择受影响的最小测试集合。例如：

```powershell
python -B -m unittest discover -s tests/core -p test_effective_inputs.py
python -B -m unittest discover -s tests/core -p test_native_operations.py
node --test tests/video/workspace-errors.test.cjs
node --test tests/video/unified-ui.test.cjs
```

测试是否自包含要以当前源码为准。较早的 `tests/core/verify.py` 会通过 `test_workbench.py` 从仓库父目录读取原源码 ZIP；部分前端与视频测试还读取原工作区 `output/` 夹具，分页测试还比对原字体哈希。干净克隆中缺少这些输入时，先记录缺失前提或按当前交接方案迁入脱敏夹具，不能把文件缺失当成业务失败，也不能将未执行写成通过。保真复验的典型入口为：

```powershell
python -B tests/core/verify.py --output ./data/verification/core.json
```

历史有效证据如下；已随仓库收录的文件见 [证据索引](evidence/README.md)，原工作区完整产物不自动包含在 Git 中：

| 阶段 | 已有证据及适用范围 |
| --- | --- |
| `core-001` | 受控传输、真实本机 HTTP/临时 SQLite、原 ZIP 请求与导出回放、SDK 完整结束等；外部模型与目录调用为 0 |
| `core-002` | 隔离合成夹具真实 WorkBuddy 接通：8 次内容调用、1 次目录查询，精确模型 ID 正常完整结束；质量问题仍保留 |
| `core-003` | 有效输入、配置 CRUD、原生版本化操作、归档、同源代理和子服务生命周期边界的后端验收 |
| `frontend-002` | 真实主站已有文章、资料修订、草稿、审阅恢复、版本采用与导出；本轮新增模型、目录和编码为 0 |
| `video-002/003` | 已有 169.12 秒无音轨成片及字幕完整性；后续分屏修正使用真实字体，保留全文，未再次编码 |
| `video-004/005` | 真实主站固定版本来源、编辑保存、素材、手填、历史播放/字幕及窄屏；005 完成重载后的真实 409 提示与草稿保持终验 |

同一状态已有有效证据时复用。代码、配置、输入或运行环境改变后，才重验受影响范围。真实模型调用和编码要单独标明次数、成本边界与输入；离线验证不自动发起这些操作。

## 当前待办与并行工作快照

1. **工作台交互增量已完成。** 客户与批次、消息输入与审阅、连续创作工作区三个任务均已回报完成，分别见 `tests/frontend/customer-batch-acceptance.md`、`composer-settings-acceptance.md`、`live-workspace-acceptance.md`。最后一项有32项前端与合同检查及内置Browser交互证据；复用这些记录，不再等待旧回报。证据覆盖各报告注明的接口与交互范围，真实模型成稿质量另行评估。
2. **视频既有链路已终验。** `video-005` 已完成一次受控子服务重载，真实页面未采用版本返回 409、正文保持为空；既存 95 字／6 屏草稿、素材关联和源 Markdown 保持。证据见 [运行时终验](evidence/video/runtime-005/verification.md)，本次模型、目录、编码与新批次均为 0。后续业务修改再按影响范围验证。
3. **文案质量。** 继续用资料—原稿—候选—审核—采用的完整链路评估，重点检查重复、过程说明、无依据推论和事实复核准确性。已有个别改写收益，不代表所有场景已达到交付质量。
4. **写作策略接入。** 旧写作策略已在 `frontend-examples` 与平台风格库完成，可读 [阶段交付](reference/editorial/阶段交付.md) 与 [校准示例](reference/editorial/校准示例.md)；这不代表新项目已经全部接入。
5. **视频文案入口。** 四方向模块和八稿实测已收录于 `docs/reference/video-authoring/`，先读 [八稿阅读](reference/video-authoring/八稿阅读.md) 及该目录原 README、schema 和离线验证。八稿中有一条梳毛稿包含无依据商家事实而失败，样例复用和结尾挂店名仍有问题；生产“写视频文案”入口待评审接入。`video/public/authoring-view.js` 有预留位置，需先评估真实模块与当前接口，再实现接线。
6. **工作台视觉动效与内部指南。** 内部指南第一版已完成，见 `tests/frontend/internal-guide-acceptance.md`。当前交接保留已落地的视觉和弹性动效代码，阶段进度以相关验收报告为准；后续视觉与首页优化由原开发者继续负责。
7. **阅读界面评审。** `fangli-readability-preview` 是正式项目之外的独立前端副本，等待用户评审后决定合并，当前基线不含其设计。先确认评审和代码来源，避免把效果预览当成已上线能力。
8. **干净克隆验收。** 连接示例、便携风格库、相对路径、合成样稿及历史证据、离线检查已纳入交接。新设备仍需准备运行依赖和自己的连接配置；历史测试外部夹具与字体前提见上文。提交冻结时以 Git 暂存内容为准核对，其他开发可能仍在更新工作区。

新任务以最新需求为目标，先分析实际原因和上下游影响，再完成必要实现与验证。

## Git 协作约定

新环境克隆私有仓库需要自己的 GitHub 访问权限。已有目录先检查当前仓库、`origin`、工作区和分支，核对远程确实指向本项目后再 `fetch`。已有本机配置先在仓库外保存一份副本，并保留自己的源码提交。未提交的源码修改应检查敏感内容后，在自己的分支明确暂存并提交；不要把真实配置加入 Git。已有源码适配时，在自己的功能分支合并交接提交并处理冲突，检查后再提交，不用远程文件覆盖本机 SDK 或桥接代码。干净的新克隆可从 `origin/feature/customer-batch-storage` 创建功能分支：

```powershell
git clone https://github.com/stupdada/fangli-workbench.git
Set-Location fangli-workbench
git remote get-url origin
git status --short --branch
git fetch origin
git switch -c feature/your-task origin/feature/customer-batch-storage
```

开发结束后只暂存本次确认的文件，检查差异与敏感内容，运行相应验证，再提交并推送功能分支：

```powershell
git diff --check
git diff
git add <本次文件>
git diff --cached
python tools/check_handoff.py --staged
git commit -m "说明本次具体行为变化"
git push -u origin feature/your-task
gh pr create --base main --head feature/your-task --title "说明本次具体变化" --body-file ./data/pr-body.md
```

PR 正文写明触发问题、实现后行为、验证命令和结果、剩余前提；正文文件使用 UTF-8。未安装或未登录 `gh` 时可用 GitHub 网页建 PR。`main` 通过 PR 合并；不自动直接推送 `main`，不强推或重置既有历史。发现他人未提交修改时保留现场，按归属隔离本次改动；只有实际冲突阻止继续时才提出具体问题。

交付报告应给出提交或 PR、改动的业务行为、已运行验证、未验证条件和剩余待办。连接凭据、客户运行数据库和私有日志保持在本机受控环境。
