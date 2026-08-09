import type {
  AgentPort,
  ChannelMessage,
  ChannelPort,
  Clock,
  ExternalAgentSessionCandidate,
  IdGenerator,
  LocalControlEvent
} from "../core/contracts/ports.js";
import type { AgentApprovalRequest, AgentSession, Turn } from "../core/domain/model.js";
import { createHash } from "node:crypto";
import { DomainError } from "../core/domain/errors.js";
import { isTerminalTurn } from "../core/domain/transitions.js";
import { ApprovalBroker } from "../core/application/approval-broker.js";
import { IdentityService } from "../core/application/identity-service.js";
import {
  formatRelativeTime,
  sanitizeDisplayName,
  summarizeText
} from "../core/application/mobile-text.js";
import { MobileAttachmentService } from "../core/application/mobile-attachment-service.js";
import { ProjectRegistry } from "../core/application/project-registry.js";
import { renderRecap } from "../core/application/recap.js";
import { RuntimeFailureService } from "../core/application/runtime-failure-service.js";
import { SessionLinearizer } from "../core/application/session-linearizer.js";
import { SessionService } from "../core/application/session-service.js";
import {
  TurnQueue,
  type RecoveredQueueDisposition
} from "../core/application/turn-queue.js";
import {
  renderApprovalListItem,
  renderApprovalRequest
} from "../channel-wechat/rendering/text-renderer.js";
import { ControlRepository } from "../storage-sqlite/control-repository.js";
import { ProjectRepository } from "../storage-sqlite/project-repository.js";
import { SqliteStateStore } from "../storage-sqlite/sqlite-state-store.js";
import { WechatCommandHandler, type WechatCommandOperations } from "./wechat-command-handler.js";

const SELECTOR_TTL_MS = 10 * 60_000;
const UNKNOWN_RECOVERY_WINDOW_MS = 5 * 60_000;
const UNKNOWN_RECOVERY_POLL_MS = 15_000;

interface SelectorSnapshot {
  readonly ids: readonly string[];
  readonly createdAt: string;
}

interface ImportSnapshot {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly agentKind: string;
  readonly candidates: readonly ExternalAgentSessionCandidate[];
  readonly limit: number | "all";
  readonly createdAt: string;
}

interface UnknownRecoveryWatcher {
  readonly conversationId: string;
  readonly platformConversationId: string;
  readonly endpointId: string;
}

interface DeleteConfirmation {
  readonly sessionId: string;
  readonly displayId: string;
  readonly nativeSessionId: string;
  readonly sessionUpdatedAt: string;
  readonly endpointId: string;
  readonly createdAt: string;
}

interface UnknownRecovery {
  readonly sessionId: string;
  readonly deadlineAt: number;
  readonly watchers: Map<string, UnknownRecoveryWatcher>;
  timer?: NodeJS.Timeout;
  running: boolean;
}

export interface GatewayApplicationOptions {
  readonly accountId: string;
  readonly identities: readonly {
    accountId: string;
    senderId: string;
    gatewayUserId: string;
  }[];
  readonly approvalLeaseMs: number;
  readonly queueLimit: number;
  readonly supportedAgents?: readonly string[];
  readonly unknownRecoveryWindowMs?: number;
  readonly unknownRecoveryPollMs?: number;
  readonly restartAgentRuntime?: (agentKind: string) => Promise<void>;
  readonly deleteNativeSession?: (session: AgentSession) => Promise<void>;
  readonly publishLocal: (
    sessionId: string,
    payload: Readonly<Record<string, unknown>>
  ) => void;
  readonly onDiagnostic: (kind: string, error: Error) => void;
}

export class GatewayApplication {
  readonly #linearizer = new SessionLinearizer();
  readonly #attachments: MobileAttachmentService;
  readonly #sessions: SessionService;
  readonly #queue: TurnQueue;
  readonly #approvals: ApprovalBroker;
  readonly #runtimeFailure: RuntimeFailureService;
  #identity: IdentityService;
  readonly #controllerBySession = new Map<string, string>();
  readonly #sessionSnapshots = new Map<string, SelectorSnapshot>();
  readonly #projectSnapshots = new Map<string, SelectorSnapshot>();
  readonly #importSnapshots = new Map<string, ImportSnapshot>();
  readonly #localImportSnapshots = new Map<string, ImportSnapshot>();
  readonly #queueSnapshots = new Map<string, SelectorSnapshot>();
  readonly #approvalSnapshots = new Map<string, SelectorSnapshot>();
  readonly #deleteConfirmations = new Map<string, DeleteConfirmation>();
  readonly #unknownRecoveries = new Map<string, UnknownRecovery>();
  #nativeReconciliation: Promise<void> | undefined;

  public constructor(
    private readonly store: SqliteStateStore,
    private readonly control: ControlRepository,
    private readonly projects: ProjectRepository,
    private readonly registry: ProjectRegistry,
    private channel: ChannelPort,
    private readonly agent: AgentPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: GatewayApplicationOptions
  ) {
    this.#attachments = new MobileAttachmentService(store, clock);
    this.#sessions = new SessionService(store, agent, clock, ids, this.#linearizer);
    this.#queue = new TurnQueue(
      store,
      agent,
      clock,
      ids,
      this.#linearizer,
      options.queueLimit,
      this.#attachments
    );
    this.#approvals = new ApprovalBroker(
      agent,
      control,
      clock,
      ids,
      this.#linearizer,
      this.#attachments
    );
    this.#runtimeFailure = new RuntimeFailureService(store, clock, this.#linearizer);
    this.#identity = new IdentityService(options.identities);
  }

  /**
   * Swap the outbound channel and controller identities after startup.
   * Used by the Windows foreground Gateway to attach a freshly paired WeChat
   * channel without restarting, mirroring the macOS service-restart flow.
   */
  public attachChannel(
    channel: ChannelPort,
    identities: readonly {
      accountId: string;
      senderId: string;
      gatewayUserId: string;
    }[]
  ): void {
    this.channel = channel;
    this.#identity = new IdentityService(identities);
  }

  public async handleChannelMessage(message: ChannelMessage): Promise<void> {
    let endpointId: string;
    try {
      const identity = this.#identity.authorize(message.accountId, message.senderId);
      endpointId = `wechat:${identity.gatewayUserId}`;
    } catch (error) {
      this.options.onDiagnostic("channel_identity_rejected", asError(error));
      return;
    }
    const normalizedText = (message.text ?? "").trim();
    const atomicTurnReceipt =
      !normalizedText.startsWith("/") || /^\/continue\s+/u.test(normalizedText);
    if (
      !atomicTurnReceipt &&
      !this.control.acceptMessageReceipt(message.accountId, message.messageId, message.receivedAt)
    ) {
      return;
    }
    const conversationId = conversationKey(message.accountId, message.conversationId);
    const operations = this.operations(conversationId, message.conversationId, endpointId, atomicTurnReceipt
      ? {
          accountId: message.accountId,
          messageId: message.messageId,
          receivedAt: message.receivedAt
        }
      : undefined);
    try {
      await this.reconcileNativeSessions();
      const response = await new WechatCommandHandler(operations).handle(message.text ?? "");
      if (response !== undefined) {
        await this.channel.send({
          conversationId: message.conversationId,
          text: response,
          replyTo: message.messageId
        });
      }
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "session_status_unknown")) {
        this.options.onDiagnostic("channel_command_failed", asError(error));
      }
      await this.channel.send({
        conversationId: message.conversationId,
        text: error instanceof DomainError
          ? error.code === "session_status_unknown" || error.code === "session_not_bound"
            ? error.message
            : `请求失败：${error.message}`
          : "请求失败，请在本机查看诊断日志",
        replyTo: message.messageId
      }).catch((sendError: unknown) => {
        this.options.onDiagnostic("channel_error_reply_failed", asError(sendError));
      });
    }
  }

  public async handleLocalEvent(event: LocalControlEvent): Promise<unknown> {
    try {
      await this.reconcileNativeSessions();
      if (event.kind === "session_discover") {
        const unresolved = await this.registry.resolve(event.project);
        const selectedAgent = event.agent ?? unresolved.defaultAgent;
        const project = await this.registry.resolve(event.project, selectedAgent);
        this.assertExternalImportSupported(selectedAgent);
        const candidates = (await this.#sessions.discoverExternal(project.id, selectedAgent))
          .filter((candidate) =>
            !this.importedNativeSessionIds(selectedAgent).has(candidate.nativeSessionId));
        this.#localImportSnapshots.set(event.endpointId, {
          projectId: project.id,
          projectSlug: project.slug,
          agentKind: selectedAgent,
          candidates,
          limit: "all",
          createdAt: this.clock.now()
        });
        return candidates.map((candidate, index) => ({
          number: index + 1,
          displayName: candidate.displayName,
          relativeTime: formatRelativeTime(candidate.lastActivityAt, this.clock.now()),
          archived: candidate.archived
        }));
      }
      if (event.kind === "session_import") {
        const snapshot = this.requireLocalImportSnapshot(
          event.endpointId,
          event.project,
          event.agent
        );
        const project = await this.registry.resolve(snapshot.projectSlug, snapshot.agentKind);
        const current = (await this.#sessions.discoverExternal(project.id, snapshot.agentKind))
          .filter((candidate) =>
            !this.importedNativeSessionIds(snapshot.agentKind).has(candidate.nativeSessionId));
        if (!sameIds(
          snapshot.candidates.map((candidate) => candidate.nativeSessionId),
          current.map((candidate) => candidate.nativeSessionId)
        )) {
          this.#localImportSnapshots.delete(event.endpointId);
          throw new DomainError(
            "import_snapshot_changed",
            "可导入Session列表已变化，请重新执行session discover"
          );
        }
        const nativeSessionId = this.referenceFromSnapshot(
          {
            ids: snapshot.candidates.map((candidate) => candidate.nativeSessionId),
            createdAt: snapshot.createdAt
          },
          event.reference
        );
        const candidate = snapshot.candidates.find((item) =>
          item.nativeSessionId === nativeSessionId
        );
        if (candidate === undefined) throw new DomainError("import_candidate_missing", "候选不存在");
        const session = await this.importExternalCandidate(
          project.id,
          snapshot.agentKind,
          candidate
        );
        this.#localImportSnapshots.delete(event.endpointId);
        return {
          sessionId: session.id,
          shortId: this.displaySessionIds()[session.id],
          displayName: session.displayName
        };
      }
      if (event.kind === "session_list") {
        const rows = this.allSessions().filter((row) =>
          (event.project === undefined || row.project === event.project) &&
          (event.scope === "all" ||
            (event.scope === "archived" ? row.session.state === "CLOSED" : row.session.state !== "CLOSED"))
        );
        return rows.map(({ session, project }) => this.localSessionView(session, project));
      }
      if (event.kind === "session_show") {
        const row = this.localSession(event.sessionId);
        return this.localSessionView(row.session, row.project);
      }
      if (event.kind === "session_archive") {
        const row = this.localSession(event.sessionId);
        if (row.session.nativeLifecycleOwner !== "AGENTLINK") {
          throw new DomainError(
            "native_session_not_owned",
            "外部导入Session请使用session detach；native thread由Codex管理"
          );
        }
        await this.#queue.close(row.session.id);
        return { status: "archived", sessionId: row.session.id };
      }
      if (event.kind === "session_unarchive") {
        const row = this.localSession(event.sessionId);
        if (row.session.nativeLifecycleOwner !== "AGENTLINK") {
          throw new DomainError("native_session_not_owned", "外部导入Session不能由AgentLink解除归档");
        }
        const storedProject = this.projects.findById(row.session.projectId);
        if (storedProject === undefined || !storedProject.enabled) {
          throw new DomainError("project_not_registered", "Session所属Project未启用");
        }
        await this.registry.resolve(storedProject.slug, row.session.agentKind);
        const session = await this.#sessions.resume(row.session.id);
        return this.localSessionView(session, row.project);
      }
      if (event.kind === "session_delete") {
        await this.deleteOwnedSession(event.sessionId);
        return { status: "deleted", sessionId: event.sessionId };
      }
      if (event.kind === "session_detach") {
        const session = await this.#sessions.detachExternal(event.sessionId);
        const row = this.localSession(session.id);
        return this.localSessionView(session, row.project);
      }
      if (event.kind === "project_disable") {
        const project = this.projects.findBySlug(event.project);
        if (project === undefined) throw new DomainError("project_not_registered", "Project不存在");
        this.registry.unregister(project.slug);
        this.projects.put({ ...project, enabled: false });
        return { status: "disabled", project: project.slug };
      }
      if (event.kind === "project_enable") {
        const project = this.projects.findBySlug(event.project);
        if (project === undefined) throw new DomainError("project_not_registered", "Project不存在");
        const registered = await this.registry.register({
          id: project.id,
          slug: project.slug,
          path: project.canonicalPath,
          allowedAgents: project.allowedAgents,
          defaultAgent: project.defaultAgent
        });
        this.projects.put({
          ...project,
          canonicalPath: registered.canonicalPath,
          allowedAgents: registered.allowedAgents,
          defaultAgent: registered.defaultAgent,
          enabled: true
        });
        return { status: "enabled", project: project.slug };
      }
      if (event.kind === "project_remove") {
        const project = this.projects.findBySlug(event.project);
        if (project === undefined) throw new DomainError("project_not_registered", "Project不存在");
        const sessions = this.allSessions().filter((row) => row.session.projectId === project.id);
        if (sessions.length > 0) {
          throw new DomainError(
            "project_has_sessions",
            "Project仍有关联Session，请先逐一删除AgentLink-owned Session或detach外部Session"
          );
        }
        this.registry.unregister(project.slug);
        this.projects.put({ ...project, enabled: false });
        return { status: "removed", project: project.slug };
      }
      if (event.kind === "input") {
        this.assertLocalSessionProjectEnabled(event.sessionId);
        if (
          event.endpointId.startsWith("local-") &&
          this.agent.capabilities(event.sessionId).approvals &&
          !this.#controllerBySession.has(event.sessionId)
        ) {
          throw new DomainError(
            "local_approval_handoff_unavailable",
            "本机attach无法接收原生审批；请先从移动端绑定该Session后再提交"
          );
        }
        const turn = await this.#queue.enqueue(event.sessionId, event.endpointId, event.text);
        this.options.publishLocal(event.sessionId, {
          event: "turn_submitted",
          turnId: turn.id,
          state: turn.state
        });
      } else if (event.kind === "steer") {
        this.assertLocalSessionProjectEnabled(event.sessionId);
        await this.#queue.steer(event.sessionId, event.endpointId, event.text);
      } else if (event.kind === "stop") {
        await this.#queue.stop(event.sessionId);
      } else if (event.kind === "close") {
        await this.#queue.close(event.sessionId);
      } else {
        throw new DomainError("local_control_unsupported", "不支持的本地控制事件");
      }
      return undefined;
    } catch (error) {
      if ("sessionId" in event) {
        this.options.publishLocal(event.sessionId, {
          event: "request_failed",
          code: error instanceof DomainError ? error.code : "internal_error"
        });
      }
      throw error;
    }
  }

  public turnCompleted(
    sessionId: string,
    turnId: string,
    status: "completed" | "interrupted" | "failed",
    finalResponse?: string
  ): void {
    void (async () => {
      const approvalDecision = this.#approvals.consumeDispatchedDecision(turnId);
      const explicitlyDenied = status === "interrupted" && approvalDecision === "deny";
      const explicitlyCancelled = status === "interrupted" && approvalDecision === "cancel";
      const wasAlreadyResolved = this.store.transaction((transaction) => {
        const turn = transaction.getTurn(turnId);
        return turn === undefined || isTerminalTurn(turn.state);
      });
      if (status === "completed") await this.#queue.complete(turnId, finalResponse ?? "");
      else if (explicitlyDenied) await this.#queue.completeDeniedApproval(turnId);
      else if (explicitlyCancelled) await this.#queue.completeExplicitCancellation(turnId);
      else await this.#queue.fail(turnId, status === "interrupted" ? "CANCELLED" : "FAILED");
      this.options.publishLocal(sessionId, {
        event: "turn_completed",
        turnId,
        status,
        ...(finalResponse === undefined ? {} : { text: finalResponse })
      });
      const conversationId = this.control.platformConversationForSession(sessionId);
      if (
        conversationId !== undefined &&
        !wasAlreadyResolved &&
        !explicitlyDenied &&
        !explicitlyCancelled
      ) {
        const turn = this.store.transaction((transaction) => transaction.getTurn(turnId));
        const fallback = `${terminalStatusLabel(status)} · ${summarizeText(turn?.text ?? "")}`;
        const completionText =
          status === "completed" && finalResponse !== undefined && finalResponse.trim() !== ""
            ? finalResponse
            : terminalStatusLabel(status);
        await this.channel.send({
          conversationId,
          // An Adapter can return a short, sanitized, actionable failure
          // explanation (for example an expired Claude authentication). Do
          // not discard it merely because the Turn state is FAILED. Interrupted
          // turns can instead carry buffered partial model text, so their
          // lifecycle status must remain the user-visible result.
          text: status === "completed" ? completionText : status === "failed" ? finalResponse ?? fallback : fallback
        });
      }
    })().catch((error: unknown) => this.options.onDiagnostic("turn_completion_failed", asError(error)));
  }

  public turnStarted(_sessionId: string, turnId: string, nativeTurnId: string): void {
    void this.#queue.started(turnId, nativeTurnId).catch((error: unknown) =>
      this.options.onDiagnostic("turn_started_failed", asError(error))
    );
  }

  public approvalRequested(request: AgentApprovalRequest): void {
    void (async () => {
      await this.#queue.waitForApproval(request.turnId);
      const controller = this.#controllerBySession.get(request.sessionId);
      const conversationId = this.control.platformConversationForSession(request.sessionId);
      if (controller === undefined || conversationId === undefined) {
        throw new Error("Approval has no attached mobile controller");
      }
      const lease = this.#approvals.observe(request, controller, this.options.approvalLeaseMs);
      const expiryDelay = Math.max(1, Date.parse(lease.expiresAt) - Date.now() + 25);
      const expiryTimer = setTimeout(() => {
        void this.#approvals.expireLeases().catch((error: unknown) =>
          this.options.onDiagnostic("approval_expiry_failed", asError(error))
        );
      }, expiryDelay);
      expiryTimer.unref();
      const session = this.store.transaction((transaction) =>
        transaction.getSession(request.sessionId)
      );
      if (session === undefined) throw new Error("Approval Session no longer exists");
      const project = this.projects.findById(session.projectId);
      if (project === undefined) throw new Error("Approval Project no longer exists");
      const active = this.#approvals.activeForController(controller);
      await this.channel.send({
        conversationId,
        text: renderApprovalRequest(request, lease, {
          sessionName: session.displayName,
          project: project.slug,
          now: this.clock.now(),
          multiple: active.length > 1
        })
      });
    })().catch((error: unknown) =>
      this.options.onDiagnostic("approval_route_failed", asError(error))
    );
  }

  public approvalResolved(_sessionId: string, turnId: string): void {
    this.#approvals.discardDispatchedDecision(turnId);
    void this.#queue.approvalResolved(turnId).catch((error: unknown) =>
      this.options.onDiagnostic("approval_state_reconciliation_failed", asError(error))
    );
  }

  public threadNameUpdated(sessionId: string, displayName: string): void {
    this.store.transaction((transaction) => {
      const session = transaction.getSession(sessionId);
      if (session === undefined) return;
      transaction.putSession({
        ...session,
        displayName: sanitizeDisplayName(displayName, session.displayName),
        updatedAt: this.clock.now()
      });
    });
  }

  public async runtimeExited(
    affectedSessionIds: readonly string[],
    error: Error
  ): Promise<void> {
    try {
      await Promise.all([
      this.#runtimeFailure.handleExit({
        runtimeId: "codex-shared",
        alive: false,
        affectedSessionIds
      }),
      this.#approvals.invalidateSessions(affectedSessionIds)
      ]);
    } catch (failure) {
      this.options.onDiagnostic("runtime_reconciliation_failed", asError(failure))
    }
    this.options.onDiagnostic("codex_runtime_exited", error);
  }

  private operations(
    conversationId: string,
    platformConversationId: string,
    endpointId: string,
    channelReceipt?: import("../core/application/turn-queue.js").ChannelMessageReceipt
  ): WechatCommandOperations {
    const activeSession = (): AgentSession => {
      const sessionId = this.control.activeSessionFor(conversationId);
      const session = sessionId === undefined
        ? undefined
        : this.store.transaction((transaction) => transaction.getSession(sessionId));
      if (session === undefined) {
        throw new DomainError(
          "session_not_bound",
          "当前未绑定任何Session，请先使用 /sessions，再使用 /use 激活一个会话。"
        );
      }
      this.#controllerBySession.set(session.id, endpointId);
      return session;
    };
    const knownActiveSession = (): AgentSession => {
      const session = activeSession();
      if (
        session.state === "UNKNOWN" ||
        session.state === "CREATING"
      ) {
        throw new DomainError(
          "session_status_unknown",
          "Session状态暂无法核实，请等待或使用其他Session。"
        );
      }
      return session;
    };
    const bind = (sessionId: string): void => {
      this.control.bindConversation(
        conversationId,
        this.options.accountId,
        platformConversationId,
        sessionId,
        this.clock.now()
      );
      this.#controllerBySession.set(sessionId, endpointId);
    };
    const ensureUsable = async (reference: string): Promise<{
      session: AgentSession;
      disposition: RecoveredQueueDisposition;
    }> => {
      let session = this.resolveSessionReference(reference, conversationId);
      if (session === undefined) throw new DomainError("session_not_found", "Session不存在");
      const storedProject = this.projects.findById(session.projectId);
      if (storedProject === undefined) {
        throw new DomainError("project_not_registered", "Session所属Project未注册");
      }
      const authorizedProject = await this.registry.resolve(
        storedProject.slug,
        session.agentKind
      );
      if (authorizedProject.id !== session.projectId) {
        throw new DomainError("project_identity_changed", "Session所属Project身份已变化");
      }
      const needsRecovery = session.state === "UNKNOWN" || session.state === "CLOSED";
      if (needsRecovery) {
        session = await this.#sessions.resume(session.id);
      }
      if (session.state === "UNKNOWN") {
        throw new DomainError(
          "session_status_unknown",
          "Session状态暂无法核实，请等待或使用其他Session。"
        );
      }
      if (session.state !== "OPEN" || session.runtimeState !== "ALIVE") {
        throw new DomainError("session_not_usable", "Session当前无法恢复，请在本机查看诊断");
      }
      bind(session.id);
      this.#attachments.restoreMobileWrite(session.id, endpointId);
      return {
        session,
        disposition: await this.#queue.prepareRecoveredSession(session.id)
      };
    };
    const activeInputSession = async (): Promise<AgentSession> => {
      const active = activeSession();
      if (active.state !== "UNKNOWN" && active.state !== "CLOSED") {
        return knownActiveSession();
      }
      if (active.nativeSessionId === undefined) {
        throw new DomainError(
          "session_status_unknown",
          "Session缺少原生恢复标识，本条消息未提交。"
        );
      }
      if (active.state === "UNKNOWN" && this.#unknownRecoveries.has(active.id)) {
        throw new DomainError(
          "session_status_unknown",
          "Session正在自动核实，本条消息未提交。请等待恢复提示后重发。"
        );
      }
      try {
        return (await ensureUsable(active.id)).session;
      } catch (error) {
        const current = this.store.transaction((transaction) => transaction.getSession(active.id));
        if (
          active.state === "UNKNOWN" &&
          current !== undefined &&
          (current.state === "UNKNOWN" || current.state === "CREATING")
        ) {
          bind(current.id);
          this.startUnknownRecovery({
            sessionId: current.id,
            conversationId,
            platformConversationId,
            endpointId
          });
          throw new DomainError(
            "session_status_unknown",
            "Session正在自动核实，本条消息未提交。请等待恢复提示后重发。"
          );
        }
        throw error;
      }
    };
    return {
      supportedAgents: () => this.options.supportedAgents ?? ["codex"],
      projects: async () => {
        const rows = this.registry.list();
        this.#projectSnapshots.set(conversationId, this.snapshot(rows.map((row) => row.slug)));
        return rows.map((project, index) => ({
          number: index + 1,
          slug: project.slug,
          allowedAgents: project.allowedAgents
        }));
      },
      create: async (agentKind, projectReference) => {
        const slug = this.resolveProjectReference(projectReference, conversationId);
        const unresolved = await this.registry.resolve(slug);
        const selectedAgent = agentKind ?? unresolved.defaultAgent;
        const project = await this.registry.resolve(slug, selectedAgent);
        const fallback = sanitizeDisplayName(`${project.slug} · 新会话`, project.slug);
        const session = await this.#sessions.create(project.id, selectedAgent, fallback);
        bind(session.id);
        this.#attachments.attachInitial(session.id, endpointId);
        return {
          id: this.displaySessionIds()[session.id]!,
          displayName: session.displayName
        };
      },
      imports: async (agentKind, projectReference, limit) => {
        const slug = this.resolveProjectReference(projectReference, conversationId);
        const unresolved = await this.registry.resolve(slug);
        const selectedAgent = agentKind ?? unresolved.defaultAgent;
        const project = await this.registry.resolve(slug, selectedAgent);
        this.assertExternalImportSupported(selectedAgent);
        const discovered = (await this.#sessions.discoverExternal(project.id, selectedAgent))
          .filter((candidate) =>
            !this.importedNativeSessionIds(selectedAgent).has(candidate.nativeSessionId));
        const candidates = limit === "all" ? discovered : discovered.slice(0, limit);
        this.#importSnapshots.set(conversationId, {
          projectId: project.id,
          projectSlug: project.slug,
          agentKind: selectedAgent,
          candidates,
          limit,
          createdAt: this.clock.now()
        });
        return candidates.map((candidate, index) => ({
          number: index + 1,
          displayName: candidate.displayName,
          relativeTime: formatRelativeTime(candidate.lastActivityAt, this.clock.now()),
          archived: candidate.archived
        }));
      },
      importSession: async (reference) => {
        const snapshot = this.requireImportSnapshot(conversationId);
        const project = await this.registry.resolve(snapshot.projectSlug, snapshot.agentKind);
        if (project.id !== snapshot.projectId) {
          this.#importSnapshots.delete(conversationId);
          throw new DomainError(
            "import_project_changed",
            "Project配置已变化，请重新使用 /imports"
          );
        }
        const discovered = (await this.#sessions.discoverExternal(
          project.id,
          snapshot.agentKind
        ))
          .filter((candidate) =>
            !this.importedNativeSessionIds(snapshot.agentKind).has(candidate.nativeSessionId));
        const current = snapshot.limit === "all"
          ? discovered
          : discovered.slice(0, snapshot.limit);
        if (!sameIds(
          snapshot.candidates.map((candidate) => candidate.nativeSessionId),
          current.map((candidate) => candidate.nativeSessionId)
        )) {
          this.#importSnapshots.delete(conversationId);
          throw new DomainError(
            "import_snapshot_changed",
            "可导入Session列表已变化，请重新使用 /imports"
          );
        }
        const nativeSessionId = this.referenceFromSnapshot(
          { ids: snapshot.candidates.map((candidate) => candidate.nativeSessionId),
            createdAt: snapshot.createdAt },
          reference
        );
        const candidate = snapshot.candidates.find((item) =>
          item.nativeSessionId === nativeSessionId
        );
        if (candidate === undefined) {
          throw new DomainError("import_candidate_missing", "可导入Session不存在");
        }
        const session = await this.importExternalCandidate(
          project.id,
          snapshot.agentKind,
          candidate
        );
        bind(session.id);
        this.#attachments.attachInitial(session.id, endpointId);
        this.#importSnapshots.delete(conversationId);
        return {
          id: this.displaySessionIds()[session.id]!,
          displayName: session.displayName
        };
      },
      sessions: async () => {
        const active = this.control.activeSessionFor(conversationId);
        const now = this.clock.now();
        const rows = this.allSessions().sort((left, right) =>
          right.session.lastActivityAt.localeCompare(left.session.lastActivityAt) ||
          right.session.createdAt.localeCompare(left.session.createdAt) ||
          left.session.id.localeCompare(right.session.id)
        );
        this.#sessionSnapshots.set(
          conversationId,
          this.snapshot(rows.map((row) => row.session.id))
        );
        const displayIds = this.displaySessionIds();
        return rows.map((row, index) => ({
          number: index + 1,
          id: displayIds[row.session.id]!,
          displayName: row.session.displayName,
          state: sessionStateLabel(row.session),
          project: row.project,
          agent: row.session.agentKind,
          nativeLifecycleOwner: row.session.nativeLifecycleOwner,
          active: row.session.id === active,
          relativeTime: formatRelativeTime(row.session.lastActivityAt, now)
        }));
      },
      use: async (reference) => {
        const before = this.resolveSessionReference(reference, conversationId);
        if (before === undefined) throw new DomainError("session_not_found", "Session不存在");
        if (
          (before.state === "UNKNOWN" || before.state === "CLOSED") &&
          before.nativeSessionId === undefined
        ) {
          throw new DomainError(
            "native_session_missing",
            "该Session缺少原生恢复标识，无法恢复"
          );
        }
        let usable: {
          session: AgentSession;
          disposition: RecoveredQueueDisposition;
        };
        try {
          usable = await ensureUsable(reference);
        } catch (error) {
          const current = this.store.transaction((transaction) =>
            transaction.getSession(before.id)
          );
          if (
            (before.state === "UNKNOWN" || this.#unknownRecoveries.has(before.id)) &&
            current !== undefined &&
            (current.state === "UNKNOWN" || current.state === "CREATING")
          ) {
            bind(current.id);
            this.startUnknownRecovery({
              sessionId: current.id,
              conversationId,
              platformConversationId,
              endpointId
            });
            return "Session状态暂无法核实，AgentLink将在5min内自动重试。\n" +
              "期间请等待或使用其他Session。";
          }
          throw error;
        }
        const { session, disposition } = usable;
        if (disposition.kind === "unknown") {
          bind(session.id);
          this.startUnknownRecovery({
            sessionId: session.id,
            conversationId,
            platformConversationId,
            endpointId
          });
          return "Session状态暂无法核实，AgentLink将在5min内自动重试。\n" +
            "期间请等待或使用其他Session。";
        }
        if (disposition.kind === "active") {
          return `已切换，Agent仍在执行：${summarizeText(disposition.turn.text)}\n` +
            "可等待完成或 /stop";
        }
        if (disposition.kind === "paused") {
          return `已切换，但存在${disposition.count}个暂停任务。\n查看：/queue`;
        }
        const verb = before?.state === "OPEN" && before.runtimeState === "ALIVE"
          ? "已切换"
          : "已恢复并切换";
        return `${verb}：${session.displayName}（${this.displaySessionIds()[session.id]}）`;
      },
      attach: async (reference) => {
        const { session } = await ensureUsable(reference);
        return `已连接：${session.displayName}（${this.displaySessionIds()[session.id]}）`;
      },
      resume: async (reference) => {
        const { session } = await ensureUsable(reference);
        return `已恢复并切换：${session.displayName}（${this.displaySessionIds()[session.id]}）`;
      },
      requestDelete: async (reference) => {
        const session = this.resolveSessionReference(reference, conversationId);
        if (session === undefined) throw new DomainError("session_not_found", "Session不存在");
        this.assertSessionDeleteReady(session);
        const displayId = this.displaySessionIds()[session.id]!;
        this.#deleteConfirmations.set(conversationId, {
          sessionId: session.id,
          displayId,
          nativeSessionId: session.nativeSessionId!,
          sessionUpdatedAt: session.updatedAt,
          endpointId,
          createdAt: this.clock.now()
        });
        return `即将永久删除：${session.displayName}（${displayId}）\n` +
          "确认：/delete confirm（5分钟内有效）";
      },
      confirmDelete: async (displayId) => {
        const confirmation = this.#deleteConfirmations.get(conversationId);
        if (
          confirmation === undefined ||
          Date.parse(this.clock.now()) - Date.parse(confirmation.createdAt) > 5 * 60_000
        ) {
          this.#deleteConfirmations.delete(conversationId);
          throw new DomainError("delete_confirmation_missing", "删除确认已失效，请重新执行 /delete");
        }
        if (
          confirmation.endpointId !== endpointId ||
          (displayId !== undefined && confirmation.displayId !== displayId)
        ) {
          throw new DomainError("delete_confirmation_mismatch", "删除确认与原请求不匹配");
        }
        const current = this.store.transaction((transaction) =>
          transaction.getSession(confirmation.sessionId)
        );
        if (
          current === undefined ||
          current.nativeSessionId !== confirmation.nativeSessionId ||
          current.updatedAt !== confirmation.sessionUpdatedAt
        ) {
          this.#deleteConfirmations.delete(conversationId);
          throw new DomainError("delete_target_changed", "Session状态已变化，请重新执行 /delete");
        }
        this.assertSessionDeleteReady(current);
        this.#deleteConfirmations.delete(conversationId);
        await this.deleteOwnedSession(current.id);
        return `已永久删除：${current.displayName}`;
      },
      status: async () => {
        const session = knownActiveSession();
        const turns = this.store.transaction((transaction) => transaction.listTurns(session.id));
        const current = turns.find((turn) =>
          turn.state === "DISPATCHED" ||
          turn.state === "RUNNING" ||
          turn.state === "WAITING_AGENT_APPROVAL"
        );
        return `${session.displayName} · ${session.state}/${session.runtimeState} · ` +
          `${current === undefined ? "空闲" : `${turnStateLabel(current.state)} · ${summarizeText(current.text)}`}`;
      },
      recap: async () => {
        const session = knownActiveSession();
        return renderRecap(
          session,
          this.store.transaction((transaction) => transaction.listTurns(session.id)),
          this.displaySessionIds()[session.id]
        );
      },
      input: async (text) => {
        const session = await activeInputSession();
        this.assertLocalSessionProjectEnabled(session.id);
        const turn = channelReceipt === undefined
          ? await this.#queue.enqueue(session.id, endpointId, text)
          : await this.#queue.enqueueChannelMessage(session.id, endpointId, text, channelReceipt);
        if (turn === undefined) return undefined;
        this.adoptFirstInputName(session.id, text);
        return { state: turn.state, text: summarizeText(turn.text) };
      },
      steer: async (text) => {
        const session = knownActiveSession();
        this.assertLocalSessionProjectEnabled(session.id);
        await this.#queue.steer(session.id, endpointId, text);
      },
      queue: async () => {
        const session = knownActiveSession();
        const turns = this.store.transaction((transaction) => transaction.listTurns(session.id));
        const active = turns.filter((turn) =>
          turn.state === "DISPATCHED" ||
          turn.state === "RUNNING" ||
          turn.state === "WAITING_AGENT_APPROVAL"
        );
        const cancellable = turns
          .filter((turn) => turn.state === "QUEUED" || turn.state === "PAUSED")
          .sort((left, right) => (left.queueSequence ?? 0) - (right.queueSequence ?? 0));
        this.#queueSnapshots.set(
          queueSnapshotKey(conversationId, session.id),
          this.snapshot(cancellable.map((turn) => turn.id))
        );
        return [
          ...active.map((turn) => ({
            stateLabel: turnStateLabel(turn.state),
            summary: summarizeText(turn.text)
          })),
          ...cancellable.map((turn, index) => ({
            number: index + 1,
            stateLabel: turn.state === "PAUSED" ? "暂停" : "等待",
            summary: summarizeText(turn.text)
          }))
        ];
      },
      cancelQueued: async (reference) => {
        const session = knownActiveSession();
        if (reference === undefined) {
          const turn = await this.#queue.cancelOnlyQueued(session.id);
          this.#queueSnapshots.delete(queueSnapshotKey(conversationId, session.id));
          return turn === undefined
            ? "当前没有可取消的队列项"
            : `已取消：${summarizeText(turn.text)}`;
        }
        let turnId = reference;
        if (/^\d+$/u.test(reference)) {
          const key = queueSnapshotKey(conversationId, session.id);
          const snapshot = this.requireSnapshot(
            this.#queueSnapshots,
            key,
            "请先使用 /queue 查看当前队列"
          );
          const currentIds = this.store.transaction((transaction) =>
            transaction.listTurns(session.id)
              .filter((turn) => turn.state === "QUEUED" || turn.state === "PAUSED")
              .sort((left, right) => (left.queueSequence ?? 0) - (right.queueSequence ?? 0))
              .map((turn) => turn.id)
          );
          if (!sameIds(snapshot.ids, currentIds)) {
            this.#queueSnapshots.delete(key);
            throw new DomainError(
              "queue_snapshot_changed",
              "队列已变化，请重新使用 /queue"
            );
          }
          turnId = this.referenceFromSnapshot(snapshot, reference);
        }
        const turn = this.store.transaction((transaction) => transaction.getTurn(turnId));
        const result = await this.#queue.cancelQueued(session.id, turnId);
        this.#queueSnapshots.delete(queueSnapshotKey(conversationId, session.id));
        return result === "cancelled"
          ? `已取消：${summarizeText(turn?.text ?? "")}`
          : "该队列项已处理";
      },
      resumeQueue: async () => {
        const session = knownActiveSession();
        this.assertLocalSessionProjectEnabled(session.id);
        await this.#queue.resumeQueue(session.id);
      },
      approvals: async () => {
        const active = this.#approvals.activeForController(endpointId);
        if (active.length === 0) return "当前没有待审批项";
        this.#approvalSnapshots.set(
          endpointId,
          this.snapshot(active.map((item) => item.lease.id))
        );
        return active.map((item, index) => {
          const session = this.store.transaction((transaction) =>
            transaction.getSession(item.request.sessionId)
          );
          return renderApprovalListItem(
            index + 1,
            item.request,
            item.lease,
            session?.displayName ?? "Session",
            this.clock.now()
          );
        }).join("\n");
      },
      resolveApproval: async (reference, decision) => {
        let leaseId = reference;
        if (reference !== undefined && /^\d+$/u.test(reference)) {
          const activeIds = this.#approvals.activeForController(endpointId)
            .map((item) => item.lease.id);
          const snapshot = this.requireSnapshot(
            this.#approvalSnapshots,
            endpointId,
            "请先使用 /approvals 查看待审批项"
          );
          if (!sameIds(snapshot.ids, activeIds)) {
            this.#approvalSnapshots.delete(endpointId);
            throw new DomainError(
              "approval_snapshot_changed",
              "待审批列表已变化，请重新使用 /approvals"
            );
          }
          leaseId = this.referenceFromSnapshot(snapshot, reference);
        }
        const resolved = await this.#approvals.resolveForController({
          ...(leaseId === undefined ? {} : { leaseId }),
          decision,
          controllerEndpointId: endpointId
        });
        this.#approvalSnapshots.delete(endpointId);
        if (decision === "cancel") {
          const disposition = await this.#queue.completeExplicitCancellation(resolved.turnId);
          return disposition === "cancelled_paused"
            ? "已停止审批中的任务，队列已暂停"
            : "已停止审批中的任务";
        }
        await this.#queue.approvalResolved(resolved.turnId);
        if (decision === "deny") return "已拒绝审批，本次任务已结束";
        return "审批决定已提交";
      },
      stop: async () => {
        const result = await this.#queue.stop(knownActiveSession().id);
        if (result === "cancelled_paused") return "已停止当前任务，队列已暂停";
        if (result === "cancelled") return "已停止当前任务";
        return "当前没有运行中的任务";
      },
      close: async () => {
        const session = knownActiveSession();
        const result = await this.#queue.close(session.id);
        if (result === "empty_session_deleted") return "该session为空，系统默认删除。";
        return result === "closed" ? `已关闭：${session.displayName}` : "Session已关闭";
      }
    };
  }

  private startUnknownRecovery(input: {
    readonly sessionId: string;
    readonly conversationId: string;
    readonly platformConversationId: string;
    readonly endpointId: string;
  }): void {
    let recovery = this.#unknownRecoveries.get(input.sessionId);
    if (recovery === undefined) {
      recovery = {
        sessionId: input.sessionId,
        deadlineAt: Date.now() +
          (this.options.unknownRecoveryWindowMs ?? UNKNOWN_RECOVERY_WINDOW_MS),
        watchers: new Map(),
        running: false
      };
      this.#unknownRecoveries.set(input.sessionId, recovery);
      this.scheduleUnknownRecovery(recovery);
    }
    recovery.watchers.set(input.conversationId, {
      conversationId: input.conversationId,
      platformConversationId: input.platformConversationId,
      endpointId: input.endpointId
    });
  }

  private scheduleUnknownRecovery(recovery: UnknownRecovery): void {
    const remaining = recovery.deadlineAt - Date.now();
    if (remaining <= 0) {
      void this.finishUnknownRecoveryTimeout(recovery);
      return;
    }
    const delay = Math.min(
      this.options.unknownRecoveryPollMs ?? UNKNOWN_RECOVERY_POLL_MS,
      remaining
    );
    recovery.timer = setTimeout(() => {
      void this.pollUnknownRecovery(recovery.sessionId);
    }, delay);
    recovery.timer.unref();
  }

  private async pollUnknownRecovery(sessionId: string): Promise<void> {
    const recovery = this.#unknownRecoveries.get(sessionId);
    if (recovery === undefined || recovery.running) return;
    if (Date.now() >= recovery.deadlineAt) {
      await this.finishUnknownRecoveryTimeout(recovery);
      return;
    }
    recovery.running = true;
    try {
      const current = this.store.transaction((transaction) =>
        transaction.getSession(sessionId)
      );
      if (current === undefined || current.state !== "UNKNOWN") {
        this.#unknownRecoveries.delete(sessionId);
        return;
      }
      const session = await this.#sessions.resume(sessionId);
      if (session.state === "UNKNOWN") {
        this.scheduleUnknownRecovery(recovery);
        return;
      }
      const disposition = await this.#queue.prepareRecoveredSession(sessionId);
      this.#unknownRecoveries.delete(sessionId);
      await this.notifyUnknownRecoveryResolved(session, disposition, recovery);
    } catch (error) {
      this.options.onDiagnostic("session_recovery_retry_failed", asError(error));
      if (Date.now() >= recovery.deadlineAt) {
        await this.finishUnknownRecoveryTimeout(recovery);
      } else {
        this.scheduleUnknownRecovery(recovery);
      }
    } finally {
      recovery.running = false;
    }
  }

  private async notifyUnknownRecoveryResolved(
    session: AgentSession,
    disposition: RecoveredQueueDisposition,
    recovery: UnknownRecovery
  ): Promise<void> {
    for (const watcher of recovery.watchers.values()) {
      if (this.control.activeSessionFor(watcher.conversationId) !== session.id) continue;
      this.#controllerBySession.set(session.id, watcher.endpointId);
      this.#attachments.restoreMobileWrite(session.id, watcher.endpointId);
      const text = disposition.kind === "ready"
        ? "Session状态已恢复，可以继续对话。"
        : disposition.kind === "active"
          ? `Session状态已恢复，Agent仍在执行：${summarizeText(disposition.turn.text)}\n` +
            "可等待完成或 /stop"
          : disposition.kind === "paused"
            ? `Session状态已恢复，但存在${disposition.count}个暂停任务。\n查看：/queue`
            : "Session状态暂无法核实，请等待或使用其他Session。";
      await this.channel.send({
        conversationId: watcher.platformConversationId,
        text
      }).catch((error: unknown) =>
        this.options.onDiagnostic("session_recovery_notification_failed", asError(error))
      );
    }
  }

  private async finishUnknownRecoveryTimeout(recovery: UnknownRecovery): Promise<void> {
    if (this.#unknownRecoveries.get(recovery.sessionId) !== recovery) return;
    if (recovery.timer !== undefined) clearTimeout(recovery.timer);
    this.#unknownRecoveries.delete(recovery.sessionId);
    for (const watcher of recovery.watchers.values()) {
      if (this.control.activeSessionFor(watcher.conversationId) !== recovery.sessionId) continue;
      await this.channel.send({
        conversationId: watcher.platformConversationId,
        text: "当前仍无法核实该Session状态。\n请稍后再试或切换其他Session。"
      }).catch((error: unknown) =>
        this.options.onDiagnostic("session_recovery_notification_failed", asError(error))
      );
    }
  }

  private resolveSessionReference(
    reference: string,
    conversationId?: string
  ): AgentSession | undefined {
    if (/^\d+$/u.test(reference)) {
      if (conversationId === undefined) return undefined;
      const id = this.resolveSnapshotReference(
        this.#sessionSnapshots,
        conversationId,
        reference,
        "请先使用 /sessions 查看Session列表"
      );
      return this.store.transaction((transaction) => transaction.getSession(id));
    }
    const exact = this.store.transaction((transaction) => transaction.getSession(reference));
    if (exact !== undefined) return exact;
    const ids = (this.store.database.prepare("SELECT id FROM agent_sessions").all() as { id: string }[])
      .filter((row) => isSessionShortReference(row.id, reference))
      .map((row) => row.id);
    if (ids.length > 1) {
      throw new DomainError("session_short_id_ambiguous", "Session short ID is ambiguous");
    }
    return ids[0] === undefined
      ? undefined
      : this.store.transaction((transaction) => transaction.getSession(ids[0]!));
  }

  private resolveProjectReference(reference: string, conversationId: string): string {
    if (!/^\d+$/u.test(reference)) return reference;
    return this.resolveSnapshotReference(
      this.#projectSnapshots,
      conversationId,
      reference,
      "请先使用 /projects 查看项目列表"
    );
  }

  private requireImportSnapshot(conversationId: string): ImportSnapshot {
    const snapshot = this.#importSnapshots.get(conversationId);
    if (
      snapshot === undefined ||
      Date.parse(this.clock.now()) - Date.parse(snapshot.createdAt) > SELECTOR_TTL_MS
    ) {
      this.#importSnapshots.delete(conversationId);
      throw new DomainError(
        "import_snapshot_missing",
        "请先使用 /imports <项目> 查看可导入Session"
      );
    }
    return snapshot;
  }

  private assertExternalImportSupported(agentKind: string): void {
    if (agentKind === "codex" || agentKind === "claude") return;
    const message = agentKind === "grok"
      ? "当前Grok版本不支持安全导入既有会话。请使用 /new grok <项目> 创建新会话。"
      : `当前${agentKind}不支持导入既有会话。`;
    throw new DomainError("external_session_import_unsupported", message);
  }

  private requireLocalImportSnapshot(
    endpointId: string,
    project: string,
    agent?: string
  ): ImportSnapshot {
    const snapshot = this.#localImportSnapshots.get(endpointId);
    if (
      snapshot === undefined ||
      Date.parse(this.clock.now()) - Date.parse(snapshot.createdAt) > SELECTOR_TTL_MS
    ) {
      this.#localImportSnapshots.delete(endpointId);
      throw new DomainError(
        "import_snapshot_missing",
        "请先执行session discover"
      );
    }
    if (snapshot.projectSlug !== project) {
      throw new DomainError(
        "import_project_mismatch",
        "导入项目与最近一次发现快照不一致"
      );
    }
    if (agent !== undefined && snapshot.agentKind !== agent) {
      throw new DomainError(
        "import_agent_mismatch",
        "导入Agent与最近一次发现快照不一致"
      );
    }
    return snapshot;
  }

  private importedNativeSessionIds(agentKind: string): ReadonlySet<string> {
    return new Set(
      (this.store.database.prepare(`
        SELECT native_session_id AS id
        FROM agent_sessions
        WHERE agent_kind = ? AND native_session_id IS NOT NULL
        UNION
        SELECT source_native_session_id AS id
        FROM agent_sessions
        WHERE agent_kind = ? AND source_native_session_id IS NOT NULL
      `).all(agentKind, agentKind) as { id: string }[])
        .map((row) => row.id)
    );
  }

  private async reconcileNativeSessions(): Promise<void> {
    if (this.#nativeReconciliation !== undefined) {
      await this.#nativeReconciliation;
      return;
    }
    const reconciliation = this.performNativeSessionReconciliation();
    this.#nativeReconciliation = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.#nativeReconciliation === reconciliation) {
        this.#nativeReconciliation = undefined;
      }
    }
  }

  private async deleteOwnedSession(sessionId: string): Promise<void> {
    await this.#sessions.deleteOwned(sessionId, async (session) => {
      if (session.agentKind !== "grok" || this.options.deleteNativeSession === undefined) {
        await this.agent.deleteNativeSession(session);
        return;
      }
      const affected = this.allSessions()
        .map((row) => row.session)
        .filter((candidate) =>
          candidate.agentKind === session.agentKind &&
          candidate.state !== "CLOSED"
        );
      const busy = affected.find((candidate) =>
        candidate.id !== session.id &&
        this.store.transaction((transaction) =>
          transaction.listTurns(candidate.id).some((turn) => !isTerminalTurn(turn.state))
        )
      );
      if (busy !== undefined) {
        throw new DomainError(
          "agent_runtime_busy",
          "其他Grok Session仍有未完成任务，请完成或停止后再删除"
        );
      }
      const resumable = affected.filter((candidate) => candidate.id !== session.id);
      for (const candidate of affected) {
        await this.#linearizer.run(candidate.id, () => this.store.transaction((transaction) => {
          const current = transaction.getSession(candidate.id);
          if (current === undefined || current.state === "CLOSED") return;
          transaction.putSession({
            ...current,
            state: "UNKNOWN",
            runtimeState: "EXITED",
            queuePaused: true,
            updatedAt: this.clock.now()
          });
        }));
      }
      try {
        await this.options.deleteNativeSession!(session);
      } catch (error) {
        await this.rebindAfterPlannedRuntimeReplacement(affected);
        throw error;
      }
      await this.rebindAfterPlannedRuntimeReplacement(resumable);
    });

    await this.#approvals.invalidateSessions([sessionId]);
    const recovery = this.#unknownRecoveries.get(sessionId);
    if (recovery?.timer !== undefined) clearTimeout(recovery.timer);
    this.#unknownRecoveries.delete(sessionId);
    this.#controllerBySession.delete(sessionId);
    this.#attachments.forgetSession(sessionId);
    this.#sessionSnapshots.clear();
    this.#queueSnapshots.clear();
    this.#approvalSnapshots.clear();
    for (const [conversationId, confirmation] of this.#deleteConfirmations) {
      if (confirmation.sessionId === sessionId) this.#deleteConfirmations.delete(conversationId);
    }
    this.#importSnapshots.clear();
    this.#localImportSnapshots.clear();
  }

  private assertSessionDeleteReady(session: AgentSession): void {
    if (session.nativeLifecycleOwner !== "AGENTLINK") {
      throw new DomainError(
        "native_session_not_owned",
        "外部导入Session不能删除原生历史，请使用本地CLI detach"
      );
    }
    if (session.nativeSessionId === undefined) {
      throw new DomainError("native_session_missing", "Session缺少原生Session标识");
    }
    const unfinished = this.store.transaction((transaction) =>
      transaction.listTurns(session.id).some((turn) => !isTerminalTurn(turn.state))
    );
    if (unfinished) {
      throw new DomainError("session_busy", "Session仍有未完成任务，不能删除");
    }
  }

  private async rebindAfterPlannedRuntimeReplacement(
    sessions: readonly AgentSession[]
  ): Promise<void> {
    for (const session of sessions) {
      try {
        await this.#sessions.resume(session.id);
      } catch (error) {
        this.options.onDiagnostic("planned_runtime_rebind_failed", asError(error));
      }
    }
  }

  private async performNativeSessionReconciliation(): Promise<void> {
    const operation = this.agent.findMissingNativeSessions;
    if (operation === undefined) return;
    const sessions = this.allSessions()
      .map((row) => row.session)
      .filter((session) => session.nativeSessionId !== undefined);
    if (sessions.length === 0) return;
    const missingIds = [...new Set(await operation.call(this.agent, sessions))];
    if (missingIds.length === 0) return;
    const missing = missingIds.map((sessionId) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) {
        throw new Error("Agent reported an unknown missing Session");
      }
      return session;
    });
    await this.#approvals.invalidateSessions(missingIds);
    this.agent.forgetNativeSessions?.(missing);
    for (const session of missing) {
      const recovery = this.#unknownRecoveries.get(session.id);
      if (recovery?.timer !== undefined) clearTimeout(recovery.timer);
      this.#unknownRecoveries.delete(session.id);
      this.#controllerBySession.delete(session.id);
      this.store.transaction((transaction) => transaction.deleteSession(session.id));
    }
    this.#sessionSnapshots.clear();
    this.#queueSnapshots.clear();
    this.#approvalSnapshots.clear();
    for (const agentKind of new Set(missing.map((session) => session.agentKind))) {
      const surviving = sessions.filter((session) =>
        session.agentKind === agentKind &&
        !missingIds.includes(session.id)
      );
      const resumable: string[] = [];
      const interrupted: string[] = [];
      for (const session of surviving) {
        if (session.state !== "OPEN") continue;
        const hasActiveWork = this.store.transaction((transaction) =>
          transaction.listTurns(session.id).some((turn) => !isTerminalTurn(turn.state))
        );
        if (hasActiveWork) {
          interrupted.push(session.id);
          continue;
        }
        this.store.transaction((transaction) => {
          const current = transaction.getSession(session.id);
          if (current === undefined || current.state !== "OPEN") return;
          transaction.putSession({
            ...current,
            state: "UNKNOWN",
            runtimeState: "EXITED",
            updatedAt: this.clock.now()
          });
        });
        resumable.push(session.id);
      }
      if (interrupted.length > 0) {
        await Promise.all([
          this.#runtimeFailure.handleExit({
            runtimeId: `${agentKind}-shared`,
            alive: false,
            affectedSessionIds: interrupted
          }),
          this.#approvals.invalidateSessions(interrupted)
        ]);
      }
      await this.options.restartAgentRuntime?.(agentKind);
      for (const sessionId of resumable) {
        try {
          await this.#sessions.resume(sessionId);
        } catch (error) {
          this.options.onDiagnostic(
            "native_session_rebind_failed",
            asError(error)
          );
        }
      }
    }
  }

  private async importExternalCandidate(
    projectId: string,
    agentKind: string,
    candidate: ExternalAgentSessionCandidate
  ): Promise<AgentSession> {
    try {
      return await this.#sessions.importExternal(projectId, agentKind, candidate);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        throw new DomainError(
          "external_session_already_imported",
          `该${agentKind === "claude" ? "Claude" : "Codex"} Session已导入AgentLink`
        );
      }
      throw error;
    }
  }

  private allSessions(): { session: AgentSession; project: string }[] {
    const rows = this.store.database.prepare(`
      SELECT agent_sessions.id, projects.slug
      FROM agent_sessions JOIN projects ON projects.id = agent_sessions.project_id
    `).all() as { id: string; slug: string }[];
    return rows.flatMap((row) => {
      const session = this.store.transaction((transaction) => transaction.getSession(row.id));
      return session === undefined ? [] : [{ session, project: row.slug }];
    });
  }

  private localSession(sessionId: string): { session: AgentSession; project: string } {
    const row = this.allSessions().find((item) => item.session.id === sessionId);
    if (row === undefined) throw new DomainError("session_not_found", "Session不存在");
    return row;
  }

  private localSessionView(session: AgentSession, project: string): Readonly<Record<string, unknown>> {
    return {
      sessionId: session.id,
      project,
      agent: session.agentKind,
      displayName: session.displayName,
      state: session.state,
      runtimeState: session.runtimeState,
      nativeLifecycleOwner: session.nativeLifecycleOwner,
      nativeThreadId: session.nativeSessionId ?? null,
      lastActivityAt: session.lastActivityAt
    };
  }

  private assertLocalSessionProjectEnabled(sessionId: string): void {
    const session = this.store.transaction((transaction) => transaction.getSession(sessionId));
    if (session === undefined) throw new DomainError("session_not_found", "Session不存在");
    const project = this.projects.findById(session.projectId);
    if (project === undefined || !project.enabled) {
      throw new DomainError("project_disabled", "Session所属Project已停用");
    }
  }

  private displaySessionIds(): Record<string, string> {
    return sessionShortIds(this.allSessions().map((row) => row.session.id));
  }

  private adoptFirstInputName(sessionId: string, text: string): void {
    this.store.transaction((transaction) => {
      const session = transaction.getSession(sessionId);
      if (session === undefined) return;
      const project = this.projects.findById(session.projectId);
      if (project === undefined) return;
      const fallback = sanitizeDisplayName(`${project.slug} · 新会话`, project.slug);
      if (session.displayName !== fallback) return;
      transaction.putSession({
        ...session,
        displayName: sanitizeDisplayName(text, fallback, 48),
        updatedAt: this.clock.now()
      });
    });
  }

  private snapshot(ids: readonly string[]): SelectorSnapshot {
    return { ids: [...ids], createdAt: this.clock.now() };
  }

  private requireSnapshot(
    snapshots: Map<string, SelectorSnapshot>,
    key: string,
    message: string
  ): SelectorSnapshot {
    const snapshot = snapshots.get(key);
    if (
      snapshot === undefined ||
      Date.parse(this.clock.now()) - Date.parse(snapshot.createdAt) > SELECTOR_TTL_MS
    ) {
      snapshots.delete(key);
      throw new DomainError("selector_snapshot_missing", message);
    }
    return snapshot;
  }

  private referenceFromSnapshot(snapshot: SelectorSnapshot, reference: string): string {
    const number = Number.parseInt(reference, 10);
    const resolved = snapshot.ids[number - 1];
    if (resolved === undefined) {
      throw new DomainError(
        "selector_out_of_range",
        `序号超出范围，请输入1—${snapshot.ids.length}`
      );
    }
    return resolved;
  }

  private resolveSnapshotReference(
    snapshots: Map<string, SelectorSnapshot>,
    key: string,
    reference: string,
    message: string
  ): string {
    return this.referenceFromSnapshot(this.requireSnapshot(snapshots, key, message), reference);
  }
}

function conversationKey(accountId: string, platformConversationId: string): string {
  return `${accountId.length}:${accountId}|${platformConversationId.length}:${platformConversationId}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown Gateway failure");
}

export function sessionShortId(sessionId: string): string {
  return `s-${sessionDigest(sessionId).slice(0, 6)}`;
}

export function sessionShortIds(
  sessionIds: readonly string[],
  digest: (sessionId: string) => string = sessionDigest
): Record<string, string> {
  const digests = new Map(sessionIds.map((id) => [id, digest(id)]));
  const result: Record<string, string> = {};
  for (const id of sessionIds) {
    const value = digests.get(id)!;
    let length = 6;
    while (
      length <= 12 &&
      sessionIds.some((other) =>
        other !== id && digests.get(other)!.startsWith(value.slice(0, length))
      )
    ) {
      length += 1;
    }
    if (length > 12) {
      throw new DomainError(
        "session_short_id_collision",
        "Session短ID在12位内仍冲突，请使用完整ID在本机处理"
      );
    }
    result[id] = `s-${value.slice(0, length)}`;
  }
  return result;
}

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function isSessionShortReference(sessionId: string, reference: string): boolean {
  const match = /^s-([a-f0-9]{6,12})$/iu.exec(reference);
  return match?.[1] !== undefined &&
    sessionDigest(sessionId).startsWith(match[1].toLowerCase());
}

function queueSnapshotKey(conversationId: string, sessionId: string): string {
  return `${conversationId.length}:${conversationId}|${sessionId}`;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sessionStateLabel(session: AgentSession): string {
  if (session.state === "UNKNOWN" && session.nativeSessionId === undefined) {
    return "UNKNOWN（缺少恢复标识）";
  }
  if (session.state === "UNKNOWN") return "UNKNOWN（状态待核实）";
  return session.state;
}

function turnStateLabel(state: Turn["state"]): string {
  if (state === "WAITING_AGENT_APPROVAL") return "等待审批";
  if (state === "PAUSED") return "暂停";
  if (state === "QUEUED") return "等待";
  if (state === "DISPATCHED") return "提交中";
  return "执行中";
}

function terminalStatusLabel(status: "completed" | "interrupted" | "failed"): string {
  if (status === "completed") return "任务已完成";
  if (status === "interrupted") return "任务已中断";
  return "任务失败";
}
