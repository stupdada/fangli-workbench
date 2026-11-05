# 客户资料整理

在客户页的「资料」上传原件或粘贴文字，选择当前有效资料后点击「整理所选资料」。在「整理档案」核对当前字段与资料建议，按需修改档案、概览、关键词、重要说法和冲突说明，再点击「确认保存」。来源展示文件名、修订及原文摘录。默认保留已经填写的档案；已有值与资料不一致时可逐项采用建议。客户原件及历史修订沿用原有资料库。

业务概览和客户档案分开，重要说法及冲突留在编辑侧。`client_provided` 表示从本次资料提取，`editor_edited` 表示该条说法已手动改动。`public_check_status: not_checked` 表示尚未进行公开核对。应用校验每条摘录与所选原文一致；释义、事实选择和冲突仍由编辑核对。

## 主服务接线

在 `Service.__init__` 初始化 `guard`、`threads`、`cancellations`、`ws` 和本机供应商后，建立一个 `self.intake = ClientIntake(self)`（`from .client_intake import ClientIntake`）。模块使用服务的精确模型校验与生命周期线程表；现有 `Service.close()` 会停止并等待这些线程。模块自行建表并恢复异常退出后的运行记录。请在现有工作台的同源 JSON 路由中接入以下四条，沿用 `Handler._json` 和 `Problem` 状态码处理：

| 方法与路径（前缀 `/api/workbench/clients/{cid}`） | 调用和响应 |
| --- | --- |
| `POST /intakes` | `s.intake.start(cid, body)`；`{document_ids:[…], retry?:false}` → `{intake, reused}` |
| `GET /intakes` | `s.intake.latest(cid)` → `{intake}`，没有记录时为 `null` |
| `GET /intakes/{id}` | `{'intake': s.intake.get(cid, id)}` |
| `POST /intakes/{id}/adopt` | `s.intake.adopt(cid, id, body)` → `{client,intake}` |

`intake.status` 为 `running`、`ready`、`error` 或 `interrupted`。`ready` 时返回 `result`，含 `profile_suggestion`（名称及七个档案字段）、`profile_sources`、`keywords[]`、`overview`、`important_claims[]`、`conflicts[]`。每条 `source_refs[]` 为 `{document_id,filename,revision,digest,quote}`。`sources[]` 为冻结资料的身份和修订信息。页面只在运行期间有界刷新；错误后由使用者明确重试。`attempts` 为通过模型目录校验后进入内容请求的次数。相同客户、相同资料修订集合、相同规则和模型设置共用记录；读取或重复开始不重复请求内容。原请求和原始返回留在工作数据目录的 `traces/{id}/{attempt}/`。

采用请求为 `{name,profile,editorial,expected_profile_version,expected_adoption_id}`。`profile` 是全部七个正式字段，`editorial` 是允许人工改动的结果对象，初始采用可用 `intake.result`，继续修改可从 `intake.adoption.editorial` 开始。基准值取打开确认时响应，初次 `expected_adoption_id` 为 `null`。保存事务检查档案指纹、上一次采用编号及来源是否仍为当前修订；变化返回 409。写入同时更新 `wb_clients` 与采用记录，旧任务快照不变。其他客户的整理 ID 返回 404。

前端已在 `CustomersWorkspace` 内接入上述四条路由，样式由组件加载。创作侧继续读取正式 `client.profile` 和本次选定的资料；若接入编辑信息，只在 `intake.adoption` 存在且 `intake.sources` 与本次选定资料修订一致时，读取 `adoption.editorial`。关键词建议不会覆盖常用方案。禁止把未采用的建议或核对状态直接拼进面对读者的文稿。

## 重要说法的公开出处

「查找公开出处」仅提交编辑填写的一行公开检索词。工作台服务从进程环境读取已有 `DASHSCOPE_API_KEY`，通过[百炼 WebSearch MCP](https://help.aliyun.com/zh/model-studio/mcp-external-calls)检索。独立搜索无需内容模型。打开整理结果、采用档案和读取旧记录都只使用本地数据。

搜索返回候选出处或无结果。候选的摘要帮助筛选。编辑打开原厂、发证机构或原始资料，填写逐字摘录、适用主体和条件，选择「已找到公开依据」或「公开出处与说法有冲突」，由工作台记录核对时间。`not_checked`、`candidates`、`no_result`、`supported`、`conflict` 分别对应尚未核对、待核对候选、未返回出处、编辑已找到依据和编辑发现冲突。连接或回执错误保留原状态。

| 方法与路径（前缀 `/api/workbench/clients/{cid}`） | 调用和响应 |
| --- | --- |
| `POST /intakes/{id}/claims/{claim_key}/search` | `s.intake.search_claim(cid, id, claim_key, body)`，`{query}` → `{intake,check,reused}` |
| `POST /intakes/{id}/claims/{claim_key}/review` | `s.intake.review_claim(cid, id, claim_key, body)`，`{expected_revision,status,url,source_type,quote,subject,conditions,source_url?,source_title?}` → `{intake,check}` |

整理结果中的每条说法包含 `claim_key`、`public_check_status` 和 `public_check`。未搜索时 `public_check` 为 `null`。核对记录以客户、说法、对应资料的修订和逐字引用为复用边界。保存核对结论时检查当前记录修订，`url` 是本次搜索的候选入口。编辑循候选页查阅产品原页或技术资料后，可一并填写 `source_url` 和 `source_title`。证据的 `url` 和 `title` 记录实际用于判断的出处，`candidate_url` 和 `candidate_title` 保留检索入口。两项留空时直接采用候选。服务端校验网址格式，由编辑打开并核对原文。接口接受当前整理结果或已采用档案中的说法。

稿件审阅侧可在 `Service.adopted_intake_editorial()` 对已匹配的采用结果调用 `self.intake.enrich_editorial(cid, adopted)`。显示 `public_check_status` 及 `public_check.evidence` 中的出处、摘录、主体、条件和时间。新任务冻结当时的编辑证据，旧任务沿用既有快照。
