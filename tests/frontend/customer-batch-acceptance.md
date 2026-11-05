# 客户与批次前端验收

日期：2026-11-04。范围：`web/`、`tests/frontend/`、`DESIGN.md`。

## 环境与边界

- 页面连接 `http://127.0.0.1:54308/workbench`，使用实际 HTTP、SQLite 和隔离客户数据。
- 模型由后端注入固定合成响应；真实模型调用、目录查询和视频调用均为 0。
- 隔离服务由后端聊天管理，前端未操作生产数据。

## 实际页面结果

- 永久客户档案修改后保存成功；客户常用方案修订由 1 更新至 3。
- 新建普通任务带出服务端关键词、发布篇数、长期要求和最新有效资料；未被前端空默认覆盖。
- 相同原件按哈希复用。复制后缀文件先确认更新对象，再产生修订 2；历史仍显示两个修订和各自原件下载入口。
- 两次主动提交分别创建独立批次，均为两位客户、两篇，最终均完成 2/2。
  - `2d9032dd-da6f-450c-8d05-a718b4f7e81d`
  - `92738f7f-134b-4637-a8d0-3612c59eab75`
- 批次任务 `7b8e072e-403e-4b0a-b736-434bfe1cfda9` 的文章已正常渲染 Markdown；人工编辑另存工作版本成功。
- 实际 Markdown 下载包含新增的人工编辑段落，采用版本选择与正文一致。
- 普通任务 `4a237d3b-2939-41af-a704-7e8f4d920e26` 从对话入口生成完毕后，`mode-chat` 仍为选中，页面没有分步进度条。
- 主工作区白底，MiSans 生效；1440×1000 下没有横向溢出。客户区域宽度修正后为 1196px。
- 客户页可以打开全局设置；温度 0–1.5、最大输出 800–8000，界面与提交校验读取 bootstrap.setting_limits。

## 最小检查

- `node --test tests/frontend/customer-batch.test.mjs tests/frontend/unified-contract.test.mjs`：18 项通过，新增监视竞态测试的 mock 缺少事件方法导致 1 项失败。
- 补全该 mock 后，`node --test --test-name-pattern='切换批次' tests/frontend/customer-batch.test.mjs`：1 项通过。两文件共 19 项的最终有效结果全部通过。
- 本轮之前 26 项通过的基础合同证据继续复用，不重复执行未受影响的测试。
- `node --check web/workbench/app.mjs` 通过；浏览器执行覆盖客户模块与导入、批次模块。

## 截图与下载

- `C:/Users/Administrator/.codex/visualizations/2026/11/04/01a1a5cf-ad42-7b92-aff9-710f55a5fc11/customer-workspace.png`
- `C:/Users/Administrator/.codex/visualizations/2026/11/04/01a1a5cf-ad42-7b92-aff9-710f55a5fc11/customer-documents.png`
- `C:/Users/Administrator/.codex/visualizations/2026/11/04/01a1a5cf-ad42-7b92-aff9-710f55a5fc11/customer-batch-result.png`
- `C:/Users/Administrator/.codex/visualizations/2026/11/04/01a1a5cf-ad42-7b92-aff9-710f55a5fc11/customer-batch-article.png`
- `D:/Downloads/方立-7b8e072e-403e-4b0a-b736-434bfe1cfda9.md`

## 剩余限制

- 这轮证据验证数据和交互链，不评价真实模型生成质量。
- 批次冻结提示缺口已修复：任务读取返回的 batch 元数据保存在 client.state.batch；需求、客户快照、资料选择、关键词和平台安排直接只读，并提供复用入口。普通任务 batch=null 可正常编辑；模式切换、正文人工编辑、版本采用和导出保持可用。
- 原件历史缺失时不伪造下载内容；重复历史原件不会隐式回退当前资料选择。
- 修改保留在当前工作区，未提交、未推送。

## 批次冻结标识收尾修复

- 只增加一个 client 状态 focused 测试，命令 `node --test --test-name-pattern='任务读取保留批次冻结' tests/frontend/customer-batch.test.mjs`，1/1 通过；复用前 19 项及完整流程证据，不重跑全套。
- 冻结读取会丢弃旧的本地需求暂存，避免旧暂存覆盖已提交快照；复用读取 batch=null 后解除限制。
- 页面边界确认：原批次任务 `7b8e072e-403e-4b0a-b736-434bfe1cfda9` 的需求和关键词 readOnly=true，资料选择按钮 disabled=true；切换至分步后，篇数 readOnly=true、形态 disabled=true。
- 页面“复用为新任务”创建普通任务 `5ed88ef0-f1c9-4f1f-8a4e-e203ef78fac9`：冻结提示消失，需求和关键词 readOnly=false，资料选择与平台安排按钮恢复可用。未再次生成。
- 冻结页面截图：`C:/Users/Administrator/.codex/visualizations/2026/11/04/01a1a5cf-ad42-7b92-aff9-710f55a5fc11/customer-batch-frozen.png`。
