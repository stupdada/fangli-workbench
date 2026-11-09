# 方立整合接口与产品约定

本文件记录用户已确认的实现边界及执行线程共用接口。当前交付为本机可用网站，不含公网注册、多租户部署、自动发布或公开网效果检测。

2026-11-04 客户长期资产与批量生成增量见 [客户与批次合同](customer-batch-contract.md)。该合同优先描述独立客户更新、原件持有/哈希去重/不可变资料修订、客户常用方案及不限日期的多批队列。任务档案默认仅本次，save_as_default:true才同步客户；新任务可沿用客户方案。以下原 ZIP 底座与版本保护继续适用。

## 产品行为

- 原始 ZIP 为文章生成的底座。普通任务经 `app/generator.py` 和 `app/prompts.py` 将有效风格、篇幅和写作规则加入首次请求；在单份与总预算内使用完整资料，长资料沿用相关性截取。关键词分组、原生核查和导出继续使用原生路径。原 ZIP 哈希留作历史证据；变更的两个核心文件由 `tests/first-generation-core.sha256.json` 固定当前字节。
- 业务模型为 WorkBuddy，默认 `deepseek-v4.1-flash`，运行时核对可用性，不静默切换。连接设置不得出现在静态资源或错误详情中。
- 两种可切换创作方式：对话创作与 ZIP 分步创作。共享同一任务、参数、客户资料、稿件、版本和运行状态。切换先保存草稿，不新建任务、不发模型请求、不清空选择。
- 创作方式在当前文档切换并同步任务URL，保留未发送消息及各模式的步骤与阅读位置。保存失败保持当前视图；连续选择以最后一次选择为准，迟到保存结果不得切换新任务。分步页面沿用原有业务操作，仅增加方向过渡。
- 对话创作以单一消息输入框与消息流为主；消息草稿独立于当前有效options.note。客户、资料数量和发布安排只显示摘要，关键词与有效说明按需打开。分步1负责资料/关键词/本次要求，分步2集中维护平台/身份/形态/篇数。全局模型、平台规则、风险与实验配置进入居中设置弹窗；客户永久信息仍在客户页管理。
- 平台保留 ZIP 全部已启用平台，官方号与个人号分别计数。新任务带出客户常用方案，无方案时平台空选；选择平台可默认一篇。发布形态来自平台formats配置。短视频文案不等于视频合成。
- 对话可连续追问，不设固定轮数；每问简短、给建议，已知不重问，可手动关闭或直接开始。关掉后使用可见默认配置；只拦无法执行的关键缺项，业务事实不靠默认值补造。
- 批量生成仅锁当前正在处理的稿件；已完成稿可编辑。编辑产生工作版本，ZIP 后续读取冻结的生成参考，不受人工修改影响。后端也要拒绝处理中稿件的修改/版本切换/重复处理。
- 生成途中出现新的生成要求，暂停后续任务，保留已有结果；用户确认新安排后继续。不确定的超时/断线停止后续，由用户明确重试，不重复可能已执行的调用。
- 原始 ZIP 的原生事实核查行为保留，初稿与核查后稿留档；人工修改新版本不继承旧核查结论，不强制自动重核或阻止保存导出。
- 生成后手动去 AI 味：通读审阅、建议选择、允许全文重组。生成候选稿后自动做一次只读事实复核，报告问题但不自动改稿，不反复润色。默认查看/导出仍是 ZIP 成稿，明确采用候选后才切换。保留前后全文、差异、核查、Codex审阅及用户意见；不得伪造“Codex已审阅”。
- 普通任务首次写作按平台、账号身份、发布形态匹配风格库；本次要求优先于客户篇幅偏好和平台默认。风格规则及认可表达提供写法，当前客户资料与确认档案提供业务事实。首次生成与生成后审阅独立；与 de-ai-taste 重复的信号只维护一份。
- 视频独立创建，文章提供手动“制作视频”入口，绑定当前采用的稿件版本；不在每篇文章后自动生成视频稿。首版视频不加去味。使用最新无声视频模块的成熟分屏/素材/合成/停止重试能力，旧配音包不混入。视频文字流程需相同资料、选题和模型比较 ZIP 与当前视频流程后择一，不预设当前视频文案已验证。
- 读者稿直接说明主题、产品、服务和步骤。普通建议按建议表达，适用条件放在对应叙述中；资料缺项、待核对问题和取材过程留在编辑侧。具体数值、经历、地址、资质及服务承诺使用当前客户依据。

## 接口通则

主服务同源，仅监听本机；公开站点账户体系另阶段实现。JSON API 返回 `{ok:true,...}`，失败 `{ok:false,error:"可读原因"}`，冲突用409、无效输入400、缺资源404。客户/会话使用字符串 ID，文章沿用 ZIP 整数 ID，工作版本为整数 ID。`app/` 的原始 Store 仍持有 ZIP 生成参考记录。前端只调用工作台接口修改工作版本，避免绕过锁直接改原生成记录。

稿件导出和任务 ZIP 归档的 GET、HEAD 请求只返回文件。通过本机入口打开的工作台可调用 `POST /api/workbench/downloads/settings` 或 `/api/workbench/downloads/pick` 设置本机目录，并向同一导出或归档地址 POST 空对象保存成品。服务只对通过本机请求检查的页面提供目录设置。局域网网关不转发本机下载请求头，局域网入口始终使用浏览器下载。

异步模型操作返回 `{operation_id}`，查询返回 `{operation:{id,kind,status,result,error,...}}`。status为running/done/error/stopped/interrupted；访谈通过操作SSE接收增量，其余操作仅进行中有界刷新，结束即停止。批量写作仍可消费原生 `GET /api/jobs/{job_id}/stream`，next/chunk/status/end事件保持原形。

### 共用 API

| 方法与路径 | 请求 / 返回主体 |
|---|---|
| GET `/api/workbench/bootstrap` | clients, conversations, platforms, target_models, settings, provider_models |
| GET `/api/workbench/clients` | clients |
| POST `/api/workbench/clients` | `{name,profile}` → 新client；独立更新使用PUT `/clients/{id}` |
| GET `/api/workbench/clients/{id}/documents` | documents |
| POST `/api/workbench/clients/{id}/documents` | `{filename,kind,text}` → document |
| GET / POST `/api/workbench/clients/{id}/intakes` | 读取最近整理 / 按 `{document_ids,retry?}` 开始或复用整理 |
| GET `/api/workbench/clients/{id}/intakes/{intake_id}` | `{intake}` |
| POST `/api/workbench/clients/{id}/intakes/{intake_id}/adopt` | 确认档案与编辑记录 → `{client,intake}`。字段与冲突处理见 [客户资料整理](feature-client-intake.md) |
| POST `/api/parse` | 沿用ZIP `{filename,content_b64}` → 原生解析结果；原支持格式继续原解析器，PDF单独接 |
| POST `/api/workbench/conversations` | `{client_id, document_ids?, creation_id?, mode?:'chat'\|'zip'}` → conversation，未传 mode 时默认 chat |
| PUT `/api/workbench/conversations/{id}/profile` | `{name,profile,save_as_default?:true}` → `{client,conversation}`；默认只更新本任务，显式save_as_default才同步客户；profile七字段齐全，清空传空字符串 |
| GET `/api/workbench/conversations/{id}` | conversation, articles, documents, job, operations |
| PUT `/api/workbench/conversations/{id}/task-state` | `{pinned:true\|false}` 或 `{archived:true\|false}` → `{task:{id,pinned_at,archived_at}}`。归档清除置顶，排队或执行中的任务返回 409。归档任务可按原 ID 查阅和恢复 |
| POST `/api/workbench/conversations/{id}/clone` | `{}` → 新conversation；同客户、复制当前可见brief和所选资料，原任务ID记parent_conversation_id，不复制稿件/历史对话/计划/完成状态 |
| DELETE `/api/workbench/conversations/{id}` | `{}` → deleted_id；仅逻辑删除，运行任务409，旧视频固定来源继续可读 |
| PUT `/api/workbench/conversations/{id}/draft` | `{options,document_ids?,mode?}`，保存两个入口的同一草稿，不调用模型 |
| POST `/api/workbench/conversations/{id}/chat` | `{text,document_ids,followup,options?}` → operation_id；结果understanding/questions/ready |
| POST `/api/workbench/conversations/{id}/start` | 采用当前草稿并可覆盖options → job_id, operation_id, planned, total |
| POST `/api/workbench/conversations/{id}/write-one` | `{options?}` → job_id, operation_id, planned=1, total；只执行现有配额中下一篇，完成后停止，不加配额 |
| POST `/api/workbench/conversations/{id}/stop` | 暂停后续写作，当前篇按ZIP原生流程收尾 |
| GET `/api/workbench/operations/{id}` | operation |
| GET `/api/workbench/operations/{id}/stream` | 仅interview；SSE `data: {operation}`，连接时返回当前快照，变化时推送，终态后关闭；空闲15秒发送心跳注释 |
| POST `/api/workbench/operations/{id}/stop` | 本地停止及收尾；不能假称云端已停止 |
| GET `/api/workbench/conversations/{id}/articles/{aid}/versions` | current_version, versions, review_records |
| PUT `/api/workbench/conversations/{id}/articles/{aid}` | `{expected_version,body_md?,title?,tags?,decl?}` → article；只改提供字段，tags/decl为字符串数组，清空传[]；不接受null，严格检查版本和锁 |
| DELETE `/api/workbench/conversations/{id}/articles/{aid}` | `{expected_version}` → deleted_id；批次须已收尾；逻辑删除后从列表/导出/已写计数移除，原配额空位可再写，历史版本和旧视频来源保留 |
| POST `…/articles/{aid}/regenerate` | `{expected_version,extra_note?}` → operation_id；原生按同平台/身份/形态/型号组/角度重新生成，接原生核查，成功后采用新版本，核查前新初稿也留版本 |
| POST `…/articles/{aid}/audit` | `{expected_version}` → operation_id；对当前采用正文运行一次原生核查，可按原规则修改正文，成功后采用可恢复的新版本 |
| POST `…/articles/{aid}/select-version` | `{expected_version,version_id}` → article；候选须与原稿匹配 |
| POST `…/articles/{aid}/style-review` | `{expected_version}` → operation_id；结果suggestions/observations/assessment/base_version |
| POST `…/articles/{aid}/style-rewrite` | `{expected_version,review_id,selected,mode:'full'|'standard'|'light',material?,conservative?:string[]}` → operation_id；结果candidate_version/changes/fact_check。conservative明确指定已选且需要素材的建议只做删减/收紧；其余需要素材的项仍校验material |
| POST `…/articles/{aid}/revise` | `{expected_version,instruction}` → operation_id；针对当前正文的修改候选，不能误用原ZIP整篇重写冒充局部修改 |
| GET `…/articles/{aid}/editorial?version_id=…` | 本版核查状态、问题原句、依据、修订记录和创作配置。历史版按其版本 ID 返回对应资料 |
| POST `…/articles/{aid}/repair-facts` | `{expected_version,selected:[问题编号]}` → operation_id。对可唯一定位的原句生成替换文本，保存候选并局部复核。沿用 `select-version` 明确采用 |
| PUT `…/articles/{aid}/review-record` | `{candidate_version,codex_review,user_review}`，分别保存真正的双方意见 |
| GET `…/articles/{aid}/compare?candidate_version=…` | base, candidate, diff, review, review_records；可支持fmt=json/md下载 |
| GET `/api/workbench/conversations/{id}/export?fmt=docx|md|json|txt&ids=…` | 导出当前明确采用版本。Markdown、TXT 可传 `scope=body` 下载与 Word 同源的正文。省略 `scope` 沿用各格式的原有内容，JSON 为任务资料 |
| GET `/api/workbench/conversations/{id}/archive` | 下载真实application/zip本地归档，运行中409；包含有效安排、解析文字、冻结输入、生成参考、全部工作版本/核查/差异/实际意见与当前四格式导出；不打包连接配置、私有目录或诊断日志，不外发 |
| GET `/api/workbench/zip-config` | ZIP有效平台、目标AI、偏好、风险、写作设置，完整展开配置使用 |
| POST `/api/workbench/settings` | 白名单保存model/temperature/max_tokens/title_prefix等，不暴露密钥 |
| POST `/api/models`、PUT/DELETE `/api/models/{id}` | 目标AI配置name/note/enabled；新增默认启用，删除同步清理原生prefs |
| POST `/api/platforms`、PUT/DELETE `/api/platforms/{id}` | name/formats/style/length_hint/structure_hint/audience/account_type/enabled；新增默认启用，删除同步清理prefs和该平台risks |
| POST `/api/risks`、PUT/DELETE `/api/risks/{id}` | item/platform_id/category/level/tip；platform_id=null为通用，level为高/中/低；适用平台可编辑 |
| POST `/api/prefs` | `{model_id,platform_id,level:'high'|'mid'|'low'}` → prefs，校验两端真实存在 |
| GET `/api/workbench/provider-models` | 明确查询WorkBuddy模型目录；默认选DS，不频繁重查 |
| GET `/api/workbench/video-context?client_id=…&article_id=…&version_id=…` | 只读客户/资料/指定采用稿，见下文；视频首版无需旧数据库兼容 |

配置写入沿用原Store字段、默认值与清理行为。所有写请求含application/json及JSON对象；DELETE传{}，稿件DELETE额外传expected_version。配置保存不调用模型；运行中使用冻结配置，已完成稿件不追溯改写。已选目标AI/平台删除、停用或任务覆盖形态从配置移除后，保存/开始旧草稿会明确报400，用户需更新可见选择。原生生成、稿件写入接口禁止外部绕过工作台锁与版本管理。

### options 与主要对象

```json
{
  "keywords":["西邦24"],
  "selections":[{"platform_id":4,"account_type":"personal","count":1}],
  "models":["豆包","DeepSeek"],
  "rivals":[],
  "aliases":[],
  "note":"本次明确要求",
  "length_hint":"正文600—800字",
  "format_overrides":{},
  "document_ids":[]
}
```

conversation.brief是八项客户字段和本次安排的唯一有效来源；空字符串保持为空。任务/profile默认只更新本任务，显式save_as_default:true时一次事务同步客户档案。客户管理用独立PUT /clients/{id}，不回写旧任务。批次提交后安排不可编辑，客户/方案/资料修改只影响后续新任务，现有批次按冻结快照执行。

`brief.note`是本任务当前有效说明，可在安排中查看；它不等于尚未发送的消息草稿。用户直接开始且存在未发送文字时，先经一次chat整理进入有效说明，再start；整理失败保留消息草稿，不启动生成。不在start时拼接历次用户原话。访谈在既有一次整理调用里编译当前完整说明：未撤回条件继续保留，明确替换或撤回的旧条件从note移除；历史messages保留作对话记录。助手understanding/questions不进入ZIP。完整选项、访谈和分步入口共用这个字段。新任务优先沿用客户方案，无方案时selections=[]、models默认启用目标AI全选；目标AI不是写作模型。确认后的aliases原样进入brief和原生分组/待写队列，不另做关键词匹配规则。

访谈的 `understanding` 是直接回应用户的自然回复，先回应最新消息，必要时直接提出问题；选项由界面单独显示。一次模型调用同时产出回复和完整安排。后台从真实供应商片段中只投影顶层回复字符串，进行中的 `operation.result` 为 `{understanding,reply_complete,partial:true}`，最多4000字符。`reply_complete` 只表示回复字符串已闭合，完整结构和安排仍需校验；结构化选项不随片段应用。校验通过且未停止后，才保存完整助手消息与有效安排，消息含 `operation_id` 供界面保持同一节点。

停止、无效输出或中断保留输入、部分回复和原有效安排；部分回复显示未完成状态，不作为已完成助手消息写入历史。停止与最终提交受同一锁保护，提交后到达的停止不把成功改成失败。SSE断线立即关闭自动重连，前端只查询一次状态；已完成则读取结果，否则保留内容并等待用户选择恢复后台状态或停止。显式恢复重新订阅当前操作，包含重启恢复的终态，不重发chat请求。切换任务关闭本地订阅，迟到事件不改变新任务。

document返回 `id,client_id,filename,kind,text,digest`。conversation至少有 `id,client_id,title,plan_id,messages,brief,document_ids,job_id,status`。article至少有ZIP原字段和 `current_version,version_label,origin,review,locked`。version有 `id,article_id,parent_id,origin,label,article,review,created_at`。

`length_hint` 为可选本次篇幅说明。依次采用本次非空 `length_hint`、本次 `note` 中的显式字数、客户常用方案中的字数偏好、平台匹配形态的默认篇幅。每种实际平台、身份、形态的目标保存为 `{hint,source,metric}`，`source` 为 `request|customer_preference|platform_default`，`metric` 为 `nonWhitespace`。本版详情按所查看的版本正文实测，计入小标题及列表文字，略过文章标题、标签、声明和常见 Markdown 标记。明确给出范围或上、下限时显示是否落在目标内。生成和原生核查调用次数沿用原流程。客户常用方案可在 `note` 写“正文通常 600—800 字”。

首次写作识别本次明确字数范围或目标后，将摘要、各节字数和段落数量保存到实际 `style` 变体的 `budget`。各节按主题问题分工。首次核查对照业务条件和表述力度，问题摘录必须出现在原稿。若摘录对不上，或正文变化缺少核查问题作为依据，保留初稿并在编辑记录标记为 `unverified`。

普通任务 `/start`、`/write-one` 和批量任务将 `creation_context` 随现有生成快照保存。结构为 `{schema_version,client,documents,request,style,source_article,editorial,digest}`，其中 `client` 含 id/name/profile，`documents` 含本次选定 ID、修订、文本哈希、文件名和正文，`request` 含本次主题/关键词、要求、选择和形态覆盖。`style.variants` 以 `platform_id:account_type:fmt` 索引适用规则、认可表达、版本、文件哈希和有效篇幅。同一风格配置中按形态定义的规则覆盖通用字段。文章变体保存 `retrieval_preference`，取已选目标在当前平台的最高档，未配置的格子或未选择目标时按中档。高档优先按问题组织小节并独立呈现事实，中档突出结论和条件，低档沿用平台写法。原生审核、候选及采用流程保持各自状态。已提交的既有批次继续使用提交时的快照。

客户确认整理结果后，新任务沿用正式客户档案。本次所选资料的 ID、修订和正文哈希与某次整理采用的整个资料集合一致时，快照的 `editorial` 保存最近一次匹配的 `intake_id`、`adoption_id`、概览、关键词、重要说法和冲突。引用和核对状态供编辑和下游来源回看，首次正文请求仍使用正式任务档案、本次要求及选定原文。

视频上下文沿用 `GET /api/workbench/video-context`。无文章时可选 `conversation_id` 读取同客户任务，或用逗号分隔的 `document_ids` 明确选择资料；默认返回客户当前就绪资料，`source_article` 为 null。有文章时 `article_id/version_id` 必须成对，使用指定版冻结资料与配置，拒绝同时覆盖资料；`source_article` 含固定 `article_id,version_id,title,body_md`，`request` 增加实际平台、身份、形态与篇幅，`style.applied` 指向实际风格。兼容字段 `article` 保留可选 ZIP 溯源证据；处理过程与核查问题归 `editorial`，正文取指定版 `source_article.body_md`。历史未记录的风格显式标记 `historical_style_unrecorded`。未带 `client_id` 返回客户列表；归属错误404，未采用候选409，逻辑删除记录仍可读曾采用的固定来源。

## 视频接入边界

主工作台的“制作视频”使用当前采用的文章版本，进入 `/video/narrated/` 并携带客户、文章和版本 ID。“用本次资料制作视频”会先保存任务资料选择，再携带客户与任务 ID 进入同一页面。原全文视频工作区仍在 `/video/`。短视频接口和来源约定见 [页面式短视频](feature-narrated-video.md)。

混合批次复用 `/api/workbench/batches` 的现有队列。预检和提交的客户项可带 `videos:[{topic,source,article_index?,narration?}]`，`source` 为 `documents` 或 `article`，全批最多三条。文章序号从 1 开始，指该客户本批实际输出的顺序。配音默认开启。仅做资料视频可传 `options.selections:[]`，直接选资料，无需文章平台。预检返回 `total`、`video_total` 和各客户项的 `videos`。批次读取仍用 `total/completed`、`planned/completed` 计文章，另有 `video_total/video_completed` 及各项 `videos[]`。

视频条目包括 `id,topic,source,narration,status,stage,error` 及适用的 `article_index,article_id,version_id,production_id,render_id,preview_url`。阶段为 `waiting_article/script/render/done`。文章来源使用本批输出的首次采用版，资料来源读取批次提交快照。仅依赖文章的条目会等待对应文章，资料直出不因文章失败而取消。

`POST /api/workbench/batches/{bid}/videos/{vid}/retry` 接受 `{acknowledge_uncertain?:true}` 并返回 `{batch}`。归属错误 404，正在执行、已经完成、依赖未齐或中断尚未确认时返回 409。已完成条目不重跑。主站把阶段、尝试号、请求标识和操作 ID 保存到 SQLite。未收到提交响应时使用原键找回，收到操作 ID 后使用 `GET /operations/{id}?wait=1` 等待。视频服务明确结束且失败后，重试才更换对应阶段的尝试号。脚本完成后重试成片使用原制作和第 1 版。批次暂停保留已提交的子服务操作，继续时核对原结果。

`GET /api/workbench/batches/{bid}/video-download` 下载已完成视频的 ZIP，按作品分目录放 `video.mp4`、`captions.srt`、`cover.png`。无成片、作品归属不符或资产缺失时返回错误。临时 ZIP 组装完整后再发送，媒体只通过本次工作台托管的子服务读取。

默认main.py及两个启动bat自动拉起一个只监听本机的视频子服务，无需手填端口或单独启动。内部仍运行 `node video/server.cjs --port 0 --workspace-base <主服务URL> --data-dir <主数据目录/video>`，stdout只输出一条JSON就绪记录 `{type:'ready',port,pid}`，其他日志走stderr。主服务通过同源 `/api/video/*` 及 `/video/*` 原路径转发；/video重定向/video/。未就绪返回503，主服务启动期失败则整体退出，不自动重启或重试。

主服务保留原Host/Origin/Sec-Fetch-Site、内容类型、Range和下载头；上传与响应分块搬运，不把视频媒体放进12MiB普通JSON入口。传输体上限64MiB，视频服务仍执行自己的文件类型/32MiB上限；请求须给Content-Length，不接受Transfer-Encoding。支持GET/HEAD/Range206/416与Content-Disposition。错误状态保持子服务实际返回，不由代理猜测业务结果。

GET `/api/workbench/runtime` → `{main:{pid,port},video:{status,pid,port,start_count,error,owned_pids}}`。POST `/api/workbench/video-service/restart` `{}`只明确重启本次拥有的子服务；POST `/api/workbench/shutdown` `{}`关闭本工作台及其子服务。Windows用专属Job Object清理本次进程树，正常退出与父进程异常退出均不扫描/终止其他工作台。日志位于主数据目录/logs/video.stdout.log、video.stderr.log、video-lifecycle.jsonl。旧--video-base已拒绝，避免连接到不归本次服务拥有的进程。

视频模块自己持有视频任务、媒体与不可变版本；文章来源记录具体version_id，后续改文案不悄悄替换已提交的视频任务。具体桥接调整如有必要，在阶段回调中集中提出。

## core-001 接口细化

- 页面路径为 `/`、`/workbench`、`/workbench/zip`；草稿 `mode` 使用 `chat` 或 `zip`。两个路径由同一服务提供，保存模式不调用模型。
- `draft` 可附加布尔 `followup`。conversation额外返回 `mode,followup,needs_confirmation,draft_revision`；`brief`为当前草稿选项。修改在途生成要求会设置 `needs_confirmation=true` 并暂停后续；当前篇结束后，用户确认调用 `/start` 才续写。只切换模式不暂停。
- `/start` 校验关键词、可用平台及篇数，不额外强制填写note或具体企业事实。仅当前有效note进入ZIP；助手的understanding/questions和历史已撤回原话不追加到写作提示。
- bootstrap 与 zip-config 均含 `target_models`，同时保留原生 `models` 别名。bootstrap 返回本机 API 识别状态 `local_api_sources`。`settings.transport` 记录 `workbuddy`、`deepseek`、`dashscope` 或 `compatible`，历史快照缺字段时按 WorkBuddy 运行。`provider-models` 仍返回 WorkBuddy 目录，启动 WorkBuddy 模型操作时按精确 ID 校验并缓存。直连接口在实际写作请求时校验模型。打开设置或保存配置时只读取本机状态。
- style-review结果含 `recommended`（第1、2档ID）、`default_mode:'full'`、`observations_default_selected:false`。suggestions ID为字符串，观察项以O开头。审阅主体标记实际使用的模型来源，Codex评语初始为空；review-record只保存实际提交的双方文字，不生成“Codex已审阅”结论。
- 需求整理的普通写作指令（含首条和重复发送）必须返回完整 `options.note`，输出示例与此约定一致；与当前条件接近不等于用户选择了上一轮选项。漏回时保留原话和现有有效说明，明确提示模型输出缺项，不使用理解摘要替代，也不自动重试。
- style-rewrite先保存候选，再尝试一次只读事实复核；复核失败时候选保留，fact_check为 `unverified`，不影响ZIP成稿的查看、编辑和导出。compare的json/md包含基稿、候选、差异、修改清单、复核和双方评语。
- 视频可请求当前采用版本，或明确指定一个曾采用过的版本；未采用候选返回409、跨客户/跨稿件版本返回404。之后切换文章版本仍可读取已固定的视频来源版本。
- 主服务托管视频子服务，原路径转发/api/video/*、/video/*。前端不得通过原生plans/articles/materials写接口绕过工作版本；这些写接口返回403。
- data目录位于静态资源外；默认 `data/workbench/workbench.db` 为新库，仅初始化ZIP平台/目标AI/风险/偏好种子和默认写作模型。连接配置只由Node进程读取，HTTP设置只接受白名单字段。

## core-002 真实接通观察与联调差异

- 已按隔离合成夹具完成真实WorkBuddy的8次内容调用、1次目录查询，精确模型ID为deepseek-v4.1-flash。7次原始返回为严格JSON对象，去味审阅1次带Markdown JSON围栏；仍走原ZIP的parse_json解析成功，没有丢弃force_json、二次重试或改模型。供应方并未保证本次所有原始文本严格服从json_object格式。
- **当前operation.kind实际值**：POST chat → `interview`；style-review → `style_review`；style-rewrite → `style_rewrite`；revise → `revision`；start → `writing`。GET operation与conversation.operations都沿用这些值，尚未映射为前端假设的chat/style-review/style-rewrite/revise。前端接真服务时须明确对齐这一处；本阶段没有改web或悄悄改变既有后台值。
- style-review结果中没有额外review_id时，使用该审阅operation.id作为style-rewrite的review_id。format_overrides仍是以字符串platform_id为key的数组，值须为对应平台配置的形态子集；zip-config仍返回prefs/risks。
- 功能接通不代表内容普遍质量通过。两篇原生稿、去味候选、事实复核和实际Codex意见见output/geo-merge-20261104/core/live；用户保持未审。候选和人工边界检查版留档，已恢复原ZIP成稿为默认采用。

## 原生显式操作与版本边界

regenerate/audit、逻辑删除与历史复用要求本任务所有模型操作和批次已收尾，冲突409。它们与人工保存、候选采用共用文章锁和expected_version比较更新。重写实际调用原generator.run_regenerate，再调用一次原audit_article；再核一次只调用原audit_article。核查修改仍按原ZIP的比例门限决定应用，不增加去味或裁判循环。开始前冻结当前可见安排、资料和配置，保持该篇原平台/身份/形态/关键词组/角度。

成功时在一次事务里保存可恢复工作版本、来源证据、采用记录和显式原生参考更新。重写初稿origin=zip_regenerate_draft（核查前未自动采用），重写核查后origin=zip_regenerate，再核查origin=zip_audit；异步kind为zip_regenerate/zip_audit，result含article_id/base_version/adopted_version/audit，重写额外含draft_version。旧版本和旧来源不改。失败或不完整结束不提交新采用稿，保留旧参考和旧版本；同一操作一旦发生传输失败，禁止原生后备循环再次外发。人工及style/revision候选继续独立于生成参考，人工保存任一正文/标题/标签/声明变更均清除继承核查和评分。

本地归档是当前任务的内容 ZIP 下载，客户端可保存到选定目录。工作台设置只接受模型来源、模型 ID 和写作参数，连接地址和凭据由服务端从本机配置读取。

## 审阅交互与素材处理增量

观察项O编号默认不选，用户可明确勾选，与正式建议共同传selected。requires_material=true的选中项必须有补充素材，或由用户逐项明确选择conservative删减/收紧；不能静默绕过、自动补经历或丢弃已选项。保守处理会替换执行方案并记录metadata.conservative，原审阅保持原样。审阅和候选请求使用基稿版本冻结的资料，候选仍默认不采用，随后仅一次只读复核。素材缺失400是提交前校验，页面就地提示编号，不作为后台故障显示恢复按钮。

审阅面板左边缘可调整宽度；操作状态刷新不重建正在阅读的面板，不丢勾选、滚动位置或素材。文章修改指令栏位于正文工作区底部的固定区域，全文留出空间，不覆盖末段。


### 访谈确认与校验错误（2026-11-05）

用户原样选择上一条助手给出的选项、当前有效note非空且无需修改时，允许模型返回 options={}、questions=[]、ready=true，完整保留当前brief。新增、替换或撤回要求仍须返回完整note；不能用understanding代替，也不重新从客户方案补回旧条件。后台Problem校验错误在result.error_status保留HTTP语义；需求校验失败由前端原位显示并保留消息，不作为连接故障、不自动重发模型。
