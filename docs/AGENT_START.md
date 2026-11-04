# 开发 Agent 接手提示词

把下面整段提示词复制给同事使用的开发 Agent，并在末尾补上本次任务。如果尚未确定具体任务，Agent 应先按交接快照核对当前项目，再提出最值得继续的一项具体工作。

````text
你要接手并继续开发“方立内容工作台”。请实际完成本次任务的分析、实现、验证和 Git 交付，不要停在计划。

仓库：https://github.com/stupdada/fangli-workbench
开发基线：main
本次任务：见本提示词末尾；如果末尾尚无具体任务，先核对交接待办和最新代码，选出下一项可执行工作并说明依据，再继续可独立完成的准备工作。

请优先使用中文交流，文本与代码默认 UTF-8。先读仓库适用的 AGENTS.md，再读 docs/HANDOFF.md。它是 2026-11-04 的交接快照；开始工作时需要结合最新提交和当前源码确认状态，不能凭快照重复实现已完成能力。

一、先确定本机目录与 Git 状态

如果已有本项目目录，直接使用合适的现有 checkout。如果尚未指定位置，可以先简短询问目标路径，并说明默认使用当前工作目录下的 fangli-workbench；当前目录适合且没有关键歧义时按该默认继续，不要一次询问所有环境和风格偏好。目标路径已存在时先检查其内容，不能覆盖。

新目录克隆：

```powershell
git clone https://github.com/stupdada/fangli-workbench.git
Set-Location fangli-workbench
```

已有目录或克隆后，集中检查：

```powershell
git rev-parse --show-toplevel
git remote get-url origin
git status --short --branch
git branch --show-current
```

确认 origin 指向本项目后运行 git fetch origin。私有仓库需使用同事自己的 GitHub 权限；凭据通过本机安全配置维护，不能写进仓库、文档或命令记录。如果 origin 不符，先说明实际差异，再决定使用正确目录，不能静默改掉他人的 remote。

工作区干净时，从 origin/main 创建明确命名的功能分支，例如：

```powershell
git fetch origin
git switch -c feature/editorial-quality origin/main
```

已有本次任务的功能分支时可继续使用。若存在他人未提交修改，保留并识别归属，只操作本次范围；能隔离时继续，实际冲突影响结果时才提出具体问题。不得 force push、reset 或覆盖用户改动，不自动 push main。

二、建立完整项目认识

按顺序阅读：

1. docs/HANDOFF.md、README.md、PRODUCT.md。
2. docs/integration-contract.md、video/README.md。
3. 本次任务涉及的源码、测试和 docs/evidence/ 中已有证据。

项目包含 app/ 原 ZIP 核心、bridge/ 后台整合、web/ 双模式前端，以及 video/ 无声视频。主链路是客户和资料 → 有效安排 → 可选访谈 → 冻结输入 → 原 ZIP 生成及原生核查 → 工作版本与候选 → 明确采用 → 导出或手动制作固定版本视频。请先按输入、处理流程、状态变化、输出和上下游影响检查本次任务。

后续重点是文案优化，但开发范围应覆盖实现目标所需的完整业务链。按本次具体需求确定必要修改范围。首次 ZIP 保真是当前验收基线；明确的新需求可以评估必要改动，同时更新合同、证据和相应验证。

三、正确识别文案与视频路径

首次文章生成目前走 app/generator.py 和 app/prompts.py。

生成后去味由 bridge/editing.py 的 style_review / style_rewrite 执行，实际读 config/de-ai-taste.md；审阅还读 config/ai-taste-signals.md 与适用平台参考。应用调用 WorkBuddy 的精确模型 ID deepseek-v4.1-flash，不是宿主 Agent 自动执行技能。应用 default_mode 为 full，而原机宿主去味技能默认为 standard。比较效果时记清入口、规则、所选建议和幅度。

网页“修改当前稿”走同文件 revise 的独立提示词，形成修改候选；它与去味候选流程不同。去味候选保存后尝试一次只读事实复核，复核失败也保留候选；明确采用之前默认稿不变。不要把模型审核 pass 当作人工质量确认。

风格库只供生成后审阅使用；client_bindings 决定客户专属表达是否适用。认可表达不提供本次客户事实。真实样稿已有删除重复和内部过程说明的收益，也有无依据工艺推论和审核漏报、误报。请用资料、原稿、候选、差异和实际审阅意见评估修改，不能只根据接口成功判断文案质量。

主站前端交接时仍在完成增量布局和异步状态的收尾检查；视频子服务受控重载及实时 409／草稿保持终验已通过。先查看最新提交和证据。正式项目之外的 fangli-readability-preview 待用户评审。四方向视频文案模块与八稿实测已收录于 docs/reference/video-authoring/，待评审接入生产，八稿有失败及样例复用问题。写作策略参考见 docs/reference/editorial/。依据当前源码、模块文档和验收证据确认接入待办。

四、配置和运行

推荐 Python 3.11、Node.js 20+。app/bridge 业务代码是 Python 标准库，SDK 已捆绑，无 npm 安装步骤。完整主站会托管视频，因此还需 requirements-video.txt 中的 Pillow、FFmpeg、ffprobe 和受支持中文字体。按 README 与 HANDOFF 核对依赖，确认 config/workbuddy.example.json、style-library/ 便携配置和相对路径实际存在。

将连接示例复制为本机 config/workbuddy.json，再通过安全渠道填入自己的连接设置；真实文件不进 Git。模型目录校验只在明确模型操作时发生，缺少所选模型应停止，不能自动换模型。

在根目录使用 PowerShell 7，设置 UTF-8：

```powershell
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
python tools/check_handoff.py
python tools/check_handoff.py --runtime
```

需要运行时使用隔离数据目录和系统分配端口：

```powershell
python main.py --no-browser --port 0 --data-dir ./data/dev-workbench
```

按终端实际 URL 访问 /、/workbench、/workbench/zip、/video/。每个数据目录只允许一个主进程。先确认已有服务和活动任务；源码变化需要重载时协调使用者，使用项目正常生命周期接口管理本次拥有的子服务。不得扫描并终止无关工作台。

五、执行与验证

基于最合理理解给出最小完整方案，先说明关键假设；仅在关键歧义会显著改变方案或风险时停下来澄清。持续推进实现，修复本次范围内的问题，不擅自扩展业务目标。

验证按状态变化和独立风险边界选择最小充分集合。先使用 tools/check_handoff.py，再按修改范围选 focused checks；已有证据仍有效时复用。历史保真、部分前端和视频测试可能依赖仓库外原 ZIP/output 夹具及字体哈希，先检查前提，缺失时记录 unverified 或修复便携夹具，不要声称已通过。真实模型调用、目录查询、视频编码与浏览器验收分别报告，离线检查不自动触发这些操作。

对 localhost 或本地 HTML 的验收优先使用内置 @Browser，并复用现有标签页。只有必要能力缺口时才说明原因并改用其他浏览器工具。结束内置 Browser 会话须保留有效标签页；不能调用无 keep 的 tabs.finalize。

更新受影响的文档与证据。用清楚的结果和风险说明变化，正文、注释和 PR 面向接手读者描述当前行为。未经执行的测试、未经审阅的内容和未完成的接线必须明确标注。

六、Git 交付

实现和必要验证完成后，检查差异，明确暂存本次文件：

```powershell
git diff --check
git diff
git add <本次确认的文件>
git diff --cached
python tools/check_handoff.py --staged
git commit -m "说明本次具体行为变化"
git push -u origin <当前功能分支>
```

将 UTF-8 PR 正文写入本机文件，例如 data/pr-body.md，内容包括具体问题、实现后行为、验证结果、剩余前提。确认本次提交不含连接凭据、客户运行数据或私有日志，再创建面向 main 的 PR：

```powershell
gh pr create --base main --head <当前功能分支> --title "说明本次具体变化" --body-file ./data/pr-body.md
```

如果远程权限、网络或 gh 登录阻塞，完成本地可做部分，给出确切阻塞点和恢复步骤；不能虚报已 push 或已建 PR。最终报告提供提交/PR、业务行为变化、验证及未验证项、剩余待办，便于同事审查和继续开发。

本次具体任务：
（在这里补充需求；也可以直接在提示词后追加自然语言任务。）
````
