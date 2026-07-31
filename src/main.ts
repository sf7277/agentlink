#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startCodexRuntime, type CodexRuntime } from "./agent-codex/supervisor/runtime.js";
import { CODEX_MAX_LINE_BYTES } from "./agent-codex/protocol/jsonl-rpc-client.js";
import {
  SharedCodexAdapter,
  type CodexAdapterEvents
} from "./agent-codex/adapter/shared-codex-adapter.js";
import {
  SharedGrokAdapter,
  type GrokAdapterEvents
} from "./agent-grok/adapter/shared-grok-adapter.js";
import { startGrokRuntime, type GrokRuntime } from "./agent-grok/supervisor/runtime.js";
import {
  SharedClaudeAdapter,
  type ClaudeAdapterEvents
} from "./agent-claude/adapter/shared-claude-adapter.js";
import { startClaudeRuntime, type ClaudeRuntime } from "./agent-claude/supervisor/runtime.js";
import { deleteGrokNativeSession } from "./agent-grok/supervisor/native-session-delete.js";
import { IlinkChannelAdapter } from "./channel-wechat/adapter/ilink-channel-adapter.js";
import { IlinkHttpClient } from "./channel-wechat/protocol/http-client.js";
import { assertTrustedIlinkBaseUrl } from "./channel-wechat/protocol/url-policy.js";
import { GatewayApplication } from "./composition/gateway-application.js";
import { RestartableAgentPort } from "./composition/restartable-agent-port.js";
import { RoutingAgentPort } from "./composition/routing-agent-port.js";
import { RandomIdGenerator, SystemClock } from "./composition/system-services.js";
import type { AgentPort } from "./core/contracts/ports.js";
import type { AgentSession } from "./core/domain/model.js";
import { join } from "node:path";
import { ProjectRegistry } from "./core/application/project-registry.js";
import { safeDiagnosticRecord } from "./core/application/safe-diagnostics.js";
import { Sha256DigestService } from "./core/application/sha256-digest-service.js";
import { UnixControlServer } from "./local-control/server/unix-control-server.js";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "./platform-macos/application-paths.js";
import { ManagedLogSink } from "./platform-macos/managed-log-sink.js";
import {
  AtomicConfigStore,
  ReloadableConfig
} from "./platform-macos/atomic-config-store.js";
import { KeychainCredentialStore } from "./platform-macos/keychain-credential-store.js";
import { ControlRepository } from "./storage-sqlite/control-repository.js";
import { ProjectRepository } from "./storage-sqlite/project-repository.js";
import { SqliteStateStore } from "./storage-sqlite/sqlite-state-store.js";
import { AGENTLINK_VERSION } from "./version.js";
import type { ChannelMessage, ChannelOutput, ChannelPort } from "./core/contracts/ports.js";
import type { IlinkChannelStatus } from "./channel-wechat/adapter/monitor.js";

type CredentialStatus = "HEALTHY" | "AUTHENTICATION_REQUIRED" | "DISABLED" | "UNKNOWN";

function credentialStatusFor(status: IlinkChannelStatus): CredentialStatus {
  if (status === "connected") return "HEALTHY";
  if (status === "authentication_required") return "AUTHENTICATION_REQUIRED";
  return "UNKNOWN";
}

function notifyAuthenticationRequired(): void {
  const child = spawn("/usr/bin/osascript", [
    "-e",
    'display notification "微信连接已失效，请运行 agentlink pair wechat 重新配对" with title "AgentLink"'
  ], { shell: false, stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  child.once("error", () => undefined);
  child.unref();
}

class LocalOnlyChannel implements ChannelPort {
  public async start(_onMessage: (message: ChannelMessage) => Promise<void>): Promise<void> {}
  public async stop(): Promise<void> {}
  public async send(_output: ChannelOutput): Promise<void> {
    throw new Error("Wechat channel is disconnected");
  }
}

const previousUmask = process.umask(0o077);
const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "health-check": { type: "boolean", default: false }
  }
});

if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error("AgentLink Gateway requires Node 22 or later");
}
if (process.platform !== "darwin") throw new Error("The MVP Gateway requires macOS");

const paths = macosApplicationPaths();
await ensureMacosApplicationPaths(paths);
if (values.config !== undefined && values.config !== paths.config) {
  throw new Error("Gateway config path must be the managed Application Support path");
}
const configSource = new ReloadableConfig(new AtomicConfigStore(paths.config));
const config = await configSource.initialize();
const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
const store = new SqliteStateStore(paths.database, migrations);
await chmod(paths.database, 0o600);
store.reconcileStartup(new Date().toISOString());
const clock = new SystemClock();
const ids = new RandomIdGenerator();
const registry = new ProjectRegistry();
const projectRepository = new ProjectRepository(store.database);
for (const project of config.projects) {
  const registered = project.enabled ? await registry.register(project) : undefined;
  projectRepository.put({
    id: registered?.id ?? project.id,
    slug: registered?.slug ?? project.slug,
    canonicalPath: registered?.canonicalPath ?? project.path,
    allowedAgents: registered?.allowedAgents ?? project.allowedAgents,
    defaultAgent: registered?.defaultAgent ?? project.defaultAgent,
    enabled: project.enabled,
    createdAt: clock.now()
  });
}

if (values["health-check"]) {
  store.close();
  process.umask(previousUmask);
  process.stdout.write('{"event":"health_check","status":"ok"}\n');
} else {
  const logs = await ManagedLogSink.create(paths.logs);
  const log = (
    stream: "stdout" | "stderr",
    record: Readonly<Record<string, unknown>>
  ): void => {
    logs.write(stream, JSON.stringify(safeDiagnosticRecord(record, 60 * 1024)));
  };
  process.on("uncaughtExceptionMonitor", (error) => {
    log("stderr", { event: "gateway_uncaught_exception", status: "error", message: error.message });
  });
  const server = new UnixControlServer(paths.socket, {
    maxLineBytes: config.maxInputBytes,
    maxPublishedBytes: config.maxOutputBytes,
    maxRequestsPerMinute: config.requestsPerMinute
  });
  let runtime: CodexRuntime | undefined;
  let grokRuntime: GrokRuntime | undefined;
  // Claude sessions each own a subprocess; shutdown must terminate them all.
  let closeClaudeRuntime: (() => Promise<void>) | undefined;
  let channel: IlinkChannelAdapter | undefined;
  let application: GatewayApplication | undefined;
  const control = new ControlRepository(store.database);
  let channelStatus: CredentialStatus = config.wechat === undefined ? "DISABLED" : "UNKNOWN";
  let authenticationNotificationSent = false;
  let stopping = false;
  const diagnostic = (kind: string, error: Error): void => {
    log("stderr", {
      event: kind,
      status: "error",
      message: error.message
    });
  };
  if (config.codex !== undefined || config.grok !== undefined || config.claude !== undefined) {
    let token: string | undefined;
    if (config.wechat !== undefined) {
      control.putChannelAccount(
        config.wechat.accountId,
        config.wechat.credentialReference,
        config.wechat.controllers,
        clock.now()
      );
      const credentialStore = new KeychainCredentialStore();
      await credentialStore.cleanupPendingReferences();
      token = await credentialStore.get(config.wechat.credentialReference);
      if (token === undefined) throw new Error("Configured iLink credential is missing from Keychain");
    }
    const projectPath = (projectId: string): string => {
      const project = projectRepository.findById(projectId);
      if (project === undefined) throw new Error("Session project is not registered");
      return project.canonicalPath;
    };
    const supportedAgents: string[] = [];
    const agents: Record<string, AgentPort> = {};
    const plannedRuntimeRestarts = new Map<string, () => Promise<void>>();
    let coordinatedNativeDelete:
      | ((session: AgentSession) => Promise<void>)
      | undefined;
    let runtimeRestarting = false;

    if (config.codex !== undefined) {
      supportedAgents.push("codex");
      const codexPort = new RestartableAgentPort({
        steering: true,
        cancellation: true,
        approvals: true
      });
      const installCodexRuntime = async (): Promise<void> => {
        const nextRuntime = await startCodexRuntime({
          command: config.codex!.command,
          clientVersion: AGENTLINK_VERSION,
          requestPermissionsTool: config.codex!.requestPermissionsTool,
          experimentalApi: config.codex!.experimentalApi,
          rpc: {
            maxLineBytes: CODEX_MAX_LINE_BYTES,
            maxPendingRequests: 128,
            requestTimeoutMs: 30_000
          }
        });
        const events: CodexAdapterEvents = {
          turnStarted: (sessionId, turnId, nativeTurnId) =>
            application?.turnStarted(sessionId, turnId, nativeTurnId),
          turnCompleted: (sessionId, turnId, status, finalResponse) =>
            application?.turnCompleted(sessionId, turnId, status, finalResponse),
          approvalRequested: (request) => application?.approvalRequested(request),
          approvalResolved: (sessionId, turnId) =>
            application?.approvalResolved(sessionId, turnId),
          threadNameUpdated: (sessionId, displayName) =>
            application?.threadNameUpdated(sessionId, displayName),
          runtimeExited: (sessionIds, error) => {
            codexPort.clear();
            if (stopping || runtimeRestarting) return;
            runtimeRestarting = true;
            void (async () => {
              await application?.runtimeExited(sessionIds, error);
              runtime = undefined;
              const retryDelays = [0, 250, 1_000] as const;
              for (const delay of retryDelays) {
                if (stopping) return;
                if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
                try {
                  await installCodexRuntime();
                  log("stdout", { event: "codex_runtime_restarted", status: "ready" });
                  return;
                } catch (restartError) {
                  diagnostic(
                    "codex_runtime_restart_failed",
                    restartError instanceof Error
                      ? restartError
                      : new Error("Codex Runtime restart failed")
                  );
                }
              }
            })().finally(() => {
              runtimeRestarting = false;
            });
          },
          protocolError: (error) => diagnostic("codex_protocol_error", error)
        };
        const nextAgent = new SharedCodexAdapter(
          nextRuntime.client,
          new Sha256DigestService(),
          ids,
          events,
          {
            projectPath,
            maxActiveTurns: config.codex!.maxActiveTurns
          }
        );
        runtime = nextRuntime;
        codexPort.install(nextAgent);
      };
      await installCodexRuntime();
      plannedRuntimeRestarts.set("codex", async () => {
        if (runtimeRestarting) throw new Error("Codex Runtime is already restarting");
        runtimeRestarting = true;
        const current = runtime;
        runtime = undefined;
        codexPort.clear();
        try {
          await current?.close();
          if (!stopping) await installCodexRuntime();
        } finally {
          runtimeRestarting = false;
        }
      });
      agents.codex = codexPort;
    }

    if (config.grok !== undefined) {
      supportedAgents.push("grok");
      const grokPort = new RestartableAgentPort({
        steering: false,
        cancellation: true,
        approvals: true
      });
      let grokRestarting = false;
      const installGrokRuntime = async (): Promise<void> => {
        const nextRuntime = await startGrokRuntime({
          command: config.grok!.command,
          clientVersion: AGENTLINK_VERSION,
          isolatedHomeRoot: config.grok!.isolatedHomeRoot ??
            join(paths.applicationSupport, "grok-runtime"),
          rpc: {
            maxLineBytes: config.maxOutputBytes,
            maxPendingRequests: 128,
            requestTimeoutMs: 30 * 60_000
          }
        });
        const events: GrokAdapterEvents = {
          turnCompleted: (sessionId, turnId, status, finalResponse) =>
            application?.turnCompleted(sessionId, turnId, status, finalResponse),
          approvalRequested: (request) => application?.approvalRequested(request),
          approvalResolved: (sessionId, turnId) =>
            application?.approvalResolved(sessionId, turnId),
          sessionNameUpdated: (sessionId, displayName) =>
            application?.threadNameUpdated(sessionId, displayName),
          runtimeExited: (sessionIds, error) => {
            grokPort.clear();
            if (stopping || grokRestarting) return;
            grokRestarting = true;
            void (async () => {
              await application?.runtimeExited(sessionIds, error);
              grokRuntime = undefined;
              const retryDelays = [0, 250, 1_000] as const;
              for (const delay of retryDelays) {
                if (stopping) return;
                if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
                try {
                  await installGrokRuntime();
                  log("stdout", { event: "grok_runtime_restarted", status: "ready" });
                  return;
                } catch (restartError) {
                  diagnostic(
                    "grok_runtime_restart_failed",
                    restartError instanceof Error
                      ? restartError
                      : new Error("Grok Runtime restart failed")
                  );
                }
              }
            })().finally(() => {
              grokRestarting = false;
            });
          },
          protocolError: (error) => diagnostic("grok_protocol_error", error)
        };
        const nextAgent = new SharedGrokAdapter(
          nextRuntime.client,
          new Sha256DigestService(),
          ids,
          events,
          {
            projectPath,
            grokHome: nextRuntime.grokHome,
            maxActiveTurns: config.grok!.maxActiveTurns,
            sessionCapabilities: nextRuntime.sessionCapabilities
          }
        );
        grokRuntime = nextRuntime;
        grokPort.install(nextAgent);
      };
      await installGrokRuntime();
      coordinatedNativeDelete = async (session: AgentSession): Promise<void> => {
        if (grokRestarting) throw new Error("Grok Runtime is already restarting");
        const nativeSessionId = session.nativeSessionId;
        if (nativeSessionId === undefined) throw new Error("Grok Session has no native ID");
        const current = grokRuntime;
        if (current === undefined) throw new Error("Grok Runtime is unavailable");
        grokRestarting = true;
        grokRuntime = undefined;
        grokPort.clear();
        let deletionError: unknown;
        try {
          await current.close();
          await deleteGrokNativeSession({
            command: config.grok!.command,
            grokHome: current.grokHome,
            projectRoot: projectPath(session.projectId),
            nativeSessionId
          });
        } catch (error) {
          deletionError = error;
        }
        try {
          if (!stopping) await installGrokRuntime();
        } catch (restartError) {
          throw new Error("Grok Runtime restart after Session delete failed", {
            cause: restartError
          });
        } finally {
          grokRestarting = false;
        }
        if (deletionError !== undefined) throw deletionError;
      };
      plannedRuntimeRestarts.set("grok", async () => {
        if (grokRestarting) throw new Error("Grok Runtime is already restarting");
        grokRestarting = true;
        const current = grokRuntime;
        grokRuntime = undefined;
        grokPort.clear();
        try {
          await current?.close();
          if (!stopping) await installGrokRuntime();
        } finally {
          grokRestarting = false;
        }
      });
      agents.grok = grokPort;
    }

    if (config.claude !== undefined) {
      supportedAgents.push("claude");
      const claudePort = new RestartableAgentPort({
        steering: false,
        cancellation: true,
        approvals: true
      });
      let claudeRestarting = false;
      let claudeRuntime: ClaudeRuntime | undefined;
      const installClaudeRuntime = async (): Promise<void> => {
        const nextRuntime = await startClaudeRuntime({ command: config.claude!.command });
        const events: ClaudeAdapterEvents = {
          turnCompleted: (sessionId, turnId, status, finalResponse) =>
            application?.turnCompleted(sessionId, turnId, status, finalResponse),
          approvalRequested: (request) => application?.approvalRequested(request),
          approvalResolved: (sessionId, turnId) =>
            application?.approvalResolved(sessionId, turnId),
          runtimeExited: (sessionIds, error) => {
            // Each Claude session owns its own SDK subprocess: one dying
            // session must not clear the port or touch other sessions.
            diagnostic("claude_session_runtime_exited", error);
            void application?.runtimeExited(sessionIds, error);
          },
          protocolError: (error) => diagnostic("claude_protocol_error", error)
        };
        const nextAgent = new SharedClaudeAdapter(
          nextRuntime.client,
          new Sha256DigestService(),
          ids,
          events,
          {
            projectPath,
            claudeHome: nextRuntime.claudeHome,
            maxActiveTurns: config.claude!.maxActiveTurns,
            // Sessions already owned or imported by AgentLink must not be
            // offered again as import candidates.
            knownNativeSessionIds: () => new Set(
              (store.database.prepare(`
                SELECT native_session_id AS id FROM agent_sessions
                WHERE agent_kind = 'claude' AND native_session_id IS NOT NULL
                UNION
                SELECT source_native_session_id AS id FROM agent_sessions
                WHERE agent_kind = 'claude' AND source_native_session_id IS NOT NULL
              `).all() as { id: string }[]).map((row) => row.id)
            )
          }
        );
        claudeRuntime = nextRuntime;
        closeClaudeRuntime = async () => {
          await nextRuntime.close();
        };
        claudePort.install(nextAgent);
      };
      await installClaudeRuntime();
      plannedRuntimeRestarts.set("claude", async () => {
        if (claudeRestarting) throw new Error("Claude Runtime is already restarting");
        claudeRestarting = true;
        const current = claudeRuntime;
        claudeRuntime = undefined;
        claudePort.clear();
        try {
          await current?.close();
          if (!stopping) await installClaudeRuntime();
        } finally {
          claudeRestarting = false;
        }
      });
      agents.claude = claudePort;
    }

    const agent: AgentPort = Object.keys(agents).length === 1
      ? (Object.values(agents)[0] as AgentPort)
      : new RoutingAgentPort(agents, (sessionId) =>
        store.transaction((tx) => tx.getSession(sessionId)?.agentKind)
      );

    if (config.wechat !== undefined && token !== undefined) {
      const client = new IlinkHttpClient({
        baseUrl: assertTrustedIlinkBaseUrl(config.wechat.baseUrl),
        token: async () => token,
        maxRequestBytes: config.maxInputBytes,
        maxResponseBytes: config.maxOutputBytes
      });
      const initialCursor = control.cursorFor(config.wechat.accountId);
      channel = new IlinkChannelAdapter(client, ids, {
        accountId: config.wechat.accountId,
        allowedSenders: new Set(config.wechat.controllers.map((item) => item.senderId)),
        ...(initialCursor === undefined ? {} : { initialCursor }),
        onCursorAccepted: (cursor) =>
          control.saveCursor(config.wechat!.accountId, cursor, clock.now()),
        onStatus: (status) => {
          channelStatus = credentialStatusFor(status);
          if (status === "authentication_required") {
            control.setCredentialStatus(
              config.wechat!.accountId,
              "AUTHENTICATION_REQUIRED",
              clock.now()
            );
            if (!authenticationNotificationSent) {
              authenticationNotificationSent = true;
              notifyAuthenticationRequired();
            }
          }
        },
        onFatal: (error) => diagnostic("wechat_channel_fatal", error)
      });
    }
    const channelPort: ChannelPort = channel ?? new LocalOnlyChannel();
    application = new GatewayApplication(
      store,
      control,
      projectRepository,
      registry,
      channelPort,
      agent,
      clock,
      ids,
      {
        accountId: config.wechat?.accountId ?? "local-only",
        identities: (config.wechat?.controllers ?? []).map((item) => ({
          accountId: config.wechat?.accountId ?? "local-only",
          senderId: item.senderId,
          gatewayUserId: item.gatewayUserId
        })),
        approvalLeaseMs: config.approvalLeaseMs,
        queueLimit: config.queueLimit,
        supportedAgents,
        restartAgentRuntime: async (agentKind) => {
          const restart = plannedRuntimeRestarts.get(agentKind);
          if (restart === undefined) {
            throw new Error(`No Runtime restart is configured for Agent: ${agentKind}`);
          }
          await restart();
          log("stdout", {
            event: `${agentKind}_runtime_restarted`,
            status: "native_session_reconciled"
          });
        },
        deleteNativeSession: async (session) => {
          if (session.agentKind !== "grok") {
            throw new Error("Native delete coordinator received a non-Grok Session");
          }
          const operation = coordinatedNativeDelete;
          if (operation === undefined) {
            throw new Error("No native delete coordinator is configured");
          }
          await operation(session);
        },
        publishLocal: (sessionId, payload) => server.publish(sessionId, payload),
        onDiagnostic: diagnostic
      }
    );
  }
  await server.start(async (event) => {
    if (event.kind === "channel_status") {
      return { channel: event.channel, status: channelStatus };
    }
    if (event.kind === "channel_disconnect") {
      const notice = await channel?.notifyDisconnect(
        `AgentLink已于${clock.now()}从此电脑解除微信连接，后续消息将不会被处理。`
      ) ?? { attempted: 0, delivered: 0 };
      await channel?.stop();
      channelStatus = "DISABLED";
      if (config.wechat !== undefined) {
        control.setCredentialStatus(config.wechat.accountId, "DISABLED", clock.now());
      }
      return { status: "disconnected", mobileNotice: notice };
    }
    if (application === undefined) {
      throw new Error("Gateway adapters are not configured for this control event");
    }
    return application.handleLocalEvent(event);
  });
  if (channel !== undefined && application !== undefined) {
    await channel.start((message) => application!.handleChannelMessage(message));
  }
  log("stdout", { event: "gateway_started", status: "ready" });

  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stdout", {
      event: "gateway_stopping",
      status: "graceful",
      code: signal
    });
    const errors: Error[] = [];
    for (const operation of [
      () => channel?.stop(),
      () => server.stop(),
      () => runtime?.close(),
      () => grokRuntime?.close(),
      () => closeClaudeRuntime?.()
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error("Gateway shutdown failed"));
      }
    }
    try {
      store.close();
    } finally {
      process.umask(previousUmask);
    }
    if (errors.length > 0) throw errors[0];
  };
  const finished = new Promise<void>((resolve, reject) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void stop(signal).then(resolve, reject);
      });
    }
    process.on("SIGHUP", () => {
      if (stopping) return;
      void configSource.reload().then((result) => {
        log("stdout", {
          event: "config_reload",
          status: result.ok ? "accepted" : "rejected"
        });
      });
    });
  });
  await finished;
  const socket = await lstat(paths.socket).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error)
  );
  if (socket !== undefined) throw new Error("Gateway socket remained after shutdown");
  logs.close();
}
