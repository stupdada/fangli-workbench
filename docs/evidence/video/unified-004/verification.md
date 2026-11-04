# video-004 真实统一入口验收

- Task：geo-merge-20261104；Lane：video；Dispatch：video-004。
- 状态：partial。代码修复、真实页面链路和focused检查已完成；当前旧Node进程的错误码生效验收待正常重载。
- 主入口：http://127.0.0.1:60128/video/ 。本轮仅使用同源 `/video/*` 和 `/api/video/*`，未操作内部60129入口，未停止或重启服务。
- 保留页面：http://127.0.0.1:60128/video/?client_id=34847c7e-debc-4839-b680-2f5b51d36fae&article_id=2&version_id=9 。内置Browser专用标签已标记保留，临时视口覆盖已恢复。

## 改动

| 文件 | 行为 |
| --- | --- |
| video/workspace-context.cjs | 已知400/404/409保留业务状态和受约束的公开原因；私有诊断使用对应安全提示，未知响应及网络失败503；不重试 |
| video/workspace-store.py | Python存储边界同步区分400/404/409与未知503；不暴露底层诊断 |
| video/public/authoring-view.js | 兼容真实复用媒体只有部分editorial字段的记录，展示实际原批次；缺少原稿、分类、核查证据时如实标注 |
| video/public/video-ui.js | 明确文章入口优先恢复同客户、同文章、同版本的已编辑草稿，避免重新导入覆盖；其他版本独立保存 |
| tests/video/workspace-errors.test.cjs | 真实主接口业务错误与诊断保护的2项focused检查 |
| tests/video/unified-ui.test.cjs | 不完整历史记录、明确来源草稿恢复的2项focused检查 |
| video/README.md | 更新真实主入口验收结果及生效边界 |

未修改主工作台客户、资料、文章或采用版本，未接入尚未批准的四方向style-v2模块。本轮未创建制作批次。

## 真实页面结果

内置@Browser复用本任务专用标签。主页面显示主接口提供的客户、品牌、公司、产品四个独立字段。店铺固定来源为文章2/版本9；按照core夹具说明，当前采用版本已回到4，明确来源仍正确读取曾采用过的9。

`fixed-source-browser.json` 记录初次导入的79字、5屏、22.76秒，确认展示正文等于版本9的body_md正文，导入Markdown与固定版本完全一致；没有用旧zip_data正文替换。结构化原返、raw_generation、raw_audit与来源记录一致。此版本的native_audit和body_original为空，界面明确显示未提供，不继承为已核查。

在编辑区增加一句验收文案后，全文为95字、6屏、27.36秒。`edited-draft-browser.json` 记录刷新前后正文及各屏完全一致，来源仍为2/9，归档原文未变，全文去空白覆盖相等。随后上传已有246,289字节cat.png小图，轮换填充6屏；真实预览图片解码为400×690。`final-restored-browser.json` 记录切换到另一客户并返回明确来源URL后，草稿v7、95字/6屏、6份素材关联及图片预览均保留。

独立 `/video/` 入口使用工业夹具客户584dd9da-3ede-42d6-b754-ef924b523df4手填41字验收稿，完整分成3屏/11.76秒，来源保持独立，未出现店铺cat.png素材。见 `independent-browser.json`。这些均只保存为当前浏览器的视频草稿。

已有批次ac9e1644-ac2b-473a-a2bd-78d4d6e3df54的protocol-reused-video实际播放到7.1565秒：duration169.12、720×1280、readyState4、paused=false、error=null。界面保留原制作批次1e1c9342-ba87-4b06-bc2d-65df6afc75e9及缺失来源证据提示，不将它当成本轮新片。字幕链接实际下载完成，3,162字节，副本为 `downloaded-subtitles.srt`。视频下载链接指向同源既有文件；完整MP4下载、哈希、Range/HEAD及生命周期验收复用core-003，未重复大文件传输套件。见 `history-browser.json`。

1440×1000桌面和390×844窄屏均已目视检查。窄屏内容clientWidth=375、scrollWidth=375（包含滚动条的视口宽390），无横向溢出。见 `desktop-source.jpg`、`desktop-preview.jpg`、`mobile-source.jpg`、`responsive-browser.json`。

浏览器日志保留一条修复前07:44:03 UTC的editorial.rows.filter异常，见 `browser-errors.json`。对应文件最后修改于07:49:19 UTC；修复后实际固定来源、历史记录、归档展开、素材预览和草稿重开均完成。未清空旧日志来隐藏该记录。

## 验证证据与复用范围

| 方法 | 结果 | 范围 |
| --- | --- | --- |
| `node --test tests/video/workspace-errors.test.cjs` | 2通过，142.5021ms | 新加载适配器对当前真实主接口的409、归属404、参数400；非结构化或私有诊断保护、未知失败关闭、无重试 |
| `node --test tests/video/unified-ui.test.cjs` | 2通过，99.0386ms | 复用媒体editorial部分字段；明确来源9恢复已编辑正文且不覆盖其他版本4 |
| `node --test --test-name-pattern 'partial editorial' tests/video/unified-ui.test.cjs` | 受影响1项通过，80.3605ms | 增加原批次展示后的定向验证；未重复其他未变检查 |
| 实际@Browser | 上述页面、素材、草稿、播放、字幕下载及窄屏证据完成 | 当前主服务60128 |
| core-003 `core/unified/verification.md`、`http-boundaries.json` | 复用既有47项传输与生命周期结果 | 上传限制、下载哈希、Range/HEAD、主子服务生命周期，不重复运行 |
| video-002与video-003 | 复用既有成片及真实字体分页证据 | 169.12秒旧MP4/SRT、580/709字完整分页与两行检查，不编码新片 |

`adapter-errors.json` 三条真实主接口回执分别为409“视频来源需为明确采用过的稿件版本”、404“稿件不属于所选客户”、400“文章来源需同时指定article_id和version_id”。这里只新加载已修改的适配器访问现有主接口，没有新开服务，也没有声称当前视频Node进程已加载修复。

## 未完成的运行时边界

视频Node80252在启动时缓存workspace-context.cjs。本轮禁止重启服务，因此当前进程仍把未采用来源1/8的409显示为旧503“视频存储暂不可用，任务已停止，请检查本机服务”，实际页面保持空正文且未降级导入，截图为 `live-old-candidate-error.jpg`。在没有进程变化时未重复该失败验收。

所需下一步：由服务所有者在后续获准的正常生命周期重载视频服务，然后通过同源入口验收一次工业夹具文章1/版本8，预期409及公开原因；不得加载正文或改用其他版本。主进程70552及其子进程本轮均未由本执行者停止、重启或清理。

## 调用与副作用

本dispatch新增模型调用0、目录调用0、TTS0、生图0、云视频0、FFmpeg编码0、提交视频批次0。仅新增一张小图到店铺视频素材库，及两个固定夹具客户的浏览器视频草稿。既有媒体、主工作台源数据和采用状态未被修改。
