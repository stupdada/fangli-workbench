# 方立内容工作台

本机工作台，保留原交接 ZIP 的首次写作、取材、原生核查与正文导出。`app/` 为字节不变的原始代码；`bridge/` 提供 WorkBuddy 传输、客户资料、共享草稿、版本和 HTTP 服务。两个入口共同操作同一个内容任务。

## 启动

开发交接与后续工作见 [docs/HANDOFF.md](docs/HANDOFF.md)，给接手开发 Agent 的完整提示词见 [docs/AGENT_START.md](docs/AGENT_START.md)。2026-11-05 的交接分支为 `feature/customer-batch-storage`；同事从提供的交接提交继续开发，无需等待合并 main。已有本机配置与源码修改按接手说明保留，验收范围以各报告为准。

建议 Python 3.11+、Node.js 20+。文章后端使用 Python 标准库，SDK 已随仓库提供，无 npm 安装步骤；整站启动还会托管视频服务，需要 Pillow、FFmpeg/ffprobe 和中文字体。先安装视频 Python 依赖，并创建本机连接配置：

```powershell
python -m pip install -r requirements-video.txt
if (-not (Test-Path -LiteralPath config/workbuddy.json)) {
    Copy-Item config/workbuddy.example.json config/workbuddy.json
}
```

把 `config/workbuddy.json` 中的三个占位值替换为自己的有效 WorkBuddy 配置。该文件被 Git 忽略；配置示例不可用于真实模型调用。SDK为 `vendor/workbuddy-sdk.js`，连接只在服务端读取。FFmpeg/ffprobe 需位于 PATH；Windows 使用微软雅黑，Linux 字体路径要求见视频引擎说明。打开页面不会主动调用外部模型。

不想手抄时用 `python tools/setup_workbuddy.py`：它逐项提示，`publishableKey` 输入不回显，只写本机文件，然后 `python tools/check_workbuddy.py` 做格式与 SDK 的离线校验。三个值的来源是 WorkBuddy 云服务控制台为该应用生成的 `publicConfig`（`endpoint` / `oauthRelayBaseUrl` / `publishableKey`）；`oauthRelayBaseUrl` 只在本工作台调用模型时可以留空。

双击 `启动.bat`，或在此目录运行：

```powershell
python main.py
```

展示首页：`http://127.0.0.1:8770/`；内部使用指南：`/guide/index.html`；对话创作：`/workbench`；ZIP分步：`/workbench/zip`；视频：`/video/`。同一次启动自动拉起并管理视频子服务，终端输出实际主端口、主PID及视频PID。关闭窗口或Ctrl+C退出。`启动_开发模式.bat` 保留终端但不自动打开浏览器。

可指定独立数据目录、端口或让系统分配端口：

```powershell
python main.py --no-browser --port 0 --data-dir "./data/dev-workbench"
```

默认库为 `data/workbench/workbench.db`，新客户和稿件为空，仅初始化ZIP配置种子。不会迁移旧库。每个库只允许一个服务进程，避免另一进程清除在途锁。数据、模型调用记录与快照均不作为静态文件发布。仅监听127.0.0.1，使用页面显示的同源地址访问。

写作模型默认精确ID `deepseek-v4.1-flash`。打开首页和保存草稿不查询模型目录、不生成文章；明确开始模型操作时验证目录并缓存，目录缺少所选ID即停止，不自动换模型。设置接口只接受写作参数，连接密钥不进入HTTP响应。

## 稿件与操作

客户独立管理与批量生成接口见 [客户与批次合同](docs/customer-batch-contract.md)。客户资料在数据库之外还保存原件与解析文字，位置为本数据目录的 `clients/<客户ID>/documents/`；同客户原件哈希去重，上传新版本不覆盖旧任务。历史仅有解析文字的资料保持可用，原件需重新导入补齐。每客户一套常用方案，新建任务自动带出；批次可同日多次提交，按提交快照排队执行，重复请求使用同一个request_key。

普通任务档案修改默认只影响本次；独立客户更新或明确保存为默认才改变后续任务。批次提交后不再直接修改其安排，复用为普通任务或创建新批次调整。新增离线边界测试为 `python -B -m unittest discover -s tests/core -p test_customers_batches.py`。

- 对话与分步入口共享任务、资料选择、草稿与稿件。品牌、公司和产品分别保存；原生完整字段与配置通过zip-config提供。
- 八项客户字段以当前任务brief为准；任务编辑默认仅本次，明确save_as_default才同步客户档案。当前可见说明是唯一有效note，历史原话不重复追加到生成要求。新任务优先带出客户常用方案；没有方案时平台空选、启用目标AI全选。确认别名沿用原生分组。
- 一批写作冻结资料和有效配置。正在处理的稿件只读；已经完成的稿件可以编辑。人工修改产生工作版本，ZIP后续标题、FAQ与角度参考继续读取原生生成记录。
- 写作中补充新要求会保存输入、暂停后续。当前篇按ZIP原生流程收尾；确认新安排后再开始续写。超时、断线、截断和不完整结束不会当作成功，也不会自动重复调用。
- 原生事实核查与修改行为保留，初稿和核查后稿分开留档。人工修改版清空旧审核与旧评分，允许直接保存和导出。
- 标题、正文、标签和声明均按版本保存。显式原生重写保留同平台/身份/形态/关键词组/角度，接原生核查；再次核查可按原规则修正文。成功采用可恢复版本，失败保留当前稿；批次运行时需先停止收尾。
- “写下一篇”只执行当前配额中的一个待写项。删除文章或历史采用逻辑删除，保留固定视频来源。历史复用只复制同客户的当前安排与所选资料，建立未生成的新任务。
- 手动去味先通读审阅并分档，再由用户选择建议。允许全文调整，候选默认不采用。候选保存后只做一次只读事实复核；问题留给用户判断，复核不会改正文或开启循环。
- 对话修改基于当前正文产生候选，不调用ZIP整篇重写接口冒充局部修改。compare支持json/md下载，包含前后全文、差异、修改清单、复核及实际提交的Codex/用户评语。
- 文章导出支持docx/md/txt/json，采用当前明确选中的版本，仍调用ZIP原渲染器。处理中稿件暂不能导出。
- 本地归档下载真实ZIP，含有效安排、解析文字、冻结输入、各版正文/原核查/差异/实际审阅意见与当前导出；连接凭据和私有诊断不进入归档。

Word、Excel、PPT与文本资料继续使用ZIP解析器。PDF由前端读取成文字后按资料接口保存，不替换原解析器。

生成后风格参考由 `config/style-library.json` 指向仓库内的 `style-library/`，相对路径按仓库根目录解析。首次ZIP写作不读取该库。去味规则与信号只维护在 `config/de-ai-taste.md`、`config/ai-taste-signals.md`，不再次加载平台风格库中的重复信号。客户限定的认可表达需要显式client_bindings，空绑定不会套用旧客户例句。平台篇幅和结构仅作生成后参考。

## 视频边界

`GET /api/workbench/video-context` 提供只读客户、资料和明确采用版本。显式版本校验客户与文章归属，已采用的固定版本不会随文章编辑变化。未采用候选不能成为视频来源。

main.py通过本机随机内部端口托管视频服务，原路径流式转发 `/api/video/*`、`/video/*`，保留上传、HEAD/Range和下载头。视频数据位于主数据目录/video；启动会检查Node/Python/Pillow及字体、FFmpeg等依赖，只检查，不编码。启动失败会退出主服务并给出私有日志位置。

`GET /api/workbench/runtime` 查看本次主/子进程状态；`POST /api/workbench/video-service/restart {}` 明确重启本次子服务；`POST /api/workbench/shutdown {}` 正常关闭。Windows专属进程Job会在主进程异常退出时清理其后代，不终止其他已有工作台。子服务日志在数据目录/logs。启动不会生成文章、配音或视频。

## 离线验证

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
python tools/check_handoff.py
python tools/check_workbuddy.py
python tests/core/test_effective_inputs.py
python tests/core/test_native_operations.py
node --test tests/frontend/contract.test.mjs tests/frontend/selfcheck.test.mjs
```

上面几条分别检查交接文件与相对风格库、本机连接依赖与配置格式、有效输入事务、原生操作边界、前端契约与发布前自检视图，不访问外部模型或目录。`check_workbuddy.py` 在缺少本机配置时会明确列出缺哪些字段；加 `--live` 才做一次模型目录查询。完整历史 verify.py 还需要原交接 ZIP 等夹具；SDK 测试需要本机配置（占位配置可用于注入 fetch 的离线测试），相关前置条件见交接说明。历史独立 ZIP 回放、Word 正文 XML、并发锁与停止边界的证据见 docs/evidence/。

core-001离线证据的外部调用数为0。core-002另用隔离合成夹具完成了真实WorkBuddy接通和版本边界验收：8次内容调用、1次目录查询，均使用精确模型ID deepseek-v4.1-flash，正常完整结束；原始输入、初稿、核查后稿、候选及只读复核均保留在 [样稿与质量记录](docs/evidence/README.md)。两份样稿仍有流程文字残留、无充分依据的工艺推论与审阅误报，不能据此声称内容质量普遍通过。Codex已实际审阅并保存意见，用户保持未审。视频既有链路已完成 video-005 运行时终验；客户与批次、消息与审阅、连续创作及内部指南已有各自验收记录。需求整理漏回写作说明的提示词约定已修正，6项离线检查通过，实际模型重试尚未验证。工作台视觉动效及后续首页优化由原开发者继续负责。详细状态见开发交接说明。

接口与产品约定见 [docs/integration-contract.md](docs/integration-contract.md)。两套项目合并时逐项核对的功能对照见 [docs/merge-review.md](docs/merge-review.md)。
