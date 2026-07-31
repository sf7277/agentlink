# AgentLink 安全概览

AgentLink 处理来自移动渠道的不可信输入，并控制具备本机文件与命令能力的 Coding Agent。安全边界包括：

- 仅允许已授权发送者、项目和 Agent；
- 移动端不能指定任意工作目录，项目必须来自 Project Registry；
- 同一会话的输入与控制操作由 Gateway 线性化；
- 原生审批绑定会话、Turn、请求摘要与过期时间；
- Gateway 审批不替代 Agent 的原生 sandbox 和 permission；
- 凭证不写入仓库，macOS 使用系统 Keychain；
- 管理接口仅通过本机 IPC 或受限本机入口提供，不向公网暴露 Agent 进程；
- 日志与诊断输出应限制大小并脱敏敏感字段。

使用者仍须在可信主机上维护 Agent 本机配置、项目权限与账户安全。安全问题请勿在公开 issue 中
披露可利用细节；应通过维护者指定的私下渠道报告。
