# 客户、资料与批量生成接口

2026-11-04 用户确认：客户独立管理，软件保存原件副本；同客户按原文件 SHA-256 去重，名称后缀只提示疑似更新。客户一套常用方案。批量生成不限日期，每次主动提交创建独立批次，同一 request_key 的重发不得重复创建。提交时冻结档案、资料修订、安排及写作配置。文章生成及原生基础核查；视频、去味保留独立入口。

本合同由后端聊天维护，前端聊天只修改 web/、tests/frontend/、DESIGN.md。共同 checkout 为 fangli-workbench，已有前端未提交改动原样保留。先对接以下实际接口，不另建前端生成器。

## 客户与常用方案

- GET/PUT `/api/workbench/clients/{id}`；PUT `{name,profile}` 独立更新客户，profile 的七个字段与现有合同相同，允许空值；历史任务不回写。
- GET/PUT `/api/workbench/clients/{id}/generation-plan`；PUT `{options,document_ids,expected_revision?}`，options 只接受 keywords/selections/format_overrides/note/rivals/aliases/models。note 是长期要求，keywords 是内容方向的搜索词。每客户一套；GET 返回 `{plan:{revision,options,document_ids},issues,ready}`。默认资料按稳定资料组保存，新任务取该组最新有效修订。
- POST `/api/workbench/conversations` `{client_id}` 默认带出客户常用方案及最新有效资料；没有方案时保留空安排。当前任务临时改动不会保存为方案。
- GET `/api/workbench/clients/{id}/history` 返回 conversations 与 batches。
- PUT `/api/workbench/conversations/{id}/profile` 默认只更新本次任务；显式 `{name,profile,save_as_default:true}` 才同步客户长期档案。批次任务已冻结安排，不能修改其任务档案/安排；需要调整时复用或另建批次。

## 资料

- GET `/api/workbench/clients/{id}/documents` 返回最新有效修订及待处理资料，沿用 id/client_id/filename/kind/text/digest；增加 group_id/revision/status/has_original/raw_sha256/original_url/text_url/error。
- POST `…/documents/check` `{filename,sha256,text_digest?}` 在传副本前检查；返回 `{duplicate:document|null,candidates:[],text_matches:[]}`。名称只移除末尾 `(1)`、`（1）`、副本等复制后缀，不用前缀自动合并。
- POST `…/documents` `{filename,kind?,text?,content_b64?,update_document_id?,as_new?}`。文件要传 content_b64；PDF 同时传浏览器提取的 text（现有本机 PDF 解析器）。其他格式由后端重新解析。纯粘贴只传 text。update_document_id 指向该组当前有效修订；as_new=true 明确另存。原文件重复直接返回已存在的 document。
- 导入结果 `{outcome:'created'|'updated'|'duplicate'|'needs_resolution'|'pending',document?,candidates?,text_matches?}`。needs_resolution 不写副本；pending 保留原件但未启用，旧有效版不变。
- GET `…/documents/{document_id}/revisions` 返回 `{documents}`；GET `…/original` 下载原件；GET `…/text` 下载解析文字。客户归属必须一致；历史未保存原件时 original 返回404，不伪造原件。
- 新修订不覆盖旧 wb_documents 行；历史任务仍按原 document_id 读取。资料手工修订通过 documents POST 的 update_document_id + text 创建新修订。

## 批次

- GET `/api/workbench/conversations/{id}` 新增顶层 `batch:null|{id,status,item_id,item_status,frozen:true}`。所有批次来源的任务安排均冻结；需求/资料选择/关键词/平台篇数不允许编辑。模式切换不改变安排，仍允许；稿件人工编辑/采用/导出继续可用。显示“安排已冻结，可复用为新任务调整”，复用建立普通任务，其batch=null。

- POST `/api/workbench/batches/preflight` `{items:[{client_id,options?,document_ids?}]}`。options 为本次覆盖，留空沿用方案。一次汇总所有客户问题；不调用模型、不创建任务。返回 `{ready,issues:[{client_id,error}],total,items:[{client_id,name,planned,options,document_ids}]}`。
- POST `/api/workbench/batches` `{request_key,items:[…]}`，request_key 为本次点击生成的 UUID，重发用同一值；主动再生成换新值。返回 `{batch}`；同键不同内容409。只在全体预检通过后原子创建批次/任务/输入快照并进入持久队列。
- GET `/api/workbench/batches` 返回 `{batches}`；GET `/api/workbench/batches/{id}` 返回 `{batch}`。batch 含 id/status/created_at/total/completed/items；item 含 id/client_id/name/conversation_id/status/planned/completed/error。日期仅显示/筛选。
- POST `…/stop` `{}` 停止未开始项并请求当前篇收尾；POST `…/resume` `{acknowledge_uncertain?:true}` 继续未完成项，已完成项不重跑；有中断/不确定项时需要显式 acknowledge_uncertain。
- 批次状态 queued/running/done/partial/error/stopped/interrupted；item 状态 queued/running/done/error/stopped/interrupted。前端只在 queued/running 时有界刷新（建议3秒），页面隐藏可暂停，终态停止。
- 服务器重启将 running 标记 interrupted，不自动重复在途调用。原先 queued 的安全未开始项保持排队；用户可以明确恢复中断项。运行中另一次主动生成进入队列。

## 界面与既有边界

客户作为一级入口，批量生成继续从客户多选进入。对话页只显示资料与安排摘要，关键词按需展开；分步1准备资料与关键词，分步2编辑平台安排。全局规则通过左下角居中设置弹窗管理。对话与分步只主动切换，模式不同于生成/编辑阶段。MiSans、C 留白、左右资料关键词、纯白工作区沿用已确认设计。

目标AI/抓取矩阵为实验写作结构配置，不作为日常必选；GEO只展示具体检查项，移除分数筛选；settings 参数遵守 temperature 0—1.5、max_tokens 800—8000。保留版本、采用、导出、锁、故障恢复；不得把静态预览状态当真实接口结果。
