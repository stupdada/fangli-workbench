# 创作风格参考

`profiles.json` 保存平台、身份和发布形态的表达参考，`expression-references.json` 保存已有认可表达及其适用条件。它们是共享平台风格库在本次开发交接时的副本，来源和内容哈希见 `provenance.json`。

工作台通过 `config/style-library.json` 的 `root` 加载本目录；相对路径始终按仓库根目录解析。普通任务首次写作读取适用写法并冻结版本；生成后文风审阅独立读取适用参考。

`client_bindings` 需要绑定当前环境的客户标识和适用条件。新建客户或换机器后，应按实际业务配置，不能把表达样例当作客户事实。去味规则分别在 `config/de-ai-taste.md`、`config/ai-taste-signals.md` 维护。
