# 本地图文视频引擎

图片主体、短文字叠加、按段设定时长，由本机FFmpeg输出MP4。默认720×1280、25fps。图片保持比例，画幅余白使用同图柔化背景；可选择轻微中心推近或静止。视频素材按段截取或循环。

## 后端接线

```js
const { renderBatch } = require('./video-engine/node-adapter.cjs');
const result = await renderBatch({
  mode: 'silent',
  manifest: { mode: 'silent', jobs: [{
    id: 'job1', width: 720, height: 1280, motion: 'gentle',
    textStyle: { position: 'bottom', preset: 'white-outline', fontSize: 48 },
    segments: [{ id: 's1', text: '认真看世界的小猫',
      media: 'D:/private/client/asset.png', durationSeconds: 5 }]
  }] },
  output: 'D:/private/video/batches/batch1/output',
  cacheDir: 'D:/private/video/cache',
  signal: abortController.signal,
  onStatus: status => persist(status),
});
// { success, mode: 'silent', jobs: [...] }
```

`manifest` 可为对象或JSON文件路径。对象中的素材须为后端验证归属后的绝对本地路径；CLI JSON允许以清单目录为根的相对路径。引擎拒绝网络URL、UNC、Windows设备名、重复id和不支持的媒体容器。

Node `renderBatch` 与清单省略mode时默认 `silent`。完成条目包括 `{id,mode:'silent',state:'completed',phase:'concat',completedSegments,totalSegments,audioTrackCount:0,durationSeconds,video,subtitles,reusedSegments,segmentFingerprints}`。`video/subtitles` 是供后端使用的本地绝对路径，网页应通过归属校验后的文件路由访问。输出文件固定为 `output/<jobId>/video.mp4` 与 `subtitles.srt`。

`onStatus` 仅使用 `render/concat` 两个phase，进度字段为camelCase。同步或异步回调按顺序交付，桥在返回前等待回调完成。backend数据库是状态真源；`status.json` 和 `batch-status.json` 为执行证据。

当前公开渲染入口只接受 `silent`，`previewSpeech` 导出保留但拒绝为 `MODE_UNSUPPORTED`，不启动Python。后端应保持历史任务原mode和产物元数据，重试前检验mode。当前任务不复用带音轨的历史成片。

## 时间轴与文字

- 每批1—30条，每条1—100段；宽高128—1920之间的偶数。
- `segments[].text` 是屏幕展示文字。原稿、标题、source、画面说明不拼入此字段。每段1—500字符，按实际字体像素测量，最多两行；超出安全区返回明确错误，要求缩短或拆段。保留文字、数字及型号，不截断、不自动缩小字号。
- `durationSeconds` 默认5秒，范围1—60；单条总时长最多600秒。25fps按累计边界取最近整帧，总误差最多约0.02秒；SRT、分段与成片共用该时间轴，返回实际成片时长。
- `motion` 为 `none/gentle`，默认gentle，仅为图片添加约2.5%的中心推近。
- `textStyle.position` 为 `top/bottom`，默认bottom；`preset` 为 `white-outline/yellow-outline`，默认white-outline；`fontSize` 默认48，按输出像素解释。范围16—160，且需满足画幅最小可读字号及文字安全区。字体优先微软雅黑粗体，使用Pillow实际测量与绘制，左右保留7%、上下保留9%安全区。文字使用透明PNG覆盖层，文字中的符号不作为滤镜指令解析。

每段编码与最终合并都显式选择视频流。引擎在标记完成前用FFprobe检查一条视频流、0音轨、目标画幅、25fps和时长；视频输入的原音轨不进入输出。SRT按段落起止时间导出。

## 缓存、停止和错误

两个任务共享私有cacheDir时，可复用 `silent-clips/<fingerprint>.mp4`。指纹包含mode、渲染版本、素材内容哈希、完整文字、原始及帧量化时长、运动、画幅、字体内容哈希和全部文字样式。原输出目录的同指纹片段保持原文件，修改文字、时长或素材只重编码受影响片段。缓存和最终文件提交前校验，临时MP4成功后原子替换。

默认数据路径按 `FANGLI_VIDEO_DATA_DIR` → `FANGLI_DATA_DIR/video` → `frontend-examples/.data/video` 下的cache目录。建议后端显式传同一个cacheDir；重试保持原output/jobId。缓存路径与输出路径均应位于私有目录。

Node模块内全部任务串行，Python对cache/output加OS文件锁；异常退出后OS释放锁，锁文件可保留。`AbortSignal` 预先中止时不启动Python；活动任务先报stopping，精确终止本次FFmpeg子进程并确认退出后才返回cancelled。stdin关闭也停止当前工作和后续段落。后端重启后按持久化状态显式恢复，不能从引擎临时文件猜测完成。

常见错误：`INVALID_INPUT`、`TEXT_LAYOUT_INVALID`、`TEXT_LAYOUT_TOO_LONG`、`DURATION_INVALID`、`MEDIA_INVALID`、`RENDER_INVALID`、`MEDIA_PROCESS_FAILED`、`FONT_MISSING`、`ENGINE_BUSY`、`CANCELLED`、`MODE_UNSUPPORTED`。输入/素材错误可保留其他条目的执行；工具/字体缺失及锁冲突应先修复前提。错误含 `errorCode/error/haltBatch/billingUncertain`；当前路径billingUncertain为false。Node异常退出为 `ENGINE_INTERRUPTED`。

## 运行与验收

Python 3.11+、Pillow、FFmpeg/ffprobe（libx264、overlay、gblur）、微软雅黑或Noto CJK字体。`FANGLI_PYTHON` 可指定Python可执行文件。Node子进程只继承运行所需的系统环境白名单。渲染路径不加载配音配置或供应商参数。

```powershell
$env:PYTHONUTF8='1'; $env:PYTHONIOENCODING='utf-8'
python frontend-examples/video-engine/tests/test_silent_renderer.py
node --test frontend-examples/video-engine/tests/test_silent_adapter.cjs
python frontend-examples/video-engine/examples/prepare_silent_samples.py
node frontend-examples/video-engine/examples/run_silent_samples.cjs
python frontend-examples/video-engine/tests/verify_silent_samples.py
```

样片素材为用户参考截图的宠物画面裁切，原图1200×6523；裁切来源和像素限制保存在 `output/video-production-20261104/engine/silent/material-provenance.json`，原截图保持原样。样片和进程日志、验收证据位于同一silent目录。`engine-processes.jsonl` 记录PID、完整命令、退出码、工作集和提交余量，较长媒体进程每10秒记录内存。当前验收见 `TEST_REPORT.md`。
