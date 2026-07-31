# Codex protocol fixtures

此目录保存经过脱敏、与支持版本绑定的Codex App Server协议证据。

- `0.144.4/manifest.json`记录最低支持版本和必要method；
- `0.144.4/generated/`由本机`codex-cli 0.144.4`在未启用`--experimental`时生成；
- 只保留AgentLink使用的入口、thread/turn与审批schema，避免提交598个无关类型；
- Core测试不得从此目录导入协议类型，私有结构只能存在于`agent-codex`。
