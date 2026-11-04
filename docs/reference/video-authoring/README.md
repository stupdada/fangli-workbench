# 视频文案创作模块 2.0.0

本模块为新工作台 `/video/` 的“写视频文案”动作准备，提供店铺介绍、宣传种草、关联品牌的科普、图片展示四种创作方向。每篇执行一次写作和一次编辑；适合的初稿允许原文保留。它接收当前客户上下文和单次模型调用函数，生成完整正文后交给现有分屏器。当前交付是隔离模块，尚未接入生产入口。2026年11月4日真实八稿已完成：7条合同通过，1条超长拒绝；表达与事实范围的执行者评阅另列，不能把合同通过当成内容通过。

## 导入与接线

Node 18+，CommonJS，使用 Node 内置模块，无新增 npm 依赖。生产 owner 将本目录模块及 `examples.json` 整体导入自己的服务。入口仅需 `content-creator.cjs`；使用现有 WorkBuddy 流 SDK 时可选 `workbuddy-adapter.cjs`。文件存档示例为 `file-archive.cjs`，也可注入现有数据库存档。

```js
const { createAuthor } = require('./style-v2/content-creator.cjs');
const { createWorkBuddyCallModel } = require('./style-v2/workbuddy-adapter.cjs');

const author = createAuthor({
  callModel: createWorkBuddyCallModel({ cloud, modelCall: existingModelCall, releaseStreams }),
  persist: async record => saveVideoCreativeAudit(record)
});
const record = await author.generate(brief, { signal });
// 只有completed且final存在才有可采用的最终稿；采用仍由用户明确触发。
if (record.status === 'completed') showEditableBody(record.final, record.editorial);
else showCreativeFailure(record.status, record.error, record.id);
```

接入方只读 `/api/workbench/video-context?client_id=…`，使用其 `{client,documents}` 构造下述 brief。`client.profile.company/brand/products` 分别映射，未确认的公司或品牌传 `null`；不能将客户显示名自动当成公司、品牌和商品。`facts` 由接入方从当前资料中明确选定；完整保留当前主题有关的真实介绍信息，不按文件名只抽店名。问句文件中的选题进入 `questionTopics`，不会自动转为确认事实。画面来自用户选定图片，另传 `visualBrief` 及 visual 来源。

本模块不查任何旧库，不加载鉴权文件，不请求模型目录，也不调用文章写作入口。生产 owner 负责本机桥接、SDK 鉴权与精确模型可用性缓存、请求ID幂等、按当前客户校验资料权限、异步操作与重启后的 interrupted 状态；将单个 `author` 复用于同一运行服务可阻止该实例并发。跨进程锁由生产 owner 持有。资料正文不能自行携带指令成为程序规则。

生产新增的加载点是视频创作动作及其上下文适配、审计持久化；采用稿全文导入和手填继续使用各自入口。ZIP 首次文章生成接口无需加载此模块。

## 输入合同

完整机器合同为 `contract.schema.json`；实际八任务示例集中在 `acceptance-inputs.json`，其中 `inputs[].input` 可直接传 `generate`。

| 字段 | 含义 |
|---|---|
| `requestId` / `direction` / `topic` / `domain` | 独立请求ID、四方向之一、具体选题、场景标识；宠物表达样例仅用于 `pet_store` |
| `client:{id,name}` | 当前客户归属 |
| `company` / `brand` / `products` | 独立身份对象 `{id,name,aliases?}`；前两项可为 null，商品为数组 |
| `publisherIdentity` | `kind:brand_official/company_official/third_party`、`displayName`；官方需 `speakingAs:{type,id}` 绑定身份，第三方传 null |
| `facts` | `{id,status:'confirmed',subject:{type,id?},statement,evidence:[{sourceId,quote}]}`；主体 type 为 company/brand/product/general/visual |
| `sourceRefs` | `{id,kind,title,evidenceText,clientId?,digest?,url?}`；客户来源须有当前 clientId，公共一般知识可无 clientId；引文必须真实包含于 evidenceText |
| `questionTopics` | `{text,sourceIds}` 数组，只作选题 |
| `visualBrief` | `{description,visibleDetails,sourceIds}`；图片展示必须有 visual 来源，其他方向无画面时传空字符串及空数组 |
| `target` | 本次 `minCharacters/maxCharacters`；本批150—250，产品可按调用指定其他长度 |

运行时会汇总输入问题，检查来源归属、引文及主体，清理未识别字段后再调用模型。`sourceRefs.evidenceText` 用于引用校验和审计，不整篇灌入提示词；模型收到所有已选择的 `facts` 及其证据引文、来源元数据、选题和画面。资料全文不会因缺一项介绍信息而丢弃已有确认事实。总证据上限8万字。

正文按去除全部空白后的 Unicode 码点计数，包含标点，标题另计。模型不负责分屏，也不按22字强迫断句；下游使用完整 `final.body` 做真实字体分页、时长及字幕覆盖检查。

## 输出、调用和失败

`callModel(request,{signal})` 必须执行恰好一个请求，不自行修复、重试或换模型：

```js
// request = {model:'deepseek-v4.1-flash', messages, phase:'write'|'edit',
//            requestId, ordinal:1|2}
return { model:'deepseek-v4.1-flash', text: rawResponse, finishReason:'stop', usage };
```

抛错时可携带 `responseText` 和 `usage` 保留已收到内容；提供方错误详情不进入记录或页面。`persist(record)` 必须在 paid call 前成功，后续保存整个不可人工改写的审计快照。存档异常向调用方抛出，不能继续触发下一个模型请求。存档包含 `input/inputDigest`、提示词及样例版本和摘要、每次 `messages/raw/usage/finishReason/elapsedMs`、初稿、编辑稿、编辑决策、最终稿、问题及状态。

| 输出 | 含义 |
|---|---|
| `status` | running / completed / invalid / failed / stopped |
| `draft` / `edited` | 各阶段原始字符串、JSON解析结果、结构错误、执行目标和引用检查 |
| `final` | 仅在最终结构、字数、引用完整性、保留标签一致性检查通过时存在；其他状态为 null |
| `editorial` | 资料缺项、模型编辑侧问题与观察；质量判断署名为模型编辑，不等于独立验收 |
| `actualCallCount` / `calls` | 单次依赖调用数及原始记录，最多2；真实性由注入的真实传输承担，离线合成测试不能算真实调用 |

初稿 JSON 结构无效时直接返回 invalid，只调用1次。初稿字数或引用问题可交给唯一一次编辑；编辑后仍无效则 final 为 null。编辑失败也保留初稿，不静默回退或采用。中途 abort 或不确定传输错误停止；不发第三次格式修复、评分或润色。生产方不得自动重提可能已经调用的请求。

检查层次保持明确：JSON/字数/主体和来源ID/引文包含是可执行合同；具体事实是否被正确转述、是否漏报新的事实、品牌关系和表达质量仍需语义判断。`referenceIntegrity:passed` 只证明引用链存在；`factualEntailment:model_self_report_not_independently_verified` 明示未做独立事实核验。合法且有来源的地址可以写入，不使用地址关键词作永久禁项。

## 样例与八稿验收

`examples.json` 版本 `video-expression-2.0.0`：4条用户认可原例标记 `user_approved`，每类另1条作者参考标记 `assistant_authored`。每次仅传当前方向且场景匹配的两条样例，附表达取舍说明。通用行业不接收宠物 few-shot。样例中的店名、承诺或画面不能作事实；模型的 `claims.factIds` 只能指向本次 facts。消费者核对清单作为一小段用途明确的反例，正例和本次表达目标为主。

`acceptance-inputs.json` 冻结每类两个不同选题、身份、事实和 write prompt 摘要；店铺事实只确认店名，独有介绍不足作为编辑侧观察。两条科普分别使用 [ASPCA 梳毛说明](https://www.aspca.org/pet-care/cat-care/general-cat-care) 与 [Cats Protection 新猫空间说明](https://www.cats.org.uk/help-and-advice/getting-a-cat/preparing-for-a-cat)，只用于一般养猫知识，不能证明商家服务。画面仅沿用已确认截图裁切的猫/狗物种，不新增品种、性格或在售推断。

离线阶段真实请求均为0。排期正式解除后，本次真实运行发出16次内容请求、0次目录请求，复用整合core的精确模型目录；渲染请求仍为0。`acceptance-runner.cjs` 只有接入方在明确文本排期解除后传入 `realCallAuthorization:'text-slot-released'` 才允许运行；它仍需注入真实单次 `callModel`。逐条串行，最多16次内容调用，目录至多由接入方共享确认1次。首次创建 `run-manifest.json`，相同目录再次运行会拒绝；不补写失败条目。传输失败停止后续任务，明确收到但不符合合同的结果留档后可继续下一个独立选题。任一实际稿不得人工改字来过验收。

每条保留原始初稿、编辑JSON与 `edit` 记录、usage、耗时、是否满足目标及问题。`RUBRIC` 固定方向、表达、变化、品牌角色、事实范围、目标六项，原始runner的定性评价初始为 pending；实际执行者评阅存于独立 `assessment.json` 和 `executor-reviews.json`，不改原始模型审计。Markdown仅呈现模型正文，JSON为原始证据。

本次真实结果位于 `live-20261104/`，与 `test-output/` 合成响应分开：`八稿阅读.md` 为可直接阅读的全部模型编辑返回；`eight/records/` 保存16次原始响应及完整输入/提示词/usage；`verification.json` 记录请求对应与全文一致性；`assessment.json` 为逐篇六标准评阅。正文203、176、188、191、280、217、192、154字，6条kept、2条revised。梳毛稿280字被拒绝，且执行者发现其新增店内梳毛照料断言无依据；图片稿仍有视觉细节扩写、样例骨架复用和编辑过程解释进入正文。推荐优先读第3、2、6条以判断方向，不代表已采用或已选成片。本阶段未修改冻结模块/样例/输入，未追加补写调用。生产接入仍由唯一video owner完成。

稳定运行文件及SHA256见 `module-manifest.json`；最小导入为 `content-creator.cjs` 与 `examples.json`，SDK和存档适配可按需加入。真实执行脚本 `run-live.cjs` 仅用于此次授权验收，不是生产入口。

## 离线验证

```powershell
node --test .\content-creator.test.cjs
```

本次15项不同 focused 用例通过：首组13项覆盖四方向与样例作用域、身份/事实/选题/画面分离、真实介绍信息保留、来源边界、2调用封顶、原文保留、结构失败、引用失败、可变长度与合法地址、部分传输失败、并发/停止/存档边界、单次SDK适配、文件存档及八任务冻结/排期门禁；另2项定向覆盖中途停止保留返回内容、八任务串行上限和目录重跑拒绝。Unicode空白计数细化后只重跑其1项相关用例。日志分别为 `test-output.txt`、`runner-focused.txt`、`count-focused.txt`。合成测试记录位于 `test-output/`，明确不作真实模型结果。

只写本 `style-v2` 目录，未改旧业务文件或新工作台，未重启服务。旧视频渲染、停止、重试、Range 与文章整套测试不属于本模块验证范围。
