# 连续创作工作区验收

日期：2026-11-05。范围：对话创作、分步生成、流式只读预览与Markdown展示。

## 验证环境

使用tools/serve_acceptance_fixture.py、独立SQLite及固定供应商替身。服务PID51308，端口56172；数据与运行记录在D:/Codex/方立/output/live-workspace-20261105。正式客户、正式任务和视频队列未写入。真实模型、模型目录查询和媒体编码均为0。本报告证明接口与交互，不评估真实模型内容质量。

## 自动化

命令：node --test tests/frontend/live-workspace.test.mjs tests/frontend/composer-settings.test.mjs tests/frontend/contract.test.mjs tests/frontend/unified-contract.test.mjs

32/32通过。新增覆盖：结构化JSON每个截断位置的安全投影和转义、Markdown表格/嵌套列表/链接/HTML及危险协议、活动与终态、完成后操作、平台及账号配额、修改锁。复用现有草稿隔离、冻结、断线、未确定请求及候选采用合同证据。相关源码node --check及git diff --check通过。

## 内置Browser实际验收

| 场景 | 结果 |
| --- | --- |
| 首次输入→整理→展开稿件 | 同一输入与对话节点保持，活动从整理变为写作和核查；正常等待动画名activity-spin |
| 结构化返回 | 标题、章节、段落、问答增量出现；表格实际成为table，过程JSON默认折叠 |
| 滚动阅读 | 一次真实SSE过程中27个变更观察点均保持向上阅读位置与新内容提示；最终结果见continuity.json的scrollFix |
| 关闭进行中稿件区 | 核查期间关闭，完成后仍关闭；输入成功清空，节点不变。首轮发现未读提示会消失，修复后上行重测通过 |
| 鼠标与键盘调宽 | 鼠标47%→40%，ArrowRight→43%，刷新恢复43% |
| 分步生成 | 真实执行2篇；完成仍留第三步，预览及滚动节点保持；完成态没有start/write-one入口 |
| 对话修改 | 唯一输入生成revision候选；当前采用版4、候选9，后台确认未自动采用；本机回执恢复与候选打开可用 |
| 候选排版 | 对比两侧各有真实table，不显示Markdown表格源码，标题没有重复H1 |
| 桌面/窄屏 | 1440×900双栏，390×844稿件层与返回对话；无文档横向溢出，覆盖层使背景对话退出焦点导航。末轮将分步窄屏清单改为横向，清单高77px、正文滚动区高212px |
| 动态效果偏好 | prefers-reduced-motion为reduce时分区transition-duration为0s；验收后恢复媒体和视口设置 |
| 浏览器错误 | 最终读取error级控制台记录为空 |

## 本机证据

- chat-desktop.png、chat-mobile.png：对话创作。
- steps-desktop.png、steps-mobile.png：分步生成完成态。
- continuity.json：节点、关闭状态及滚动修复后的事件观察结果。
- candidate-boundary.json：采用版与候选分离。
- process.json、server.stdout.log、server.stderr.log：隔离服务归属与日志。

截图及JSON均位于上述output目录。隔离服务在验收后正常关闭。原写作app/未修改；未提交或推送Git，保留工作区原有改动。

正式8770的/workbench及/workbench/live-workspace.mjs均返回200，页面已引用新增样式，无需重启正式服务。隔离服务shutdown接口已返回ok。
