# 图文视频引擎验收（2026-11-04）

Task `video-production-20261104` / Lane `engine` / Dispatch `engine-003` / **completed**

通过项目Node桥、Python与本机FFmpeg完成3条图文样片。默认入口为 `mode:'silent'`，进度仅render/concat，时间轴取自每段durationSeconds，文字按实际输出字号叠加。成片均为720×1280、25fps、H.264，只有1条视频流、0音轨。

| 样片 | 时长/帧数 | 文字/样式 | 素材运动 |
|---|---|---|---|
| cat | 6秒 / 150帧 | 认真看世界的小猫；底部白色描边，48px | 轻微推近 |
| dog | 5秒 / 125帧 | 今天的小可爱；顶部黄色描边，52px | 静止 |
| two_pets | 10秒 / 250帧 | 猫、狗各5秒；底部白色描边，48px | 轻微推近 |

## 证据和验证范围

Python新边界focused检查4/4通过：默认样式/时长及文字安全区；指纹覆盖文字、时长、运动、样式、画幅及素材；实际改字/时长后只重编码第一段、第二段文件不变；含AAC音轨的视频素材输出分段及成片均0音轨。将speech、安全配置读取和网络opener设置为一调用就抛错，实际渲染仍完成。

Node实际Python桥检查3/3通过：省略mode默认silent且phase仅render/concat；预览和其他mode在创建输出及启动进程前拒绝；AbortSignal返回stopping后确认两个任务cancelled，未创建第二条输出。底层Windows字幕路径、OS锁和精确子进程停止沿用已有证据；未重复旧套件。

3条样片分别通过完整FFmpeg解码、FFprobe实际帧数/流清单/时长检查。每段与最终输出均显式排除音频，并在引擎完成边界检查0音轨。SRT分别结束于6.000、5.000、10.000秒；双图在5.000秒切换，字幕与时间轴一致。

抽取cat/dog各2秒及two_pets第2/7秒画面，已查看接触图。宠物主体比例、字形、描边、安全区正常，标题短句完整，未见搜索栏、人物、播放按钮、时间角标、发布者UI、广告文字。狗图画幅余白使用同图柔化背景，字幕不遮挡眼睛。

## 素材来源

素材为**用户参考截图裁切演示，非独立高清原片/非新拍实拍**。原截图1200×6523像素，保留原文件。坐标按原始像素 `[left,top,right,bottom]`：

- 猫：`[24,2290,424,2980]`，400×690。
- 狗：`[650,2610,1120,3175]`，470×565。

裁切只用于本次本地样片。720×1280输出包含上采样，原截图的压缩和分辨率限制仍可见；后续可替换客户提供的原图。文案为“认真看世界的小猫”“今天的小可爱”，不包含门店、价格或保证类事实。

## 可播放产物

根目录：`D:/Codex/方立/output/video-production-20261104/engine/silent/`

- `samples/cat/video.mp4`、`samples/cat/subtitles.srt`
- `samples/dog/video.mp4`、`samples/dog/subtitles.srt`
- `samples/two_pets/video.mp4`、`samples/two_pets/subtitles.srt`
- `contact-sheet.png`，以及cat-2s.png、dog-2s.png、two_pets-2s.png、two_pets-7s.png。
- `sample-manifest.json`：完整参数和本地素材路径；`sample-results.json`：引擎返回值；`status-events.jsonl`：进度。
- `material-provenance.json`：原图哈希、尺寸、裁切坐标和来源。
- `cat-probe.json/dog-probe.json/two_pets-probe.json`：实际流、帧数与时长。
- `acceptance.json/engine-003-verification.json`：验收摘要。
- `samples/engine-processes.jsonl`、`verification-processes.jsonl`、`tests/processes.jsonl`、adapter-tests下进程日志：PID、命令、退出码和内存。

Light资源检查通过，开始可用物理内存7.07GB、提交余量48.87GB；串行CPU编码，未启动常驻服务。当前阶段外部生成API调用为0，不读取密钥。已有历史样片和配置保留。

## 接线与后续边界

`renderBatch({mode:'silent',manifest,output,cacheDir,signal,onStatus})`，缺mode默认silent；完成项含 `mode:'silent'/audioTrackCount:0/durationSeconds/video/subtitles`。素材须先由后端按客户归属验证，再传绝对路径。沿用原output/jobId可恢复，同一私有cacheDir可跨输出复用。Node桥保留previewSpeech导出并拒绝MODE_UNSUPPORTED；旧任务按原mode由后端保留历史读取和重试限制。

本机Pillow可用；当前字体为微软雅黑粗体。文本最多两行，超长时返回TEXT_LAYOUT_TOO_LONG并明确要求拆段，字号不自动缩小。连续边界按25fps取最近帧，累计时间误差最多约0.02秒；整数秒样片均精确匹配。

本阶段未进行backend/UI真实接线或HTTP队列的3条/停止重试验收；这些由下一阶段集中完成。Browser能力没有变化，沿用已确认不可用的证据，未重复尝试或改用外部浏览器。公共错误码需要后端按当前README对齐，尤其文字布局、时长、字体、渲染和取消错误。引擎阶段完成后结束，不自动启动集成。
