# video-005 运行时生效终验

Task：geo-merge-20261104；Lane：video；Dispatch：video-005；Status：completed。

本轮完成video-004唯一待办：让现有视频子服务正常加载错误码修复，并在真实统一入口确认业务409与原草稿保留。未修改运行时代码，video-004已有focused、素材、播放及core-003传输/生命周期证据继续有效，未重复运行。

## 正常重载

2026-11-04 16:08:20.535（北京时间）的一次预检读取主站 `/api/workbench/runtime` 和现有视频SQLite的只读状态元数据。只有1个completed批次，queued/running/stopping批次0、活动预览0，runtime.kind/item均为空，主站PID70552、视频PID80252/ready。见 `preflight.json`。未轮询，未终止活动任务。

经明确授权，于16:08:55.808688向同源 `http://127.0.0.1:60128/api/workbench/video-service/restart` 发出一次POST，JSON正文为 `{}`，Content-Type为application/json，Origin为http://127.0.0.1:60128，Sec-Fetch-Site为same-origin。16:08:56.245504收到200及新ready状态。随后只读一次runtime，确认主进程与公开入口不变。

| 项目 | 重载前 | 重载后 |
| --- | --- | --- |
| 主站PID/端口 | 70552 / 60128 | 70552 / 60128 |
| 视频PID | 80252 | 77512 |
| 视频内部端口 | 60129 | 64764 |
| 视频状态 | ready | ready |
| start_count | 1 | 2 |

接口负责主进程自有子服务和Python存储的生命周期。本执行者未直接kill、未另起子服务或重启主站，也未访问新内部端口。见 `restart-attempt.json`、`restart-response.json`、`runtime-after.json`。不追加旧进程树检查或重复core生命周期套件。

## 实际页面与HTTP409

复用内置Browser原专用标签1/browser2。上一工具会话的句柄报browser.user不可用；读取故障文档后，通过一次工具会话重置重新取得同一标签，恢复操作。没有重开浏览器进程、创建新标签或操作frontend标签。恢复前失败发生在导航之前，候选URL只实际导航一次。

页面访问：

`http://127.0.0.1:60128/video/?client_id=584dd9da-3ede-42d6-b754-ef924b523df4&article_id=1&version_id=8`

同一页面触发的真实HTTP回执由只读CDP网络事件及Network.getResponseBody保存，不另发负例请求：

- POST `/api/video/content-imports`。
- 请求正文：`{"clientId":"584dd9da-3ede-42d6-b754-ef924b523df4","source":{"article_id":1,"version_id":8}}`。
- 实际HTTP409，错误码CONTENT_VERSION_CONFLICT，公开原因“视频来源需为明确采用过的稿件版本”。响应Date为08:12:11 GMT（北京时间16:12:11）。
- 页面显示同一原因；完整展示正文为空，来源未绑定，未载入其他草稿或采用版本作为候选正文。
- 原工业独立稿仍列在左栏3屏/11.76秒，新选中项为空；没有用错误入口覆盖店铺草稿。

见 `business-409.json` 和 `business-409.jpg`。捕获窗口中目标请求、响应和响应体均完整保留，仅观察到1条导入POST；窗口另标记更早事件截断（truncated=true），未据此宣称全局网络记录完整，未通过重复刷新补记录。不存在自动重试或服务降级导入。

## 原店铺草稿恢复

随后回到原明确入口：

`http://127.0.0.1:60128/video/?client_id=34847c7e-debc-4839-b680-2f5b51d36fae&article_id=2&version_id=9`

页面显示已恢复固定版本9草稿。通过一次只读DOM观察与video-004已保存证据比较，以下8项均为true：正文不变、来源不变、摘要不变、草稿版本不变、6屏、全文覆盖完整、6屏素材关联不变、源Markdown不变。结果仍是95字/6屏/27.36秒、草稿v7，关联cat.png，归档原文为固定2/9的body_md Markdown，而非当前编辑正文或旧结构化正文。见 `restored-draft.json` 和 `restored-draft.jpg`。

原标签已标记deliverable保留在店铺2/9页，网络观察已关闭。本轮未设置新视口覆盖，未执行空tabs.finalize。

## 调用、改动与风险

模型调用0、目录调用0、TTS0、图片生成0、云视频0、FFmpeg编码0、新制作批次0。正常视频子服务重载1次，主站重启0次。主客户、资料、文章和采用状态未修改；未提交新批次，未重做播放、大文件下载或分页验收。

交付改动仅为video/README.md更新最新终验结果，以及本目录证据文件。video-004运行时代码未修改，原测试证据未失效。运行时业务错误生效待办已经解除，无新增未解决缺陷。
