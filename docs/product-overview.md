# AgentLink 产品概览

AgentLink 是运行在用户可信主机上的本地 Coding Agent 控制平面。它将已授权的移动端渠道连接到
用户本机已登录的 Coding Agent，并管理项目绑定、会话、审批、状态和服务生命周期。

## 当前范围

- macOS 本机运行；
- 微信 ClawBot 渠道；
- Codex CLI、Grok CLI 与 Claude Code 适配；
- 项目白名单、会话控制、原生审批转发和本机服务运维。

AgentLink 不提供云端托管执行环境，不替代下游 Coding Agent 的推理或原生沙箱，也不允许聊天消息
指定任意本机路径或直接拼接为 Shell 命令。

## 发行定位

项目采用 PolyForm Noncommercial 1.0.0，仅面向非商业的学习、研究、实验、修改和分发。
它是 source-available 项目，不是 OSI 意义的开源软件。具体限制见仓库根目录 `LICENSE`。
