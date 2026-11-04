# 交接证据索引

本目录保存 2026-11-04 项目交接选取的历史验收材料，供接手者理解已实现的行为和已知质量问题。文件来源及 SHA-256 见 [provenance.json](provenance.json)。本轮交接整理没有新增模型调用或视频编码。

历史记录中可能保留原机器文件位置、服务端口、进程号、工作区产物引用和当时版本 ID；它们用于追溯该次验收，不是新设备运行依赖。新设备以当前仓库、自己的本机配置与本次启动实际输出为准。原记录中的部分链接指向完整工作区产物，本目录仅收录下表材料。

## 合成样稿与实际质量评审

`quality/` 的客户和资料均为隔离验收的合成夹具，不对应真实商家。先读质量评审，再对照输入与稿件，能更准确理解自动审核的边界。

| 文件 | 用途 |
| --- | --- |
| [industry-source.json](quality/industry-source.json) | 工业稿合成资料与写作要求 |
| [industry-original.md](quality/industry-original.md) | 工业稿原 ZIP 核查后版本 |
| [industry-style-review.json](quality/industry-style-review.json) | 去味审阅返回及建议，不能自动全部视为成立 |
| [industry-candidate.md](quality/industry-candidate.md) | 明确选择部分建议后生成的候选 |
| [shop-source.json](quality/shop-source.json) | 店铺稿合成资料与要求 |
| [shop-final.md](quality/shop-final.md) | 店铺稿原 ZIP 核查后版本 |
| [quality-review.md](quality/quality-review.md) | 实际 Codex 评审，记录去重收益、过程说明、无依据推论及漏报误报 |

这些材料证明相关路径曾实际执行，并显示具体收益与缺陷。工业候选的一次只读事实复核虽报告通过，人工仍发现资料依据不足的推论；店铺稿也有穷尽性用语和审核误报。样稿没有经过用户最终质量确认，不能据此声称生产质量普遍通过。

## 后台整合与状态边界

以下为 `core-003` 阶段历史记录，涉及有效输入、配置、原生操作、归档、传输与生命周期。它们是当时状态的证据，后续修改仍需选择受影响边界验证。

| 文件 | 主要范围 |
| --- | --- |
| [verification.md](core/unified/verification.md) | 阶段说明及验证入口 |
| [effective-inputs.json](core/unified/effective-inputs.json) | 任务有效字段、说明、显式清空和冻结输入 |
| [native-operations.json](core/unified/native-operations.json) | 原生操作、工作版本和归档 |
| [lifecycle.json](core/unified/lifecycle.json) | 本次拥有的视频进程生命周期 |
| [http-summary.json](core/unified/http-summary.json) | HTTP 边界结果 |
| [controller-summary.json](core/unified/controller-summary.json) | 阶段汇总 |
| [final-boundaries.json](core/unified/final-boundaries.json) | 最后补充的相关边界 |

## 视频真实主站验收

[video/unified-004/verification.md](video/unified-004/verification.md) 与 [summary.json](video/unified-004/summary.json) 保存真实主站的固定版本来源、草稿恢复、素材、手填分页、历史媒体播放/下载及窄屏验收。该阶段发现运行中的视频服务仍缓存旧适配器；409 映射源码已修，运行时生效另由后续受控重载确认。后续 [video/runtime-005/verification.md](video/runtime-005/verification.md) 已记录正常重载后的实时 409、空正文和既存草稿／素材保持终验，主站保持运行，本轮模型、编码和新批次均为 0。

四方向视频文案与八稿阅读另见 [视频文案参考](../reference/video-authoring/八稿阅读.md)，写作策略见 [编辑校准示例](../reference/editorial/校准示例.md)。这些是后续评审和接入依据，生产入口状态见 [HANDOFF.md](../HANDOFF.md)。

## 如何使用证据

保留输入、规则版本、模型与参数、实际结果、采用状态和真实审阅意见的关联。历史模型接通不代表当前设备已配置成功；历史 UI 验收不覆盖后来改动；接口成功不等于事实或表达质量通过。

离线交接检查从仓库根目录运行 `python tools/check_handoff.py`，完整运行依赖检查使用 `--runtime`，提交前检查暂存内容使用 `--staged`。旧保真与部分前端/视频测试仍可能需要原 ZIP、完整输出夹具或特定字体，详见 [HANDOFF.md 的验证说明](../HANDOFF.md#验证与证据)。缺少前提时如实记录未验证范围，已有证据未失效时直接复用。

## 本次 Git 交接验证

[独立副本验证](git/checkout-verification.json) 记录了本次冻结暂存树的检查结果：从 Git 导出源码到独立目录，确认不含本机连接配置，完成相对风格库、11 个原 ZIP 核心哈希、证据快照哈希、运行依赖及三个入口模块的语法检查，使用空数据目录启动完整主站与视频子服务，六个页面／API 均返回 200，随后正常关闭。模型调用、目录查询、视频编码均为 0。该记录覆盖报告中的 source_tree；之后仅补充交接文档与该记录，后续业务代码变化需另行验证。
