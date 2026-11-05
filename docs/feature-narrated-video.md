# 页面式短视频

在 `/video/narrated/` 选择客户和本次资料，输入主题后生成口播与画面。文章入口传入已采用的具体版本，可按原主题提炼短稿，也可填写更窄的短视频主题。生成前可选流程说明、图文介绍或问题解答，默认流程说明。画幅 720 × 1280，口播 100—160 字、3—6 页，生成器通常安排五页。页标题、要点与口播分别可编辑。画面要点直接显示给观众，生成目标为每项 8—16 字，生成与编辑保存统一允许每项最多 32 字。页面预览按实际字体、两行限制及页面可用空间校验。

素材库可多选上传或拖入图片、视频，复用当前客户已上传的素材。生成前勾选最多六份素材，按勾选顺序分配给页面。编辑时可逐页改模板、换素材或仅显示文字。预览使用图片原比例或视频首个可解码画面。素材 ID、名称、类型和 SHA256 随制作版本保存。

修改口播、页面或发布信息后保存为新版本，再制作成片。当前稿、历史版本和历史成片分别保留。每次制作按当时选定版本生成音频、时间表及字幕，旧版音轨和字幕留在旧成片中。预览面板提供 MP4、SRT、封面、口播、页面、发布标题与简介及有声版 WAV 下载。发布文案取成片对应的制作版本。SRT 按口播段对齐，成片同时显示相同字幕。关闭配音时全片安排约 36 秒，每页至少停留 4 秒。

## 来源与主工作台接线

- 客户资料入口：`/video/narrated/?client_id=<客户ID>`。从某任务进入并使用该任务的资料及要求时，可带 `conversation_id=<任务ID>`。
- 文章“制作视频”入口：`/video/narrated/?client_id=<客户ID>&article_id=<文章ID>&version_id=<明确采用的版本ID>`。三值来自文章所属任务及用户所见的已采用版本。旧全文视频继续位于 `/video/`，也可以从该页面打开短视频入口。
- 已有制作入口为 `/video/narrated/?client_id=<客户ID>&production_id=<制作ID>`。两个参数必填，页面按客户校验后直接打开制作。未匹配的会话操作不影响本次打开。
- 主服务继续以原路径同源代理 `/video/*` 和 `/api/video/*`；短视频的 API、脚本、草稿、进度及媒体由视频子服务持有。无需新增主服务写接口。`video/workspace-context.cjs` 复用主服务 `GET /api/workbench/video-context`；资料直出可传 `document_ids` 和 `conversation_id`，文章来源由主服务校验采用与归属，继承版本冻结资料。
- `video/narrated/contract.cjs` 将 `client`、选定 `documents`、`request`、`style`、`source_article`、`editorial` 固定在制作记录中。`video/narrated/author.cjs` 是短视频脚本生成入口，复用 WorkBuddy 传输和主服务精确模型目录，使用 `deepseek-v4.1-flash`。目录准备与内容请求分别记录；一次操作只发一次内容请求。原始返回保存在本机运行记录。
- 每条编辑侧事实记录带页码和资料来源。可逐字匹配的引文与待核对项分别显示；字面引用检查只验证出处，实际事实和表达仍由编辑阅读确认。草稿修改后不继承旧稿的逐页引用结论。

| 接口 | 请求与返回 |
| --- | --- |
| `GET /api/video/narrated/health` | 画幅、模板、渲染能力和本机普通话音色 |
| `GET /api/video/assets?clientId=…` | 当前客户已上传素材的 ID、名称、类型和大小 |
| `GET /api/video/narrated/asset-previews/{id}?client_id=…` | 验证归属和文件摘要后返回图片缩略图或视频代表帧 |
| `GET /api/video/narrated/productions?clientId=…` | 客户的制作列表 |
| `POST /api/video/narrated/productions` | `{clientId,topic?,note?,platform?,document_ids?,conversation_id?,request_key?}`，或 `{clientId,topic?,note?,platform?,source:{article_id,version_id},request_key?}`。两种来源均可传 `template:'process'\|'intro'\|'qa'` 和 `asset_ids?:string[]`。返回 202 和生成操作 ID |
| `GET /api/video/narrated/operations/{id}?wait=1` | 最多等待 25 秒，结束后返回 `production_id`，制作操作另返回 `render_id`；直接查询时省略 `wait` |
| `GET /api/video/narrated/productions/{id}` | 固定来源、当前版本、制作版本及成片记录。带 `client_id` 时校验归属，客户不匹配返回 404 |
| `PUT /api/video/narrated/productions/{id}` | `{expected_version,title,template,script:{paragraphs:[{page_id,text}]},pages:[{id,heading,points,layout?,asset_id?}],publish?:{title,description}}`。生成新版本预览，旧版本冲突返回 409 |
| `POST /api/video/narrated/productions/{id}/renders` | `{expected_version,narration:true,request_key?}`。返回 202 和制作操作 ID |
| `GET /api/video/narrated/productions/{id}/versions/{version}/page-{n}.png` | 指定保存版本的页面预览 |
| `GET /api/video/narrated/productions/{id}/renders/{render_id}/{file}` | 已完成版的 `video.mp4`、`captions.srt`、`cover.png`、`script.json`、`pages.json`、`publish.txt`、`narration.wav`。MP4/WAV 支持 Range，添加 `?download=1` 下载 |

`request_key` 是当前视频数据目录内的 1—256 字请求标识。传相同键、相同接口和相同 JSON 字段时返回 202 与原操作 ID，已结束的操作也适用。JSON 对象的字段顺序不影响判定，数组顺序和字段值参与判定。复用键但更改请求返回 409。查重优先于忙状态和制作版本校验。

操作记录先持久化标识指纹、操作 ID 和计划产出 ID，再开始模型或本机制作。主站未拿到回执时用原键取回，明确重试时使用新的尝试标识。进程中断后，若正式制作记录已提交对应产出，原操作可读为完成。其余未结束操作读为 `interrupted`，待主站确认下一次尝试。

## 运行和验收

除 `requirements-video.txt` 中的 Pillow 外，需要可运行的 FFmpeg（含 libx264/AAC）、ffprobe 和中文字体。有声版使用 Windows `System.Speech` 的 `Microsoft Huihui Desktop` 普通话音色，通过 PowerShell 本地合成。每段 WAV 实测时长决定画面与字幕边界；时间表保存到 `captions.json` 和 `captions.srt`。若音色缺失，健康检查明确显示，用户可选择关闭配音。渲染目录在独立数据目录的 `video/narrated` 下，包含生成原返、版本、实际 WAV、页面、音频测量和 ffprobe 结果。

```powershell
node --test tests/video/narrated.test.cjs tests/video/unified-ui.test.cjs
python -B tests/video/test_narrated_renderer.py
```

2026-11-05 阶段验收使用独立工作台、晴尾宠物生活馆资料和同一客户的采用文章夹具。手写稿跑出 44.76 秒样片；固定文章生成 109 字、5 页草稿，修改为第 2 版后由同源 API 生成 36.24 秒成片。两条均为 720 × 1280、普通话单音轨。固定文章在文案工作台更新后，短视频仍使用原文章版本；未采用文章和过期制作版本分别返回 409。MP4 Range 和六项成片下载已验证。资料直出真实原返 109 字、5 页，按最终编辑记录规则离线复验，4 条引用匹配、1 条待核，五页预览已生成。

本轮实际 WorkBuddy 内容调用 4 次（两种来源各 2 次），目录查询 1 次，Windows 配音 10 段，MP4 编码 2 次。资料直出最终规则没有再发起真实调用。Windows 界面工具未能确认浏览器地址，播放控件和窄屏交互尚待浏览器验收。实际音轨和字幕对齐已通过文件与探针核对；人耳听感待确认。

内容抽查：36.24 秒成片在开头给出三项准备，依次说明预约信息、近期状态与反应、猫包，最后落在到店确认毛结和接回时的梳理建议。口播与画面要点对应，细节可回到本次门店资料。资料直出短稿的预约提示与居家整理衔接还需编辑，不能由引用校验代替内容判断。
