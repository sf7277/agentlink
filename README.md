# AgentLink

AgentLink 是运行在用户可信主机上的本地 Coding Agent 控制平面。它把移动端渠道连接到本机已登录的 Coding Agent，并统一管理项目、会话、审批、状态和服务生命周期。

当前提供个人实验与学习用途的 macOS 和 Windows npm 开发者安装方式，优先支持微信 ClawBot 与 Codex CLI；Grok 适配器可创建和管理 AgentLink 会话，但不支持导入既有 Grok 会话。

```text
微信
  ↓
AgentLink（本机）
  ↓
Codex CLI / Grok CLI
```

## 使用前须知

AgentLink 不是腾讯、微信、OpenAI 或 xAI 发布、认证或支持的产品。它仍处于个人实验/学习阶段，不是正式、一般可用或商业发行版。

使用者应自行承担平台帐号限制、服务中断、兼容性，以及本机 Agent 执行操作的风险；不得据此宣称获得任何平台或 Agent 提供方授权。

## 安装

### npm 开发者安装

环境要求：macOS（Apple Silicon 或 Intel）或 Windows 11 x64、Node.js 22 或更高版本，以及已安装并登录的目标 Agent CLI。

Codex CLI最低支持版本为`0.144.4`。AgentLink对已验证版本直接启动；对更高的未验证版本会先
调用Codex自带的schema生成命令检查所需App Server稳定接口，兼容时允许启动，不要求固定在
`0.144.x`。检查不会创建或修改Codex Session，且不会自动启用实验API。

```bash
npm install -g @sf7277/agentlink
agentlink doctor
```

当前 npm 版本为 [0.1.32](https://www.npmjs.com/package/@sf7277/agentlink)。

安装时，`better-sqlite3` 会匹配当前 Node ABI；若没有可用预编译模块，npm 会在本机编译。因此可能需要 Xcode Command Line Tools、Python 和可用编译环境。安装过程还会为当前 macOS 架构编译 Keychain 与二维码辅助程序。

Windows npm 安装只支持 x64；安装过程跳过 macOS 原生辅助程序，凭证使用当前用户 Windows Credential Manager，控制通道使用当前用户 Named Pipe。若 `better-sqlite3` 预编译包下载失败，npm 会尝试本机编译，可能需要 Visual Studio Desktop development with C++、Python 和可用的网络连接。

Windows 使用 `npm.cmd` 和 `.cmd` 入口以避免 PowerShell 脚本执行策略影响：

```powershell
npm.cmd install -g @sf7277/agentlink --no-audit --no-fund
agentlink.cmd doctor
```

### 配置与运行

安装完成后，先检查环境并查看可用命令：

```bash
agentlink doctor
agentlink --help
```

先配置本机已登录的 Agent，并登记允许移动端访问的项目目录：

```bash
agentlink agent configure codex --command /absolute/path/to/codex
# 配置 Grok 时：agentlink agent configure grok --command /absolute/path/to/grok

agentlink project add \
  --slug my-project \
  --path /absolute/path/to/my-project \
  --agent codex \
  --default-agent codex

agentlink pair wechat
```

Grok TUI 与 AgentLink 使用独立登录态；配置 Grok 后需对 AgentLink 的 `GROK_HOME` 单独执行一次
`grok login`。完整命令与恢复说明见[运维手册](OPERATIONS.md)。

项目目录只能通过本机可信 CLI 登记；移动端不能提交任意本机路径。`agentlink pair wechat` 会显示一次性二维码，使用微信扫码完成配对。

配置完成后启动 Gateway。前台运行适合调试：

```bash
agentlink-gateway
```

如需在当前登录期间作为普通后台进程运行，可使用：

```bash
agentlink-gateway > ~/Library/Logs/agentlink-gateway.log 2>&1 &
```

这不是 macOS 服务安装：退出登录或重启后不会自动恢复，日志也不受 AgentLink 服务的轮转管理。未来的 DMG/PKG 发行包会提供受控的 LaunchAgent 后台安装。

Windows 前台运行：

```powershell
agentlink-gateway.cmd
```

Windows 前台 Gateway 不注册后台服务，必须保持该窗口开启；退出请按 `Ctrl+C`。在 Gateway 已运行后执行
`agentlink agent configure` 或 `agentlink agent remove`，需要按命令输出提示重启前台 Gateway，Agent 配置不会自动热加载。

完整的配置、日常运维、备份和故障诊断说明见 [运维手册](OPERATIONS.md)。

## 移动端会话

在已配对的微信对话中，可从以下命令开始：

```text
/projects
/new <项目名或序号>
/sessions
/use <序号或 s-短ID>
```

常用命令包括 `/status`、`/stop`、`/queue`、`/approve`、`/deny`、`/close` 与 `/delete`。既有 Codex 会话可通过 `/imports` 和 `/import` 显式导入；Grok 既有会话暂不支持导入。

## 许可证

本项目采用 PolyForm Noncommercial 1.0.0：允许非商业的个人学习、研究、实验、修改和分发；不允许商业用途。该许可证属于 source-available，**不是** OSI 意义的开源许可证。

第三方依赖仍分别适用其原有许可证；完整许可证、第三方声明与贡献规则随 npm 包一同提供。
