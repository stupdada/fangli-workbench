# 方立整合接口与产品约定

本文件记录用户已确认的实现边界及执行线程共用接口。当前交付为本机可用网站，不含公网注册、多租户部署、自动发布或公开网效果检测。

2026-11-04 客户长期资产与批量生成增量见 [客户与批次合同](customer-batch-contract.md)。该合同优先描述独立客户更新、原件持有/哈希去重/不可变资料修订、客户常用方案及不限日期的多批队列。任务档案默认仅本次，save_as_default:true才同步客户；新任务可沿用客户方案。以下原 ZIP 底座与版本保护继续适用。

## 产品行为

- 原始 ZIP 为首次文章生成的底座，`app/` 文件保持字节一致。工作台外层明确补齐冻结客户档案到原生核查依据，跨任务历史标题/FAQ与选题轮换作为生成参考；检查层修正平台信息小节名称，撤去统一500字门槛，并准确命名长度/预置风险词检查。正文生成、关键词分组、资料相关性截取和导出仍使用原生路径，不使用试做副本的混合生成器。历史保真证据只覆盖当时输入，新增参考和核查依据由本轮 focused 测试覆盖。
- 业务模型为 WorkBuddy，默认 `deepseek-v4.1-flash`，运行时核对可用性，不静默切换。连接设置不得出现在静态资源或错误详情中。
- 两种可切换创作方式：对话创作与 ZIP 分步创作。共享同一任务、参数、客户资料、稿件、版本和运行状态。切换先保存草稿，不新建任务、不发模型请求、不清空选择。
- 对话创作以单一消息输入框与消息流为主；消息草稿独立于当前有效options.note。客户、资料数量和发布安排只显示摘要，关键词与有效说明按需打开。分步1负责资料/关键词/本次要求，分步2集中维护平台/身份/形态/篇数。全局模型、平台规则、风险与实验配置进入居中设置弹窗；客户永久信息仍在客户页管理。
- 平台保留 ZIP 全部已启用平台，官方号与个人号分别计数。新任务带出客户常用方案，无方案时平台空选；选择平台可默认一篇。发布形态来自平台formats配置。短视频文案不等于视频合成。
- 对话可连续追问，不设固定轮数；每问简短、给建议，已知不重问，可手动关闭或直接开始。关掉后使用可见默认配置；只拦无法执行的关键缺项，业务事实不靠默认值补造。
- 批量生成仅锁当前正在处理的稿件；已完成稿可编辑。编辑产生工作版本，ZIP 后续读取冻结的生成参考，不受人工修改影响。后端也要拒绝处理中稿件的修改/版本切换/重复处理。
- 生成途中出现新的生成要求，暂停后续任务，保留已有结果；用户确认新安排后继续。不确定的超时/断线停止后续，由用户明确重试，不重复可能已执行的调用。
- 原始 ZIP 的原生事实核查行为保留，初稿与核查后稿留档；人工修改新版本不继承旧核查结论，不强制自动重核或阻止保存导出。
- 生成后手动去 AI 味：通读审阅、建议选择、允许全文重组。生成候选稿后自动做一次只读事实复核，报告问题但不自动改稿，不反复润色。默认查看/导出仍是 ZIP 成稿，明确采用候选后才切换。保留前后全文、差异、核查、Codex审阅及用户意见；不得伪造“Codex已审阅”。
- 风格库作为软件配置保留，旧客户/旧稿件数据不迁移。首次 ZIP 生成不叠加“我做的”风格、篇幅、样稿或审核策略。生成后审阅可用风格库中适用的信号和认可表达；与 de-ai-taste 重复的规则只维护一份，不重复审核。平台结构/篇幅规则先作参考。
- 视频独立创建，文章提供手动“制作视频”入口，绑定当前采用的稿件版本；不在每篇文章后自动生成视频稿。首版视频不加去味。使用最新无声视频模块的成熟分屏/素材/合成/停止重试能力，旧配音包不混入。视频文字流程需相同资料、选题和模型比较 ZIP 与当前视频流程后择一，不预设当前视频文案已验证。
- 用户允许概括性、一般性乃至信息较泛的表达；不得因为缺少某个非核心细节，把整篇写成核验说明、免责声明或防御性清单。可写有依据的介绍及不冒充商家承诺的普通建议。缺项、未验证和取材过程放编辑侧；不得编造具体数值、经历、地址、资质或服务承诺。该原则尤其用于需求访谈、后置编辑和视频文案，不能借此静默改写 ZIP 首次生成规则。

## 接口通则

主服务同源，仅监听本机；公开站点账户体系另阶段实现。JSON API 返回 `{ok:true,...}`，失败 `{ok:false,error:"可读原因"}`，冲突用409、无效输入400、缺资源404。客户/会话使用字符串 ID，文章沿用 ZIP 整数 ID，工作版本为整数 ID。`app/` 的原始 Store 仍持有 ZIP 生成参考记录。前端只调用工作台接口修改工作版本，避免绕过锁直接改原生成记录。

异步模型操作返回 `{operation_id}`，查询返回 `{operation:{id,kind,status,result,error,...}}`。status为running/done/error/stopped/interrupted；仅进行中有界刷新，结束即停止。批量写作仍可消费原生 `GET /api/jobs/{job_id}/stream`，next/chunk/status/end事件保持原形。

### 共用 API

| 方法与路径 | 请求 / 返回主体 |
|---|---|
| GET `/api/workbench/bootstrap` | clients, conversations, platforms, target_models, settings, provider_models |
| GET `/api/workbench/clients` | clients |
| POST `/api/workbench/clients` | `{name,profile}` → 新client；独立更新使用PUT `/clients/{id}` |
| GET `/api/workbench/clients/{id}/documents` | documents |
| POST `/api/workbench/clients/{id}/documents` | `{filename,kind,text}` → document |
| POST `/api/parse` | 沿用ZIP `{filename,content_b64}` → 原生解析结果；原支持格式继续原解析器，PDF单独接 |
| POST `/api/workbench/conversations` | `{client_id}` → conversation |
| PUT `/api/workbench/conversations/{id}/profile` | `{name,profile,save_as_default?:true}` → `{client,conversation}`；默认只更新本任务，显式save_as_default才同步客户；profile七字段齐全，清空传空字符串 |
| GET `/api/workbench/conversations/{id}` | conversation, articles, documents, job, operations |
| POST `/api/workbench/conversations/{id}/clone` | `{}` → 新conversation；同客户、复制当前可见brief和所选资料，原任务ID记parent_conversation_id，不复制稿件/历史对话/计划/完成状态 |
| DELETE `/api/workbench/conversations/{id}` | `{}` → deleted_id；仅逻辑删除，运行任务409，旧视频固定来源继续可读 |
| PUT `/api/workbench/conversations/{id}/draft` | `{options,document_ids?,mode?}`，保存两个入口的同一草稿，不调用模型 |
| POST `/api/workbench/conversations/{id}/chat` | `{text,document_ids,followup,options?}` → operation_id；结果understanding/questions/ready |
| POST `/api/workbench/conversations/{id}/start` | 采用当前草稿并可覆盖options → job_id, operation_id, planned, total |
| POST `/api/workbench/conversations/{id}/write-one` | `{options?}` → job_id, operation_id, planned=1, total；只执行现有配额中下一篇，完成后停止，不加配额 |
| POST `/api/workbench/conversations/{id}/stop` | 暂停后续写作，当前篇按ZIP原生流程收尾 |
| GET `/api/workbench/operations/{id}` | operation |
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
| PUT `…/articles/{aid}/review-record` | `{candidate_version,codex_review,user_review}`，分别保存真正的双方意见 |
| GET `…/articles/{aid}/compare?candidate_version=…` | base, candidate, diff, review, review_records；可支持fmt=json/md下载 |
| GET `/api/workbench/conversations/{id}/export?fmt=docx|md|json|txt&ids=…` | 导出当前明确采用版本；ZIP原生正文与导出渲染规则保留 |
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
  "format_overrides":{},
  "document_ids":[]
}
```

conversation.brief是八项客户字段和本次安排的唯一有效来源；空字符串保持为空。任务/profile默认只更新本任务，显式save_as_default:true时一次事务同步客户档案。客户管理用独立PUT /clients/{id}，不回写旧任务。批次提交后安排不可编辑，客户/方案/资料修改只影响后续新任务，现有批次按冻结快照执行。

`brief.note`是本任务当前有效说明，可在安排中查看；它不等于尚未发送的消息草稿。用户直接开始且存在未发送文字时，先经一次chat整理进入有效说明，再start；整理失败保留消息草稿，不启动生成。不在start时拼接历次用户原话。访谈在既有一次整理调用里编译当前完整说明：未撤回条件继续保留，明确替换或撤回的旧条件从note移除；历史messages保留作对话记录。助手understanding/questions不进入ZIP。完整选项、访谈和分步入口共用这个字段。新任务优先沿用客户方案，无方案时selections=[]、models默认启用目标AI全选；目标AI不是写作模型。确认后的aliases原样进入brief和原生分组/待写队列，不另做关键词匹配规则。

document返回 `id,client_id,filename,kind,text,digest`。conversation至少有 `id,client_id,title,plan_id,messages,brief,document_ids,job_id,status`。article至少有ZIP原字段和 `current_version,version_label,origin,review,locked`。version有 `id,article_id,parent_id,origin,label,article,review,created_at`。

视频上下文返回：`{client:{id,name,profile},documents:[{id,filename,kind,text,digest}],article?:{article_id,version_id,title,body_md,platform_name,account_type,zip_data?,raw_generation?,raw_audit?,native_audit?,body_original?}}`。article_id/version_id必须成对，缺一400。body_md/title永远取指定版本；其余字段为按版本固定的可选原ZIP来源证据，仅供编辑侧追溯，不能用zip_data覆盖指定正文。缺证据时不伪造补齐。未带client_id返回新工作台客户列表；归属错误404、未采用候选409；逻辑删除记录仍可读取曾采用的固定来源版本。

## 视频接入边界

默认main.py及两个启动bat自动拉起一个只监听本机的视频子服务，无需手填端口或单独启动。内部仍运行 `node video/server.cjs --port 0 --workspace-base <主服务URL> --data-dir <主数据目录/video>`，stdout只输出一条JSON就绪记录 `{type:'ready',port,pid}`，其他日志走stderr。主服务通过同源 `/api/video/*` 及 `/video/*` 原路径转发；/video重定向/video/。未就绪返回503，主服务启动期失败则整体退出，不自动重启或重试。

主服务保留原Host/Origin/Sec-Fetch-Site、内容类型、Range和下载头；上传与响应分块搬运，不把视频媒体放进12MiB普通JSON入口。传输体上限64MiB，视频服务仍执行自己的文件类型/32MiB上限；请求须给Content-Length，不接受Transfer-Encoding。支持GET/HEAD/Range206/416与Content-Disposition。错误状态保持子服务实际返回，不由代理猜测业务结果。

GET `/api/workbench/runtime` → `{main:{pid,port},video:{status,pid,port,start_count,error,owned_pids}}`。POST `/api/workbench/video-service/restart` `{}`只明确重启本次拥有的子服务；POST `/api/workbench/shutdown` `{}`关闭本工作台及其子服务。Windows用专属Job Object清理本次进程树，正常退出与父进程异常退出均不扫描/终止其他工作台。日志位于主数据目录/logs/video.stdout.log、video.stderr.log、video-lifecycle.jsonl。旧--video-base已拒绝，避免连接到不归本次服务拥有的进程。

视频模块自己持有视频任务、媒体与不可变版本；文章来源记录具体version_id，后续改文案不悄悄替换已提交的视频任务。具体桥接调整如有必要，在阶段回调中集中提出。

## core-001 接口细化

- 页面路径为 `/`、`/workbench`、`/workbench/zip`；草稿 `mode` 使用 `chat` 或 `zip`。两个路径由同一服务提供，保存模式不调用模型。
- `draft` 可附加布尔 `followup`。conversation额外返回 `mode,followup,needs_confirmation,draft_revision`；`brief`为当前草稿选项。修改在途生成要求会设置 `needs_confirmation=true` 并暂停后续；当前篇结束后，用户确认调用 `/start` 才续写。只切换模式不暂停。
- `/start` 校验关键词、可用平台及篇数，不额外强制填写note或具体企业事实。仅当前有效note进入ZIP；助手的understanding/questions和历史已撤回原话不追加到写作提示。
- bootstrap与zip-config均含 `target_models`，同时保留原生 `models`别名；provider-models返回 `provider_models`。bootstrap不查询外部目录；首次明确开始/模型操作按精确ID校验并缓存，显式打开目录可刷新。不自动换模型或重复不确定调用。
- style-review结果含 `recommended`（第1、2档ID）、`default_mode:'full'`、`observations_default_selected:false`。suggestions ID为字符串，观察项以O开头。审阅主体标记为WorkBuddy模型，Codex评语初始为空；review-record只保存实际提交的双方文字，不生成“Codex已审阅”结论。
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

本地归档是当前任务的内容ZIP下载，客户端可保存到选定目录；无远程upload动作或upload_url/token设置。旧网页API base/key/直连测试由本机WorkBuddy配置与精确模型目录校验替代。以上是明确产品合同变化，不能用旧接口旁路恢复凭据或外发。

## 审阅交互与素材处理增量

观察项O编号默认不选，用户可明确勾选，与正式建议共同传selected。requires_material=true的选中项必须有补充素材，或由用户逐项明确选择conservative删减/收紧；不能静默绕过、自动补经历或丢弃已选项。保守处理会替换执行方案并记录metadata.conservative，原审阅保持原样。审阅和候选请求使用基稿版本冻结的资料，候选仍默认不采用，随后仅一次只读复核。素材缺失400是提交前校验，页面就地提示编号，不作为后台故障显示恢复按钮。

审阅面板左边缘可调整宽度；操作状态刷新不重建正在阅读的面板，不丢勾选、滚动位置或素材。文章修改指令栏位于正文工作区底部的固定区域，全文留出空间，不覆盖末段。


### 访谈确认与校验错误（2026-11-05）

用户原样选择上一条助手给出的选项、当前有效note非空且无需修改时，允许模型返回 options={}、questions=[]、ready=true，完整保留当前brief。新增、替换或撤回要求仍须返回完整note；不能用understanding代替，也不重新从客户方案补回旧条件。后台Problem校验错误在result.error_status保留HTTP语义；需求校验失败由前端原位显示并保留消息，不作为连接故障、不自动重发模型。
