# AgentLink 架构概览

AgentLink 将移动渠道与本地 Coding Agent 解耦为三个层次：

```text
移动渠道 → Channel Adapter → Control Plane → Agent Adapter → 本机 Agent
```

- **Channel Adapter**：认证、接收消息、渠道格式渲染和可靠交付。
- **Control Plane**：身份、项目登记、会话、队列、审批、状态、审计与进程生命周期。
- **Agent Adapter**：对接 Codex、Grok、Claude 等 Agent 的会话、Turn、取消与原生审批能力。

项目目录必须先经本机可信 CLI 登记；移动消息只能在已授权项目和会话范围内执行。Gateway 负责
线性化状态变更，但不取代 Agent 原生 sandbox 或权限系统。

## 扩展原则

- 核心事件与能力接口不绑定单一渠道、操作系统或 Agent 协议；
- 各 Agent 按其原生有效策略运行，移动端不能切换或提升原生权限；
- 原生 Agent 已允许的操作不被 Gateway 人为收紧；原生仍要求确认的操作可转发为一次性移动审批；
- 本机安装、配对、项目登记、密钥管理和破坏性维护命令仅由本机可信 CLI 执行。

实现与公开接口以源码、测试和 README 为准。
