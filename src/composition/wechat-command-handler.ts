import { parseCommand } from "../core/application/command-router.js";
import { DomainError } from "../core/domain/errors.js";
import { summarizeText } from "../core/application/mobile-text.js";

export interface WechatCommandOperations {
  projects(): Promise<readonly {
    number: number;
    slug: string;
    allowedAgents: readonly string[];
  }[]>;
  create(agent: string | undefined, project: string): Promise<{ id: string; displayName: string }>;
  /** Allowed agent kinds for the Gateway (e.g. codex, grok). */
  supportedAgents?(): readonly string[];
  imports(agent: string | undefined, project: string, limit: number | "all"): Promise<readonly {
    number: number;
    displayName: string;
    relativeTime: string;
    archived: boolean;
  }[]>;
  importSession(reference: string): Promise<{ id: string; displayName: string }>;
  sessions(): Promise<readonly {
    number: number;
    id: string;
    displayName: string;
    state: string;
    project: string;
    agent?: string;
    nativeLifecycleOwner: "AGENTLINK" | "EXTERNAL";
    active: boolean;
    relativeTime: string;
  }[]>;
  use(sessionId: string): Promise<string>;
  attach(sessionId: string): Promise<string>;
  resume(sessionId: string): Promise<string>;
  requestDelete(sessionId: string): Promise<string>;
  confirmDelete(sessionId?: string): Promise<string>;
  status(): Promise<string>;
  recap(): Promise<string>;
  input(text: string): Promise<{ state: string; text: string } | undefined>;
  steer(text: string): Promise<void>;
  queue(): Promise<readonly {
    number?: number;
    stateLabel: string;
    summary: string;
  }[]>;
  cancelQueued(turnReference?: string): Promise<string>;
  resumeQueue(): Promise<void>;
  approvals(): Promise<string>;
  resolveApproval(
    leaseReference: string | undefined,
    decision: "allow_once" | "deny" | "cancel"
  ): Promise<string>;
  stop(): Promise<string>;
  close(): Promise<string>;
}

export class WechatCommandHandler {
  public constructor(private readonly operations: WechatCommandOperations) {}

  public async handle(text: string): Promise<string | undefined> {
    const command = parseCommand(text);
    switch (command.kind) {
      case "help":
        return mobileHelp();
      case "projects": {
        const projects = await this.operations.projects();
        return projects.length === 0
          ? "暂无已注册项目"
          : projects.map((item) =>
            `${item.number}. ${item.slug} · ${item.allowedAgents.join(", ")}`
          ).join("\n");
      }
      case "new": {
        const supported = this.operations.supportedAgents?.() ?? ["codex"];
        if (command.agent !== undefined && !supported.includes(command.agent)) {
          throw new DomainError(
            "agent_unsupported",
            `不支持的 Agent：${command.agent}（可用：${supported.join(", ")}）`
          );
        }
        const session = await this.operations.create(command.agent, command.project);
        return `已创建并绑定：${session.displayName}（${session.id}）`;
      }
      case "imports": {
        const candidates = await this.operations.imports(
          command.agent,
          command.project,
          command.limit
        );
        return candidates.length === 0
          ? "该项目暂无可导入的既有会话"
          : [
              ...candidates.map((item) =>
                `${item.number}. ${summarizeText(item.displayName, 32)} · ` +
                `${item.relativeTime}${item.archived ? " · 已归档" : ""}`
              ),
              "导入：/import <序号>"
            ].join("\n");
      }
      case "import_session": {
        const session = await this.operations.importSession(command.reference);
        return `已导入并绑定：${session.displayName}（${session.id}）`;
      }
      case "sessions": {
        const sessions = await this.operations.sessions();
        return sessions.length === 0
          ? "暂无 Session"
          : sessions.map((item) =>
            `${item.number}. ${item.active ? "* " : ""}${summarizeText(item.displayName, 32)} · ` +
            `${item.state} · ${item.agent ?? "?"} · ` +
            `${item.nativeLifecycleOwner === "EXTERNAL" ? "ORG" : "AGL"} · ` +
            `${item.project} · ${item.relativeTime}(${item.id})`
          ).join("\n");
      }
      case "use":
        return this.operations.use(command.sessionId);
      case "attach":
        return this.operations.attach(command.sessionId);
      case "resume":
        return this.operations.resume(command.sessionId);
      case "delete":
        return this.operations.requestDelete(command.sessionId);
      case "delete_confirm":
        return this.operations.confirmDelete(command.sessionId);
      case "status":
        return this.operations.status();
      case "recap":
        return this.operations.recap();
      case "input":
      case "continue": {
        const result = await this.operations.input(command.text);
        if (result === undefined) return undefined;
        if (result.state === "QUEUED") return `已加入等待队列：${result.text}`;
        if (result.state === "PAUSED") return `队列已暂停：${result.text}`;
        if (result.state === "UNKNOWN") return "提交状态未知，请使用 /status 核实";
        return undefined;
      }
      case "steer":
        await this.operations.steer(command.text);
        return "已向当前 Turn 追加约束";
      case "queue": {
        const turns = await this.operations.queue();
        return turns.length === 0
          ? "队列为空"
          : [
              ...turns.map((turn) =>
                `${turn.number === undefined ? "" : `${turn.number}. `}` +
                `${turn.stateLabel} · ${turn.summary}`
              ),
              ...(turns.some((turn) => turn.number !== undefined)
                ? ["取消：/queue cancel <序号>"]
                : [])
            ].join("\n");
      }
      case "queue_cancel":
        return this.operations.cancelQueued(command.turnId);
      case "queue_resume":
        await this.operations.resumeQueue();
        return "队列已显式恢复";
      case "approvals":
        return this.operations.approvals();
      case "approval":
        return this.operations.resolveApproval(command.leaseId, command.decision);
      case "stop":
        return this.operations.stop();
      case "close":
        return this.operations.close();
    }
  }
}

function mobileHelp(): string {
  return [
    "AgentLink 帮助",
    "",
    "会话",
    "/projects                 查看可访问项目",
    "/new [codex|grok|claude] <项目> 创建并绑定新会话",
    "/sessions                 查看会话",
    "/use <序号或 s-短ID>      切换会话",
    "/status · /recap          查看状态或摘要",
    "",
    "对话与控制",
    "直接发送文字              向当前会话发送任务",
    "/continue <内容>          继续对话",
    "/queue                    查看队列",
    "/queue resume|cancel [...] 恢复或取消队列项",
    "/stop                     停止当前任务",
    "/close                    关闭会话（Agent 支持时）",
    "/delete <会话>            请求永久删除，随后按提示确认",
    "",
    "审批",
    "/approvals                查看待审批项",
    "/approve [编号]           单次允许",
    "/deny [编号]              拒绝",
    "/cancel [编号]            取消审批/等待",
    "",
    "导入",
    "/imports [agent] <项目>   列出可导入的既有会话（Codex、Claude）",
    "/import <编号>            导入已列出的会话",
    "",
    "提示：Grok 不支持导入既有会话、/steer 和 /close；",
    "Claude 不支持 /steer 和 /close，只读命令由 Claude 自身放行、不弹审批；",
    "不支持的命令会返回明确提示，不会伪造成功。"
  ].join("\n");
}
