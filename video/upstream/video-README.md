# 图文视频后台

本模块把客户上传的图片或视频按顺序编排，叠加用户填写的短文字，生成竖版 MP4。默认720×1280、25fps；每段默认停留5秒。文字是画面展示内容，画面说明、附注和原稿分别保存，不拼接进展示文字。原稿来源可选，不依赖文案生成或审核，也不代表所填文字已通过事实核查。

## 启动与接入

需要 Node、Python 3.11+。实际渲染由同目录下的 `video-engine/node-adapter.cjs` 调用本机 FFmpeg。

```powershell
$env:PORT = '8043' # 使用空闲端口，不重启其他服务
node .\start.js
```

访问同一服务的 `/video.html`。写接口需要与 Host 完全相同的 `Origin`，JSON 请求使用 `Content-Type: application/json`；上传使用实际媒体 MIME。仅允许127.0.0.1/localhost和本机同源，拒绝跨站及same-site跨端口请求。

普通启动会自动加载本机 `video-engine/node-adapter.cjs`，并检查Python、Pillow、FFmpeg/ffprobe及可用中文字体，无需设置额外启用变量。依赖齐全时 `config.rendererAvailable/engineReady=true`，可以直接上传图片、填写短字并开始制作。缺少依赖时返回安全的 `rendererErrorCode/rendererError`，页面显示具体原因；修复字体等本机前提后点“重新读取配置”会显式重查（`GET /api/video/config?refresh=1`）。PATH或Python可执行文件改变时应重新启动服务。

当前运行入口：**http://127.0.0.1:52553/video.html**。选择“宠易购精品猫舍犬舍”使用GEO生成与长文分屏；已有图文演示客户仍可查看短句样片。服务使用隔离的`output/video-production-20261104/integration/demo-data`，不写正式客户库。当前PID、端口、命令和日志见`output/video-production-20261104/geo/service.json`。本机画面合成使用FFmpeg；GEO文字使用既有WorkBuddy文本认证。

可独立注入渲染器进行加载和测试，无须全局开关：

```javascript
const { createHandler } = require('./video-api.js');
const handle = createHandler({
  dataDir: 'D:/private-video-data',
  env: { ...process.env, FANGLI_DATA_DIR: 'D:/private-content-data' },
  renderBatch,
});
// await handle(req,res)：未命中返回false
// 退出时await handle.close()，等本地执行结束后释放目录锁
```

## 生成店铺GEO文字并分屏

在[视频制作页面](http://127.0.0.1:52553/video.html)选择客户“宠易购精品猫舍犬舍”，填写选题，点击“生成GEO文案并分屏”。页面读取当前客户已有资料，使用既有WorkBuddy认证与`deepseek-v4.1-flash`文本能力，返回标题、完整正文、逐屏短文字和停留时间；原有手填流程继续可用。

完整正文按**Unicode码点、去全部空白、包含标点、不含标题**计数，目标150—250字。分屏文字拼接后必须完整等于正文，不把长文只存档而仅展示标题。页面可编辑完整正文和各屏；修改完整正文后点“按完整文案重新分屏”。逐屏编辑会同步完整正文和编辑标记。选择已有图片后，可用“用勾选图片轮换填充分屏”编排；确认后显式点“开始制作本批视频”。

分屏按当前画幅、字号和真实Pillow字体测量，最多两行，优先按句读组织，每屏最多22字，通常10—22字，3—6秒，整条45—75秒。文字保留原有内容，不截断或自动缩小字号。正文、分屏、时长与来源共同进入不可变视频版本。

资料只按当前客户读取。问题清单提供店名和读者选题语境，记录/合同/交接内容组织成消费者要问、要核对的事项；来源摘要、Unicode读取范围和生成ID可追溯。生成文字是草稿，不能由来源归属检查推导为独立事实审核。

新增接口：

| 路径 | 合同 |
|---|---|
| `POST /api/video/content-generations` | `{clientId,requestId:UUID,topic,width?,height?,motion?,textStyle?,sourceIds?}`，返回`{id,clientId,model,version,title,body,characterCount,counting,segments,durationSeconds,screenCount,subtitleCharacters,sourceRefs,...}` |
| `POST /api/video/content-layouts` | `{clientId,body,contentGenerationId?,width?,height?,motion?,textStyle?}`，本地按实际字体重新分屏，不调用文本模型 |
| `GET /api/video/content-generations/:id?clientId=...` | 当前客户的生成记录及结果 |

原始模型返回和来源摘要保存在视频SQLite的`content_generations`表。相同requestId与相同资料版本复用结果；进行中的重复请求不并发调用模型。生成失败、结构/字数不合格时保留用户草稿，不自动重复请求。切换客户后旧响应不写入新客户草稿。新视频可带`contentGenerationId`和`contentEdited`；生成来源须属于本客户且已完成，视频的完整正文须与分屏文字一致。编辑标记与模型原始返回分别保留。

本次三条样片来自三篇真实WorkBuddy初稿，经明确记录的编辑后出片：178字/12屏/51秒、213字/13屏/58秒、183字/12屏/52秒；字幕字符数分别与完整正文完全一致。初稿与编辑差异见`output/video-production-20261104/geo/editorial-changes.json`，原始响应保留，未把人工编辑冒称原始模型输出。另一次有界修正返回129字，被篇幅校验拒绝；本阶段共4次文本调用、2次模型目录查询，没有继续重复调用。

成片与SRT：`output/video-production-20261104/geo/downloads/geo-1/2/3.mp4`及同名`.srt`。独立FFprobe/全帧解码/字幕覆盖检查通过，0音轨，720×1280、25fps；抽帧接触图`geo/contact-sheet.jpg`已目视检查。素材是用户参考截图裁切，图片用于画面编排，不作为文字中所有事项的事实证据。客户来源正文从既有隔离资料只读复制，正式客户库、原PDF和原稿未改。

## 数据与版本

目录优先级：`FANGLI_VIDEO_DATA_DIR` → `FANGLI_DATA_DIR/video` → `frontend-examples/.data/video`。目录须在静态根目录外或隐藏目录中。客户数据只从 `FANGLI_DATA_DIR/workspace.sqlite3`（默认`.data/workspace.sqlite3`）以SQLite `mode=ro`读取，不改文案、客户事实或旧稿。

```text
video/
  video.sqlite3                       # 批次、条目、不可变版本、进度、结果、素材
  service.lock                        # 存储进程持有的系统独占锁
  uploads/<随机UUID>.<媒体扩展名>
  batches/<batchId>/
    manifests/<jobId>.json             # 内部素材绝对路径，不暴露前端
    output/<jobId>/video.mp4
    output/<jobId>/subtitles.srt
  cache/                              # 本地渲染缓存
```

新任务用唯一batchId绑定数据库中的完整版本SHA256，输出目录无需重复嵌入64位哈希，避免Windows原子状态文件路径过长。历史记录继续按各自原目录读取；同一任务重试不换目录。过长的自定义私有数据路径会在执行前明确拒绝。

每个上传记录SHA256。批次及逐条版本指纹包含mode、25fps、素材ID及内容SHA256、展示文字、时长、运动、画幅、文字样式和来源等完整规范化设置。提交时检查实际内容，执行和恢复时校验不可变素材；素材被本机外部操作改写后要求重新上传并新建任务，不复用旧片。重复提交相同规范化内容返回原批次；修改设置产生新版本及输出目录。原稿和原记录保留。

全局仅一个执行槽。Python存储进程持有Windows `msvcrt` / Unix `flock`系统文件锁，第二服务使用相同目录返回 `409 STORE_LOCKED`；SQLite `BEGIN IMMEDIATE`事务领取任务。每批、每条串行调用renderer。相同素材在一次条目执行/恢复检查中去重验证，流式计算内容摘要，不整批读入内存。

停止运行任务先返回 `stopping`，发送AbortSignal，等renderer Promise确认本地执行结束后才 `cancelled`；未领取任务直接cancelled。存储失联会停止后续调度并向当前执行发出AbortSignal。重启将queued/running/stopping标为interrupted，只有明确POST retry才继续。重试沿用ID、版本、manifest/output/cache目录及参数，跳过已完成条目。`canRetry`同时检查模式、渲染器、素材及已完成文件，不提供缺素材或缺文件的假恢复。

## HTTP API

响应为UTF-8 JSON，文件下载除外。错误为 `{errorCode,error}`，不包含内部路径或原始进程错误。资源由数据库中的客户/批次/job关系定位；素材须属于当前客户。客户归属是本机工具的数据引用约束。媒体URL带clientId，调用方应原样使用；显式指定的客户不匹配时返回404。

| 方法与路径 | 请求或响应 |
|---|---|
| `GET /api/video/config` | `mode:'silent'`、`engineReady/rendererAvailable`、25fps、默认画幅、数量/时长/文字限制、motions/textStyles/defaults |
| `POST /api/video/upload?clientId=...&name=...` | 原始媒体body、实际MIME；返回 `{id,assetId,clientId,name,type,size}` |
| `GET /api/video/batches?clientId=...` | 最近100批，含原稿、分段、来源、设置、结果与状态 |
| `POST /api/video/batches` | 下方创建对象；首次202，重复提交200 |
| `GET /api/video/batches/:id/status?clientId=...` | 单批状态 |
| `POST /api/video/batches/:id/stop` | JSON `{clientId}`，也可从URL指定客户；返回当前状态 |
| `POST /api/video/batches/:id/retry` | 同版本继续；成功202，不可继续409 |
| `GET/HEAD /api/video/batches/:id/files/:jobId/video.mp4` | 完成条目的MP4，默认下载；URL后加`&inline=1`内嵌；支持单段Range |
| `GET/HEAD /api/video/batches/:id/files/:jobId/subtitles.srt` | 按画面停留时长编排的UTF-8 SRT |

```javascript
{
  clientId, mode: 'silent',
  jobs: [{
    id: 'clip-1', title: '今天也很可爱', width: 720, height: 1280,
    source: { runId, artifactId, contentVersion }, // 可省略
    originalText: '保留的原始文字',                // 可省略
    motion: 'gentle',                            // none或gentle
    textStyle: { position: 'bottom', preset: 'white-outline', fontSize: 48 },
    segments: [{ id: 's1', text: '今天也很可爱', media: assetId, durationSeconds: 5 }]
  }]
}
```

`motion`默认gentle；position默认bottom，可选top；preset默认white-outline，可选yellow-outline；字号为输出像素，默认48。每批1—30条，每条1—100段，每段1—60秒，允许有限小数，单条总长不超过600秒；宽高为128—1920的偶数；每段文字上限500个Unicode字符。JSON最多2MiB，上传最多32MiB，支持PNG/JPEG/WebP/MP4/MOV/WebM/MKV并检查文件签名，签名通过不等于可解码。素材只能是上传assetId，不能传本地路径。

为保持短文字可读，后台保守预检最多2行、文字区不超过画面高32%，字号为16—128整数像素，且不小于短边的1/40、不大于短边的1/3。超出时返回 `TEXT_TOO_LONG` 或清晰的画幅/字号错误，提示缩短文字或分成更多画面；不截断、不自动缩字或分页。此预检按保守字宽估算，渲染器仍须使用实际字体测量和拒绝溢出。不能把500字上限理解为500字均适合放在一张图片上。

批次响应包含 `{id,clientId,mode,state,version,attempt,canRetry,jobs}` 及时间。jobs包含 `id,title,state,phase,completedSegments,totalSegments,version,source,originalText,segments,width,height,motion,textStyle`。完成后返回逐条 `mode:'silent',audioTrackCount:0,durationSeconds,videoUrl,subtitlesUrl`；整批完成也返回总时长及0音轨。失败可有安全的 `errorCode/error`；不可恢复时有retryUnavailableReason。新任务phase只使用render/concat。完成结果还可返回并持久保存reusedSegments（实际复用的有效片段数）。

普通素材/本地渲染错误仅影响当前条目，继续同批后续条目。字体缺失、工具缺失、引擎占用和引擎异常退出等前提错误停止整批；缺依赖时须先修复并重新读取配置，不能当成普通素材错误继续。实际字体测量错误映射为清晰的文字/布局错误，不暴露原始进程输出。模式不符、含音轨、结果字段矛盾等适配器协议错误停止当前整批，后续条目标为interrupted。`MEDIA_CHANGED`表示上传后内容被改写，不能按原版本继续。

历史记录、原文件及原字段保留可读，既有本地音频文件下载仍可用；历史模式不被标为silent或伪造0音轨。历史模式重试返回 `409 MODE_UNSUPPORTED`；`POST /api/video/voice-previews` 在加载适配器前返回 `409 PREVIEW_DISABLED`。这些入口不会发起外部调用。

## Renderer接线

```javascript
renderBatch({
  mode: 'silent', manifest, output, cacheDir, signal, onStatus
}) // Promise<{success:boolean,jobs:[{id,state,mode:'silent',audioTrackCount:0,durationSeconds,errorCode?}]}>
```

manifest为内部JSON文件路径，结构：

```javascript
{ mode: 'silent', fps: 25, jobs: [{
  id, title, width, height, motion, textStyle, source, originalText,
  segments: [{ id, text, media: '验证后的绝对路径', durationSeconds }]
}] }
```

每次调用只有一条job。原稿、来源和附注作为独立字段传递，只有segment.text用于展示。最终文件必须是 `output/<jobId>/video.mp4` 和 `subtitles.srt`。MP4应仅有视频流，素材自带声音也移除；不能以静音音轨代替0音轨。SRT按durationSeconds排时间轴，不读取音频决定时长。

renderer回报 `onStatus({id,state,phase:'render'|'concat',completedSegments,totalSegments,errorCode?})`。后端持久化进度；出现其他phase会发出AbortSignal并停止整批。必须在AbortSignal后停止后续段落/条目并等待本地子进程退出再结束Promise；父Node异常退出时也应停止本地编码。

后端要求最终success和逐条state一致，mode=silent，audioTrackCount严格为数字0，durationSeconds为正有限数且与计划时长误差不超过0.025秒（累计边界量化约半帧误差），并验证两个实际文件存在；600秒成片上限仅容许一帧编码误差。每次单条调用只接受一个对应job结果。成功结果中的这三个字段写入SQLite；重载不会从目录中的旧status.json猜测它们。缺字段、时间轴矛盾、带音轨或模式不符均不能标为completed。

引擎应以实际媒体内容和全部渲染设置建立缓存指纹；保持同一参数/同一output/cacheDir时可复用本地结果。后端的元数据校验不代替对实际MP4流的ffprobe验收，后续集中接线阶段还需验证真实0音轨、实际时长和画面。

## 实际集成验收

`output/video-production-20261104/integration/` 保存完整证据：

- `submitted-ui-payload.json`：实际video-ui.js controller通过HTTP上传素材、填字、设置位置/颜色/时长/运动后提交的三条任务；不是手写绕过页面合同的替身请求。
- `acceptance.json`、`http-events.jsonl`：实际HTTP队列、停止/同批重试、刷新和服务重启恢复、缓存及进程证据。停止真实FFmpeg后先stopping再cancelled，后续条目未启动；恢复保留同ID、版本、目录，已完成片段SHA256和修改时间未变，已完成条目跳过。
- `downloads/`：从真实MP4/SRT下载接口取回的三条成片。独立FFprobe与完整解码证明每条仅一条视频流、0音轨、720×1280、25fps：小猫3.24秒/81帧，小狗3秒/75帧，两图切换4.4秒/110帧；UTF-8字幕文字与累计帧时间轴一致。
- `media-verification.json`、`frames/`、`contact-sheet.jpg`：下载文件的独立检查和已目视检查的关键帧。示例素材为用户1200×6523参考截图的宠物画面裁切；猫400×690、狗470×565，属于“用户参考截图裁切演示，非独立高清原片/非新拍实拍”，清晰度受原图限制。原参考图未修改，画面未复制发布者界面、价格或健康保证文字。用户可自行上传原始高清图片替换。
- `service.json`、`service-*.stdout.log/stderr.log`、`resource-before.json`及进程/资源日志：运行入口和资源证据。Light资源预检通过，实际编码串行，无GPU任务；服务环境以系统变量白名单启动，不包含配音Key。

已修复实际集成发现的Windows深路径问题；旧失败的隔离测试记录与诊断仍保留在证据中。服务强制退出测试中日志尾未完整写入，已通过实际PID退出检查确认相关本地进程结束；没有补造进程结束日志。正常停止测试的子进程启动/结束日志完整配对。

本轮针对新增错误分类、页面本机配置原因/重查和旧目录读取运行3个focused用例，均通过；其余仍有效的离线合同证据按状态变化复用，没有重跑文案全套或重复编码已通过的成片。

实际浏览器能力仍不可用，本轮未重试同一失败、未使用外部Chrome/Playwright。已验证实际页面资源、controller/HTTP结构、真实下载和模块刷新，但**未验证桌面/窄屏浏览器排版、实际点击播放、IndexedDB权限/配额或剪贴板行为**。手动打开以上页面即可继续验收这些浏览器边界。
