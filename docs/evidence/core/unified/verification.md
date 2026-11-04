# core-003 后台完整接线与统一服务验收

本轮后台范围已完成，供控制线派回原前端/视频执行线做最终页面验收。本报告是测试证据，不修改控制线唯一任务状态。原 `app/`、`web/`、`video/` 以及旧项目数据均未写入；未停止旧62885服务/PID72376或52553服务。本轮真实模型调用、目录查询、视频编码均为0。

## 保留服务

- 统一地址：http://127.0.0.1:60128；文章入口/workbench、/workbench/zip；视频/video/。
- 主PID70552；视频Node PID80252，内部端口60129。精确命令、数据目录、就绪记录与日志路径在 `service.json`。
- 本轮仅用正常shutdown替换此前隔离PID83312；已等其退出并检查其专属子进程退出后再启动新实例，其他服务不受影响。
- 数据目录：`D:/Codex/方立/output/geo-merge-20261104/core/unified/data`。
- 日志：`main-final.stdout.log`、`main-final.stderr.log`；数据目录/logs/video.stdout.log、video.stderr.log、video-lifecycle.jsonl。
- 停止：同源 `POST /api/workbench/shutdown {}`；明确重启所拥有的视频服务：`POST /api/workbench/video-service/restart {}`。运行状态：GET /api/workbench/runtime。无需手填video-base。

## 已实现与最小充分证据

1. A—D有效输入：当前brief八项客户字段、有效note、显式清空、事务保存、冻结配置与资料、确认别名到原生队列、新任务平台空选和启用目标AI全选。`test_effective_inputs.py` 3项通过，见effective-inputs.json。后续配置与版本扩展后相关三项已重验，未重跑旧全套。
2. 原配置POST/PUT/DELETE models/platforms/risks与POST prefs真实持久化；名称/关联/枚举校验、原生偏好及风险清理、平台任意已配置形态、新旧草稿失效、在途配置冻结。写作模型和目标AI独立。
3. 标签和声明加入expected_version人工保存；只改提供字段，清空传[]，旧版本保留，任一内容变更清除旧核查/评分；CAS、锁、归属均检查。
4. regenerate实际调用原generator.run_regenerate，再调用原audit_article；audit仅调用一次原audit_article。保持原平台/账号/形态/关键词组/角度。先隔离写入，完整成功后一次事务更新原生参考、采用版本、来源和审计；重写核查前初稿另留版本。原生重写的空流后备分支被传输失败门闩阻止再次外发。失败、断线或核查失败保留当前稿、原参考与旧证据。旧证据按版本固定，新人工/候选继承其基稿来源。
5. write-one实际调用原run_write_one，只处理原配额下一待写项，完成停止；无剩余409，不增加配额。单篇逻辑删除与列表、导出、原生待写统计一致；历史版本/视频来源保留。
6. clone同客户当前可见brief和所选资料，记录父任务，创建未生成新任务；不复制计划、稿件、消息或完成状态。历史删除为逻辑删除，模型运行时409。以上结构性动作及原生显式操作必须待当前任务收尾。
7. archive下载真实本地ZIP；包含当前安排、选定及历史冻结解析文字、原生参考、所有工作版本/原生核查/差异/实际意见、当前四格式导出。白名单从内容记录构建，不打包连接配置、数据库、私有目录、诊断trace，不外发。旧直连凭据/测试由WorkBuddy替代，旧远程upload未开放。

第2—7项的7个focused HTTP/SQLite测试通过，见native-operations.json；模型部分仅注入固定响应，没有调用外部服务。传输失败门闩和核查前初稿是新发现的独立边界，修正后仅重跑这组相关测试。首版6项也通过，未增加全仓/全量测试。

## 视频生命周期、代理和固定来源

- `test_video_lifecycle.py` 2项真实进程测试通过，见lifecycle.json：默认拉起、明确重启、同目录第二实例拒绝、正常HTTP关闭、父进程异常退出时专属Windows Job清理。所有记录的自有子进程均退出；冲突启动不影响已有实例。此层代码未发生后续变化，复用有效证据。
- `verify_unified.py` 的47项HTTP请求记录见http-boundaries.json/http-summary.json。主站/视频静态MIME及HEAD、同源/私有边界、明确采用版本正文、完整来源、跨客户/未采用拒绝、实际MP4和SRT全量下载及SHA256、HEAD/Range206/后缀/416、下载头、13MiB流式上传、错误MIME415、64MiB传输上限413均通过。
- 47项中首次上传的测试工具漏带Origin，被服务正确拒绝。修正工具后只重验三个上传输入；此前44项复用，不重复扫描。视频本身32MiB业务上限仍由子服务执行，主代理64MiB是独立传输边界。
- 真实视频控制器经60128同源HTTP导入明确人工版本9，按实际字体布局成5屏/22.76秒，保存的段落、来源ID、完整原Markdown、原结构化信息和原始生成/核查文本均一致；见saved-video-draft.json/controller-summary.json。测试曾误将完整正文断言在仅存ID的source上，现改读editorial；直接复用控制器在断言前已自动保存的成功导入/字体布局结果，没有再次导入或布局。完整元数据只作来源，不覆盖指定正文。随后已恢复原采用版本4，版本9仍可作为曾采用来源读取。
- 最终新进程的runtime/两合成客户/恢复版本4/固定版本9来源检查通过；测试键名修正后复用这四项读取，只继续跨稿件版本404、未采用409和实际archive下载。见final-boundaries.json。
- 实际下载本地归档 `local-task-archive.zip`：79808字节、22项、ZIP CRC通过，含当前四格式导出、解析文字和旧人工版本9。SHA256：8e22f51f909eea485c90918f41e23f230b0b801fe891432d8d8a6aaacd0e5f32。

## 夹具来源与限制

新数据使用SQLite backup接口从core-002正在服务的合成验收库做隔离快照，源库/WAL未复制覆盖或写入，记录在fixtures.json。原生成证据通过原初稿标题和正文的精确原生重放匹配后补齐，歧义/缺失不补造。只保留两个合成客户，没有接入用户旧项目客户/稿件。

媒体下载夹具明确复用video/productization已有169.12秒无声样片和SRT，仅复制一个验收记录；不是本轮新编码。13MiB上传夹具只追加合法MP4 free box，未改视频帧。来源文件、复制哈希、上传哈希均见fixtures.json/http-summary.json，不能把它们当成本轮新视频质量证据。

已知跨模块差异：主video-context对未采用候选返回409；video/workspace-context.cjs目前把上游409映射503 STORE_UNAVAILABLE，代理忠实保留该503。候选始终未导入、未回退。该映射属于视频执行线文件，本轮未越界修改；需视频线后续明确处理错误呈现。跨稿件版本404已由主服务补齐并验证。

前端当前仍需接/profile单事务、任意形态、tags/decl、write-one、regenerate/audit/delete、clone/delete/archive，并完成页面→可见brief→冻结ZIP输入验收；本轮不声称前端整体已交付。原生与去味内容质量仍沿用core-002诚实记录，不因本轮接口通过而宣称普遍质量通过。新的再生成/再核查真实供应商效果未测试；原生函数、参数与状态边界已用固定返回验证。浏览器验收由原前端/视频执行线完成。

当前完整合同：`D:/Codex/方立/fangli-workbench/docs/integration-contract.md`。
