# 客户、资料与批量生成接口

2026-11-04 用户确认：客户独立管理，软件保存原件副本；同客户按原文件 SHA-256 去重，名称后缀只提示疑似更新。客户一套常用方案。批量生成不限日期，每次主动提交创建独立批次，同一 request_key 的重发不得重复创建。提交时冻结档案、资料修订、安排及写作配置。文章生成及原生基础核查；视频、去味保留独立入口。

本合同由后端聊天维护，前端聊天只修改 web/、tests/frontend/、DESIGN.md。共同 checkout 为 fangli-workbench，已有前端未提交改动原样保留。先对接以下实际接口，不另建前端生成器。

## 客户与常用方案

- GET/PUT `/api/workbench/clients/{id}`；PUT `{name,profile}` 独立更新客户，profile 的七个字段与现有合同相同，允许空值；历史任务不回写。
- GET `/api/workbench/clients` 返回活动客户，`?archived=1` 返回已归档客户。POST `/api/workbench/clients/{id}/archive|restore` 使用空对象切换状态，保留原 ID。若已有同名活动客户，恢复返回 409。归档后仍可按原 ID 读取档案、资料与历史，创建新任务和提交新批次时只接受活动客户。
- GET `/api/workbench/import-drafts` 列出未确认的导入。POST 同一路径传 `{id,name}`，其中 `id` 为浏览器生成的 UUID，`name` 可留空。草稿的成功正文与失败原件分开保留。失败原件可用 POST `…/documents/{id}/retry` 重试，或传 `{text}` 保存已核对的正文。含正文的草稿通过采用整理结果确认。只含已确认图片等无正文资料时，POST `/api/workbench/import-drafts/{id}/finalize` 传 `{name}` 保存客户。草稿在确认前独立列出。
- 新建、改名、采用整理结果和从任务保存默认档案共用名称规则。全半角、大小写和连续空白规范化后撞名返回 409。旧库已有的同名档案保留原 ID，列表用 `name_conflict` 提示运营处理。
- GET/PUT `/api/workbench/clients/{id}/generation-plan`；PUT `{options,document_ids,expected_revision?}`，options 只接受 keywords/keyword_links/selections/format_overrides/note/rivals/aliases/models。note 是长期要求，keywords 是内容方向的搜索词。每客户一套；GET 返回 `{plan:{revision,options,document_ids},issues,ready}`。批量任务按方案中保存的资料组取最新有效修订。
- `keyword_links` 为有序词对列表 `[[搜索词,关联词],…]`。普通任务继承后可修改本次规则，批次继承并保存到快照。左侧词恰好是该篇主词时，右侧词进入该篇写作要求，由资料支持实际关联。右侧词保留关联身份，篇数及主词分配沿用现有规则。
- POST `/api/workbench/conversations` `{client_id}` 创建普通任务，带出客户常用关键词和别名分组，并默认选中活动资料的有效修订。客户还没有常用方案时沿用已采用的整理关键词。导入后明确传入的 `document_ids` 用于本次任务。GET 任务返回 `available_keywords` 供勾选，已保存的 `brief.keywords` 和 `document_ids` 决定本次选择。任务内调整只保存到本次任务。
- GET `/api/workbench/clients/{id}/history` 返回 conversations 与 batches。
- PUT `/api/workbench/conversations/{id}/profile` 默认只更新本次任务；显式 `{name,profile,save_as_default:true}` 才同步客户长期档案。批次任务已冻结安排，不能修改其任务档案/安排；需要调整时复用或另建批次。

## 资料

- GET `/api/workbench/clients/{id}/documents` 返回最新有效修订及待处理资料，沿用 id/client_id/filename/kind/text/digest；增加 group_id/revision/status/has_original/raw_sha256/original_url/text_url/error。
- POST `…/documents/check` `{filename,sha256,text_digest?}` 在传副本前检查；返回 `{duplicate:document|null,candidates:[],text_matches:[]}`。名称只移除末尾 `(1)`、`（1）`、副本等复制后缀，不用前缀自动合并。
- POST `…/documents` 接受 `{filename,kind?,text?,content_b64?,update_document_id?,as_new?,recognize?}`。文件传 `content_b64`，纯粘贴传 `text`。`recognize:true` 用于本机 PDF 和图片识别，上传时保留原件并返回待处理资料。历史 PDF 路径可同时传浏览器提取的 `text`。`update_document_id` 指向待核对或当前有效修订，`as_new:true` 明确另存。原文件重复时返回已有资料。
- 导入结果 `{outcome:'created'|'updated'|'duplicate'|'needs_resolution'|'pending',document?,candidates?,text_matches?}`。needs_resolution 不写副本；pending 保留原件但未启用，旧有效版不变。
- GET `…/documents/{id}/recognition` 返回 `{recognition:{pages,images,confirmed,error}}`。每页提供页码、文字、状态、错误和预览链接。图片提供来源页码、预览链接和下载链接。POST `…/documents/{id}/retry` 传 `{retry_pages:[页码]}` 识别一页，完成后可传 `{pages:[{page,text}]}` 确认全部页面并形成新修订。无正文的已确认图片保留在资料库，客户档案整理只使用有正文的资料。
- GET `…/documents/{document_id}/revisions` 返回 `{documents}`；GET `…/original` 下载原件；GET `…/text` 下载解析文字。客户归属必须一致；历史未保存原件时 original 返回404，不伪造原件。
- DELETE `…/documents/{document_id}` 使用空对象移出对应资料组，并在同一事务中从常用方案取消默认取材。GET `…/documents?removed=1` 查看已移出资料，原件和修订仍按原 ID 可查。POST `…/documents/{id}/restore` 使原资料组重新可选；只有显式传 `{add_to_defaults:true}` 才会加回默认取材。旧任务保留原来选中的修订。
- 新修订不覆盖旧 wb_documents 行；历史任务仍按原 document_id 读取。资料手工修订通过 documents POST 的 update_document_id + text 创建新修订。

主库 v1 迁移增加客户归档、名称校验和资料移出状态，并为常用方案建立客户外键。迁移事务失败时保留旧结构和版本号。升级前的备份与隔离恢复步骤见 [开发交接](HANDOFF.md#工作区备份与恢复)。

## 批次

- GET `/api/workbench/conversations/{id}` 新增顶层 `batch:null|{id,status,item_id,item_status,frozen:true}`。所有批次来源的任务安排均冻结；需求/资料选择/关键词/平台篇数不允许编辑。模式切换不改变安排，仍允许；稿件人工编辑/采用/导出继续可用。显示“安排已冻结，可复用为新任务调整”，复用建立普通任务，其batch=null。

- POST `/api/workbench/batches/preflight` 接收 `{items:[{client_id,options?,document_ids?,videos?}]}`。`options` 留空时沿用客户方案。`length_hint` 为「短篇」或「长篇」时，按平台与形态的建议区间取下半或上半。无常用方案时可传完整安排，方案修订号为 0。资料默认取最新有效修订。预检汇总客户问题，在本地排题，不调用模型、不创建任务。
- 预检返回 `{ready,issues,total,video_total,items}`。每位客户的结果包含 `client_id`、`name`、`planned`、`options`、`document_ids` 和 `preview:{revision,rows,documents}`。`rows` 按执行安排列出题目、平台、形态、关键词及可用的写法和篇幅提示。依赖文章的视频用 `depends_on` 引用同一客户的文章行 ID。`documents` 列出本次采用的资料 ID、文件名和修订号。
- POST `/api/workbench/batches` `{request_key,items:[…]}`，request_key 为本次点击生成的 UUID，重发用同一值；主动再生成换新值。返回 `{batch}`；同键不同内容409。只在全体预检通过后原子创建批次/任务/输入快照并进入持久队列。
- 快速创作收起时，「开始生成」在预检通过后直接按客户级安排入队。展开时，「预览安排」供逐条换题和取舍，确认提交时附加 `preview:{revision,rows:[{id,topic?}]}`。仅列入保留的行，`topic` 省略时沿用预检题目。服务端复核依据版本、行 ID 和视频依赖，依据过期时返回 400，界面刷新预览并保留版本未变客户的选择和换题。文章结果按预览行绑定。续写补齐未完成行，视频继续使用已固定的文章版本。
- GET `/api/workbench/batches` 返回 `{batches}`；GET `/api/workbench/batches/{id}` 返回 `{batch}`。batch 含 id/status/created_at/total/completed/items；item 含 id/client_id/name/conversation_id/status/planned/completed/error。日期仅显示/筛选。
- POST `…/stop` `{}` 停止未开始项并请求当前篇收尾；POST `…/resume` `{acknowledge_uncertain?:true}` 继续未完成项，已完成项不重跑；有中断/不确定项时需要显式 acknowledge_uncertain。
- 批次状态 queued/running/done/partial/error/stopped/interrupted；item 状态 queued/running/done/error/stopped/interrupted。前端只在 queued/running 时有界刷新（建议3秒），页面隐藏可暂停，终态停止。
- 服务器重启将 running 标记 interrupted，不自动重复在途调用。原先 queued 的安全未开始项保持排队；用户可以明确恢复中断项。运行中另一次主动生成进入队列。

## 界面与既有边界

客户和快速创作均为一级入口。快速创作集中选择客户、调整本批安排和提交生成，客户页管理常用方案与批次记录。对话页只显示资料与安排摘要，关键词按需展开；分步1准备资料与关键词，分步2编辑平台安排。全局规则通过左下角居中设置弹窗管理。对话与分步只主动切换，模式不同于生成/编辑阶段。MiSans、C 留白、左右资料关键词、纯白工作区沿用已确认设计。

目标AI/抓取矩阵为实验写作结构配置，不作为日常必选；GEO只展示具体检查项，移除分数筛选；settings 参数遵守 temperature 0—1.5、max_tokens 800—8000。保留版本、采用、导出、锁、故障恢复；不得把静态预览状态当真实接口结果。
