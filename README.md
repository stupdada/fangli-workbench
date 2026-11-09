# 方立内容工作台

本机工作台，保留原交接 ZIP 的首次写作、取材、原生核查与正文导出。`app/` 为字节不变的原始代码；`bridge/` 提供 WorkBuddy 传输、客户资料、共享草稿、版本和 HTTP 服务。两个入口共同操作同一个内容任务。

## 启动

开发交接与后续工作见 [docs/HANDOFF.md](docs/HANDOFF.md)，给接手开发 Agent 的完整提示词见 [docs/AGENT_START.md](docs/AGENT_START.md)。2026-11-05 的交接分支为 `feature/customer-batch-storage`；同事从提供的交接提交继续开发，无需等待合并 main。已有本机配置与源码修改按接手说明保留，验收范围以各报告为准。

建议 Python 3.11+、Node.js 20+。文章后端使用 Python 标准库，SDK 已随仓库提供，无需安装 npm 包。整站启动会托管视频服务，需要 Pillow、FFmpeg/ffprobe 和中文字体。客户 PDF 与图片识别需要另外安装 OCR 依赖。

```powershell
python -m venv .venv
& ./.venv/Scripts/python.exe -m pip install -r requirements-video.txt -r requirements-ocr.txt
if (-not (Test-Path -LiteralPath config/workbuddy.json)) {
    Copy-Item config/workbuddy.example.json config/workbuddy.json
}
```

把 `config/workbuddy.json` 中的三个占位值替换为自己的有效 WorkBuddy 配置。该文件被 Git 忽略；配置示例不可用于真实模型调用。SDK为 `vendor/workbuddy-sdk.js`，连接只在服务端读取。FFmpeg/ffprobe 需位于 PATH；Windows 使用微软雅黑，Linux 字体路径要求见视频引擎说明。打开页面不会主动调用外部模型。

双击 `启动.bat` 使用项目的 `.venv`，或在此目录运行：

```powershell
& ./.venv/Scripts/python.exe main.py
```

默认入口 `http://127.0.0.1:8770/` 和 `/workbench` 打开工作台开始页。展示页为 `/index.html`，内部使用指南为 `/guide/index.html`，视频为 `/video/`。同一次启动自动拉起并管理视频子服务，终端输出实际主端口、主PID及视频PID。关闭窗口或Ctrl+C退出。`启动_开发模式.bat` 保留终端但不自动打开浏览器。

可指定独立数据目录、端口或让系统分配端口：

```powershell
& ./.venv/Scripts/python.exe main.py --no-browser --port 0 --data-dir "./data/dev-workbench"
```

默认库为 `data/workbench/workbench.db`，新客户和稿件为空，仅初始化ZIP配置种子。不会迁移旧库。每个库只允许一个服务进程，避免另一进程清除在途锁。数据、模型调用记录与快照均不作为静态文件发布。仅监听127.0.0.1，使用页面显示的同源地址访问。

左侧 GEO 检测下方的「文案训练台」提供同题片段和全文盲选，可以加自由评语、原文选段和改写。两类盲选评完后，WorkBuddy 自动分析本轮反馈，也可从「本轮结果」提前分析已评样本。用候选提示词开下一轮时，输入新题，逐题比较现有写法和候选写法。试验稿、提示词、反馈及模型原返存入运行目录的 `writing-lab.sqlite3`，并随工作区备份保存。训练批次暂停后可继续尚未调用的稿件。

在「工作台设置 → 写作模型」选择 WorkBuddy 或本地 API，再保存。默认使用 WorkBuddy 的 `deepseek-v4.1-flash`，启动写作时核对精确模型 ID。已启动的操作及已提交的批次使用各自保存的模型来源和 ID。

本地 API 由工作台进程自动读取环境变量。它识别 `DEEPSEEK_API_KEY` 和 `DASHSCOPE_API_KEY`，默认模型分别为 `deepseek-flash` 和 `qwen-plus`。可用相同前缀的 `_BASE_URL` 和 `_MODEL` 变量指定区域地址或默认模型。其他 OpenAI Chat Completions 兼容服务通过 `GEO_LLM_BASE_URL`、`GEO_LLM_API_KEY` 配置，可用 `GEO_LLM_MODEL` 预填模型。修改环境变量后重启工作台。设置页只显示识别到的配置，实际调用由对应 API 校验。

### 局域网访问

在可信的办公网内使用时，保持主服务运行，在 `data/lan-http/access.json` 配置主机局域网 IPv4、允许访问的网段和端口，例如 `{"address":"192.168.5.17","subnet":"192.168.5.0/24","port":8770}`。从仓库根目录运行 `node tools/lan-gateway.cjs data/lan-http`，并在 Windows 防火墙仅放行该网段到这个监听地址和端口的 TCP 入站。主服务默认使用本机 `8770`，修改主服务端口时在网关配置中设置 `upstreamPort`。

同网段设备打开 `http://192.168.5.17:8770/` 即进入同一套工作台并共享服务端数据。访问不需要证书或登录，网段内能访问的设备拥有业务操作权限。关停、视频服务重启和 GEO 连接修改仍通过本机入口执行。长期使用时，在路由器中为主机保留该地址。

在本机入口 `http://127.0.0.1:8770/` 可以通过「设置 → 文件下载路径」指定稿件和任务 ZIP 的保存位置，默认使用项目下的 `下载` 文件夹。同事从局域网入口导出时，由各自的浏览器下载，可在浏览器的下载设置中设置默认位置或每次选择目录。

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

Word、Excel、PPT 与文本资料使用 ZIP 解析器。客户资料支持本机识别 PDF、JPG、PNG、WebP、BMP、TIFF 和 HEIC/HEIF。PDF 逐页读取文字层，扫描页和嵌入图片使用本机 CPU OCR。可逐页核对文字、预览原页、下载提取出的图片。客户资料识别的 PDF 最多 50 MB，其他文件最多 8 MB。PDF 和多页 TIFF 最多 100 页。使用识别功能前，请在运行工作台的 Python 环境安装 `requirements-ocr.txt`。从识别后的文字整理客户档案时，仍使用已配置的 WorkBuddy 模型。

普通任务的首次写作沿用 ZIP 生成器，按平台、账号身份和发布形态读取 `style-library/` 的适用写法。展开“本次可选调整”可设本次篇幅；本次明确值优先，其次采用客户常用方案里的篇幅偏好，最后采用平台对应形态的默认篇幅。风格只影响写法，业务依据来自本次客户档案和选定资料。在稿件的资料面板可查看“本版创作配置”。适用规则、认可表达、风格版本及资料修订随本次输入冻结。去味仍为生成后的独立编辑操作，使用 `config/de-ai-taste.md` 和 `config/ai-taste-signals.md`。

## 视频边界

`GET /api/workbench/video-context` 提供只读创作上下文。可选 `conversation_id` 或 `document_ids` 指定本次资料，或同时给出 `article_id` 与 `version_id` 读取明确采用过的固定文章。固定文章使用该版的冻结客户、资料与写作配置，正文与编辑记录分别提供。归属及采用校验沿用现有边界。

main.py通过本机随机内部端口托管视频服务，原路径流式转发 `/api/video/*`、`/video/*`，保留上传、HEAD/Range和下载头。视频数据位于主数据目录/video；启动会检查Node/Python/Pillow及字体、FFmpeg等依赖，只检查，不编码。启动失败会退出主服务并给出私有日志位置。

`GET /api/workbench/runtime` 查看本次主/子进程状态；`POST /api/workbench/video-service/restart {}` 明确重启本次子服务；`POST /api/workbench/shutdown {}` 正常关闭。Windows专属进程Job会在主进程异常退出时清理其后代，不终止其他已有工作台。子服务日志在数据目录/logs。启动不会生成文章、配音或视频。

## 离线验证

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
python tools/check_handoff.py
python tests/core/test_effective_inputs.py
python tests/core/test_native_operations.py
python -B -m unittest discover -s tests/core -p test_creation_context.py
python -B -m unittest discover -s tests/core -p test_first_generation_style.py
```

以上检查覆盖交接文件、有效输入、原生操作、首次模型提示词及版本来源，不访问外部模型或目录。历史 `verify.py` 的原 ZIP 请求逐字回放适用于交接基线，普通任务新写法以首次生成和固定来源检查为准；原始哈希与历史证据保留在 `tests/zip-core.sha256.json` 和 `docs/evidence/`。SDK 测试的本机配置前置条件见交接说明。

core-001离线证据的外部调用数为0。core-002另用隔离合成夹具完成了真实WorkBuddy接通和版本边界验收：8次内容调用、1次目录查询，均使用精确模型ID deepseek-v4.1-flash，正常完整结束；原始输入、初稿、核查后稿、候选及只读复核均保留在 [样稿与质量记录](docs/evidence/README.md)。两份样稿仍有流程文字残留、无充分依据的工艺推论与审阅误报，不能据此声称内容质量普遍通过。Codex已实际审阅并保存意见，用户保持未审。视频既有链路已完成 video-005 运行时终验；客户与批次、消息与审阅、连续创作及内部指南已有各自验收记录。需求整理漏回写作说明的提示词约定已修正，6项离线检查通过，实际模型重试尚未验证。工作台视觉动效及后续首页优化由原开发者继续负责。详细状态见开发交接说明。

接口与产品约定见 [docs/integration-contract.md](docs/integration-contract.md)。
