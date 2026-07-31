# AgentLink 运维手册

适用于通过 npm 安装的 macOS 个人实验/学习环境。

> AgentLink 不是腾讯、微信、OpenAI 或 xAI 发布、认证或支持的产品。使用者自行承担平台帐号限制、服务中断、兼容性及本机 Agent 执行风险。

## 1. 前置条件

- macOS（Apple Silicon 或 Intel）。
- Node.js 22 或更高版本。
- 已安装并登录至少一个目标 Agent CLI：Codex CLI 或 Grok CLI。
- 一个由当前用户拥有的本地项目目录。
- 经用户授权、用于个人实验的微信 iLink 账号。

安装 AgentLink：

```bash
npm install -g @sf7277/agentlink
agentlink doctor
```

`better-sqlite3` 会按当前 Node ABI 安装或编译原生模块。安装失败时，先确认 Node 版本、Xcode Command Line Tools、Python 和本机编译环境。

## 2. 首次配置

先配置 Agent 的绝对可执行路径：

```bash
agentlink agent configure codex --command /absolute/path/to/codex
# 或：agentlink agent configure grok --command /absolute/path/to/grok

agentlink agent list
agentlink agent capabilities codex
```

### Grok 独立登录

Grok TUI 与 AgentLink 使用两条独立的 OAuth refresh 链，必须各自登录一次。不要将两处的
`auth.json` 软链接、复制或互相覆盖，也不要为了修复 AgentLink 对默认 TUI 执行 `grok logout`。

AgentLink Grok 尚未登录或认证失效时，在本机执行：

```bash
export GROK_HOME="$HOME/Library/Application Support/AgentLink/grok-runtime/grok-home"
grok login
# 无浏览器交互时可使用：grok login --device-auth
```

这只写入 AgentLink 的私有 `GROK_HOME`；交互 TUI 继续使用默认 `~/.grok`。Gateway 重启、安装
或升级不会再读取、链接或覆盖 TUI 凭证。

再登记允许移动端访问的项目。项目路径只能由本机 CLI 登记，移动端不能提交任意本机路径：

```bash
agentlink project add \
  --slug my-project \
  --path /absolute/path/to/my-project \
  --agent codex \
  --default-agent codex

agentlink project list
```

可使用 `agentlink project update` 更新项目；`disable`/`enable` 临时撤销或恢复执行权限；`remove` 不会删除项目目录。

最后执行微信配对：

```bash
agentlink pair wechat
```

该命令显示一次性二维码。扫码成功后，凭证仅存入 macOS Keychain；配置和 SQLite 不保存微信 token。解除本机配对可执行：

```bash
agentlink disconnect wechat
```

## 3. 启动 Gateway

开发或排障时，在前台运行：

```bash
agentlink-gateway
```

如需在当前登录期间作为普通后台进程运行：

```bash
agentlink-gateway > ~/Library/Logs/agentlink-gateway.log 2>&1 &
```

后一种方式不是受管 macOS 服务：退出登录或重启后不会自动恢复，且该日志不由 AgentLink 自动轮转。若需停止该后台进程，请使用启动它的 shell job/PID；不要在不确定目标的情况下按名称批量结束进程。

当前 npm 包不包含完整的 macOS release 目录，因此不能直接使用 `agentlink service install --release ...`。该命令留给未来带内置 Node runtime 的 DMG/PKG 发行包。

## 4. 微信端基本使用

在已配对的微信对话中，按以下顺序开始：

```text
/projects
/new <项目名或序号>
/sessions
/use <序号或 s-短ID>
```

普通文本会提交到当前绑定的 Session。常用命令：

| 命令 | 用途 |
|---|---|
| `/projects` | 列出已登记项目 |
| `/new <项目>` | 创建并绑定新会话；可显式指定 `codex` 或 `grok` |
| `/sessions` | 列出 AgentLink 会话 |
| `/use <序号或 s-短ID>` | 选择并绑定会话 |
| `/imports <项目> [数量或 all]` | 列出可导入的既有 Codex 会话 |
| `/import <序号>` | 导入最近一次列表中的 Codex 会话 |
| `/status`、`/recap` | 查看会话状态与最后结果摘要 |
| `/stop`、`/queue`、`/queue resume` | 中断或管理当前队列 |
| `/approve`、`/deny`、`/cancel` | 处理唯一待审批项；多个审批先使用 `/approvals` |
| `/close` | 关闭当前会话 |
| `/delete <序号或 s-短ID>` | 请求永久删除 AgentLink 创建的会话；按提示二次确认 |

既有 Codex 会话可显式导入；Grok 既有会话目前不支持导入。模糊文字如“可以”“继续”不会被解释为审批决定。

## 5. 日常检查与诊断

```bash
agentlink doctor
agentlink channel status wechat
agentlink agent status codex
```

若使用普通后台启动方式，查看其日志：

```bash
tail -n 200 ~/Library/Logs/agentlink-gateway.log
```

不要把配置文件、SQLite 数据库、Keychain 输出、二维码、token、cookie 或原始渠道响应粘贴到 Issue 或公开聊天记录。

## 6. 本地数据与备份

AgentLink 的配置、数据库和运行状态位于当前用户的 `~/Library/Application Support/AgentLink/`；微信凭证保存在 macOS Keychain。

备份或恢复前，应先停止 Gateway，避免在运行时复制 SQLite 文件。受管服务发行包可使用：

```bash
agentlink service backup --output /safe/path/agentlink.sqlite
agentlink service restore --input /safe/path/agentlink.sqlite --confirm-local
```

恢复前必须确认 Gateway 未运行。默认卸载保留本地数据；`service purge` 是破坏性操作，需要明确的双重确认，不应作为日常清理手段。

## 7. 升级

```bash
npm install -g @sf7277/agentlink@latest
agentlink doctor
```

升级 npm 包前先停止正在运行的 Gateway，升级完成后重新启动。发布版本与兼容性说明以 npm 包页面和本手册为准。
