# 方立无声视频模块

视频工作区位于 `/video/`。支持独立手填全文/解析带分镜原稿，或由文章的“制作视频”入口手动导入具体采用版本；编辑、完整分屏、素材轮换、批量、停止/重试、成片预览和下载均已接通模块接口。不会自动再次写稿，也不做去AI味。

```powershell
node video/server.cjs --port 0 --workspace-base http://127.0.0.1:主服务端口 --data-dir D:/private/fangli-video
```

只监听127.0.0.1；stdout只有一条 `{type:'ready',port,pid}`，其他日志stderr。数据目录须在模块目录外，使用独立视频SQLite/媒体，不同步旧客户库。依赖Node、Python、Pillow、本机FFmpeg/ffprobe和中文字体。

客户/品牌/公司/产品分别取自只读主接口。文章入口为 `/video/?client_id=…&article_id=…&version_id=…`；文章和版本必须完整提供，后台校验归属、固定原文及摘要。改文案、分屏、素材会创建新视频版本，旧任务不换源。

`POST /api/video/content-imports` 区分完整展示正文和编辑信息；`POST /api/video/content-layouts` 对完整body按真实字体、画幅和字号分屏。summary、所有段落正文和公开关键数据保留；时间轴、画面/字幕提示、标签、发布声明另存。原始Markdown、结构化原返、原生核查及其原始返回按主接口实际内容保留，缺项在编辑侧显示未提供。

短稿150—250字/45—75秒是可选择的目标，另可选“按完整稿制作”。超目标如实显示字数/预计时长，用户明确勾选按当前稿制作才提交。自动分页不缩字、不截稿，按约3.5字/秒、每屏至少3秒和用户最短停留安排；100屏/600秒、两行和字号/画幅仍是实际执行边界。分屏、字体或原文修改后需重新分页。品牌关系或具体工况复核提醒只在编辑侧。

主服务需同时代理 `/video/*` 静态资源与 `/api/video/*`，保留Host/Origin/Sec-Fetch-Site及上传/Range/HEAD/下载响应。视频上下文最小字段沿用整合合同；完整来源记录建议在article增加可选zip_data、native_audit、body_original、raw_generation、raw_audit，缺项不伪造。body_md始终为当前指定版本的正文真值。

新稿可去实际 `/workbench/zip/index.html`；视频模块没有旧选宠prompt或假生成按钮。旧content-generations接口返回410及该入口。用户新批准的四方向独立“写视频文案”能力预留于 `public/authoring-view.js` 的稿件来源区，待其真实模块交付后接入；它将与文章导入/手填并列，不默认二次加工文章。

`upstream/` 继续保存backend-004原视频14文件的字节快照；`comparison/zip_native/` 保存原ZIP比较代码。第一阶段源清单、prompt及未改原稿保留在output/geo-merge-20261104/video/，禁止为重复测试再次运行compare.cjs。`runtime/` 沿用原无声引擎和持久队列，只替换来源、全文分页与产品接线。

video-002证据：output/geo-merge-20261104/video/productization/verification.md、summary.json、media-verification.json、browser-verification.json。新增4项focused用例通过；580字全文已真实生成一条169.12秒/35屏/0音轨视频，字幕完整相等。709字全文分页43屏/205.12秒，未编码。模型/目录/TTS/生图/云视频调用均0。桌面和390像素窄屏、素材轮换、独立手填及实际预览/下载已验。

video-002通过严格只读合同替身完成模块内部真实HTTP到FFmpeg边界；video-004已在真实主工作台同源入口验收来源、编辑、素材及历史媒体。已有CLI、停止重试、重启恢复及旧成片证据继续复用。

## 自动分屏修正 video-003

自动分页增加相邻两屏的句内前瞻，优先标点、流程分隔、连接词或词间断点，保护已有名称、英文词和数值范围。容量截断时先检查后续剩余文字，避免把“合同条款”截成“合同条｜款。”；自然独立短句不因字少而被强行填满。

同一字体/720×1280/48像素参数下，580字宠物稿为36屏、预计168.24秒，709字工业稿43屏、预计205.12秒，42字手填稿仍2屏、12秒。全文去空白完全一致，每页经真实Pillow字体检查不超过两行。数据和旧/新尾页图片见output/geo-merge-20261104/video/pagination-003/verification.md。

验证命令：`python -B tests/video/test_pagination.py`，2个focused用例通过。本轮模型/目录/编码均0；上述为新布局预览，已归档169.12秒MP4/SRT保留为原制作版本。后续用户明确重新分屏并提交时，按既有不可变版本规则保存新参数。手动逐屏编辑、重排、删页及来源逻辑未改。

## 真实主工作台验收 video-004

主入口为 `http://127.0.0.1:60128/video/`，仅经同源 `/api/video/*` 操作。来源固定为店铺夹具文章2/版本9；展示正文来自该版本的body_md，原始结构化返回与原生返回单独归档。缺少的核查详情及核查前原文按实际记录提示未提供。客户、品牌、公司、产品分别显示。

修复已有媒体复用记录缺少逐行分类时的历史渲染异常；修复重新打开明确文章入口覆盖已编辑草稿的问题，现在按当前客户、文章、版本恢复对应视频草稿。主适配器保留已知400/404/409业务状态及安全公开原因；非公开诊断和未知服务故障仍关闭处理。Python存储边界同步保留这些业务状态。

`node --test tests/video/workspace-errors.test.cjs` 与 `node --test tests/video/unified-ui.test.cjs` 各2个focused用例通过；归档来源展示调整后只重跑受影响的1个用例。实际Browser验收覆盖固定版本正文与来源、95字/6屏草稿刷新保存、素材上传与预览、跨客户独立41字/3屏全文分页、旧169.12秒成片播放及字幕下载、桌面与390像素窄屏。复用core-003传输与生命周期证据，本轮模型、目录、TTS、生图、云视频及FFmpeg编码均0。

video-004结束时，视频Node进程缓存了修改前的主适配器，未采用版本仍显示旧503提示。该轮遵守不重启服务要求；新加载适配器对真实主接口的400/404/409已验证，运行时生效验收留待下一轮。该轮证据见 `output/geo-merge-20261104/video/unified-004/verification.md` 和 `summary.json`。

## 运行时生效终验 video-005

2026-11-04 16:08:55.808—16:08:56.245（北京时间），在一次只读元数据预检确认无活动制作批次、预览或工作项后，通过主站同源 `POST /api/workbench/video-service/restart {}` 正常重载一次自有子服务。视频PID由80252变为77512、状态ready；主站仍为PID70552和端口60128。

原内置Browser标签对工业夹具文章1/版本8的一次实际导入请求返回409及“视频来源需为明确采用过的稿件版本”，当前正文为空，未加载其他稿件。返回店铺固定文章2/版本9后，95字/6屏/27.36秒、草稿v7、6屏素材关联及源Markdown均与重载前一致。未修改运行时代码，复用video-004 focused与既有传输/生命周期/媒体证据；本轮模型、目录、TTS、生图、云视频、FFmpeg编码及新视频批次均0。终验证据见 `output/geo-merge-20261104/video/runtime-005/verification.md` 和 `summary.json`。
