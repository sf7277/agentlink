#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { IlinkQrLogin } from "./channel-wechat/adapter/qr-login.js";
import { IlinkHttpClient } from "./channel-wechat/protocol/http-client.js";
import { assertTrustedIlinkBaseUrl } from "./channel-wechat/protocol/url-policy.js";
import { sendControlEvent } from "./local-control/client/control-client.js";
import {
  applicationPaths,
  configDocumentStore,
  credentialStore,
  ensureApplicationPaths
} from "./platform/factory.js";
import {
  diagnoseAgentLink,
  readAgentLinkLogs
} from "./platform-macos/diagnostics-service.js";
import {
  diagnoseWindowsAgentLink,
  readWindowsAgentLinkLogs
} from "./platform-windows/diagnostics-service.js";
import { LaunchAgentService } from "./platform-macos/launch-agent-service.js";
import { BrowserQrPresenter } from "./platform-macos/browser-qr-presenter.js";
import { WindowsBrowserQrPresenter } from "./platform-windows/browser-qr-presenter.js";
import { renderWindowsQr } from "./platform-windows/qr-code-renderer.js";
import { AtomicConfigStore } from "./platform-macos/atomic-config-store.js";
import { ProjectConfigService } from "./platform-macos/project-config-service.js";
import {
  AgentConfigService,
  agentCapabilities,
  type ConfigurableAgentKind
} from "./platform-macos/agent-config-service.js";
import { WechatPairingService } from "./platform-macos/wechat-pairing-service.js";
import { WechatDisconnectService } from "./platform-macos/wechat-disconnect-service.js";
import { SqliteBackupManager } from "./storage-sqlite/backup-manager.js";
import { AGENTLINK_VERSION } from "./version.js";

const BOOLEAN_OPTIONS = new Set([
  "confirm-local",
  "confirm-destroy-data",
  "confirm",
  "archived",
  "all",
  "json"
]);

export async function runCtl(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();
  if (command === "--version" || command === "-v") {
    if (args.length !== 0) {
      usage(process.stderr);
      return 2;
    }
    process.stdout.write(`${AGENTLINK_VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    if (args.length !== 0) {
      usage(process.stderr);
      return 2;
    }
    usage(process.stdout);
    return 0;
  }
  const help = command === undefined ? undefined : subcommandHelp(command, args);
  if (help !== undefined) {
    process.stdout.write(`${help}\n`);
    return 0;
  }
  if (command === "service") return runService(args);
  if (command === "start") return runLifecycle("start", args);
  if (command === "stop") return runLifecycle("stop", args);
  if (command === "restart") return runLifecycle("restart", args);
  if (command === "status") return runLifecycle("status", args);
  if (command === "logs") return runLogs(args);
  if (command === "doctor") return runDoctor(args);
  if (command === "project") return runProject(args);
  if (command === "agent") return runAgent(args);
  if (command === "pair") return runPair(args);
  if (command === "disconnect") return runDisconnect(args);
  if (command === "channel") return runChannel(args);
  if (command === "session") return runSession(args);
  if (command === "attach") return runAttach(args);
  usage(process.stderr);
  return 2;
}

async function runAgent(args: string[]): Promise<number> {
  const action = args.shift();
  const maybeAgent = action === "list" ? undefined : args.shift();
  const options = parseOptions(args);
  const paths = applicationPaths();
  await ensureApplicationPaths(paths);
  if (await lstat(paths.config).catch(() => undefined) === undefined) {
    await configDocumentStore(paths.config).save({});
  }
  const service = new AgentConfigService(
    paths.config,
    paths.runtime,
    undefined,
    configDocumentStore(paths.config)
  );
  if (action === "list") {
    assertAllowedOptions(options, []);
    writeOutput(options, await service.list());
    return 0;
  }
  const agent = parseAgentKind(maybeAgent);
  if (action === "capabilities") {
    assertAllowedOptions(options, []);
    writeOutput(options, { agent, capabilities: agentCapabilities(agent) });
    return 0;
  }
  if (action === "status") {
    assertAllowedOptions(options, []);
    const configured = (await service.list()).find((item) => item.agent === agent);
    writeOutput(options, configured === undefined
      ? { agent, status: "NOT_CONFIGURED" }
      : { ...configured, status: "CONFIGURED" });
    return 0;
  }
  if (action === "configure") {
    assertAllowedOptions(options, ["command", "isolated-home-root"]);
    const previous = await configDocumentStore(paths.config).load();
    const configured = await service.configure({
      agent,
      command: requiredOption(options, "command"),
      ...(options.get("isolated-home-root") === undefined
        ? {}
        : { isolatedHomeRoot: options.get("isolated-home-root")! })
    });
    await restartAfterConfigChange(paths, previous);
    writeOutput(options, {
      status: "configured",
      ...configured,
      ...(process.platform === "win32"
        ? { nextAction: "请停止并重新启动前台 Gateway：agentlink-gateway.cmd" }
        : {})
    });
    return 0;
  }
  if (action === "remove") {
    assertAllowedOptions(options, ["confirm-local"]);
    if (!options.has("confirm-local")) throw new Error("agent remove requires --confirm-local");
    if (await hasStoredAgentSessions(paths.database, agent)) {
      throw new Error(`Agent still has stored Sessions: ${agent}`);
    }
    const previous = await configDocumentStore(paths.config).load();
    await service.remove(agent);
    await restartAfterConfigChange(paths, previous);
    writeOutput(options, {
      status: "removed",
      agent,
      ...(process.platform === "win32"
        ? { nextAction: "请停止并重新启动前台 Gateway：agentlink-gateway.cmd" }
        : {})
    });
    return 0;
  }
  usage(process.stderr);
  return 2;
}

async function restartAfterConfigChange(
  paths: ReturnType<typeof applicationPaths>,
  previous: Awaited<ReturnType<AtomicConfigStore["load"]>>
): Promise<void> {
  if (process.platform === "win32") return;
  const launchAgent = new LaunchAgentService({ paths });
  const status = await launchAgent.status();
  if (!status.loaded) return;
  try {
    await launchAgent.restart();
  } catch (error) {
    await configDocumentStore(paths.config).save(previous);
    await launchAgent.restart().catch(() => undefined);
    throw error;
  }
}

function parseAgentKind(value: string | undefined): ConfigurableAgentKind {
  if (value === "codex" || value === "grok" || value === "claude") return value;
  throw new Error("Agent must be codex, grok or claude");
}

async function hasStoredAgentSessions(
  databasePath: string,
  agent: ConfigurableAgentKind
): Promise<boolean> {
  if (await lstat(databasePath).catch(() => undefined) === undefined) return false;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_kind = ?"
    ).get(agent) as { count: number };
    return row.count > 0;
  } finally {
    database.close();
  }
}

async function runChannel(args: string[]): Promise<number> {
  const action = args.shift();
  const channel = args.shift();
  if (action !== "status" || channel !== "wechat") {
    throw new Error("Supported channel command: channel status wechat");
  }
  const options = parseOptions(args);
  assertAllowedOptions(options, ["socket", "endpoint"]);
  const paths = applicationPaths();
  const socket = options.get("socket") ?? paths.socket;
  if (await lstat(socket).catch(() => undefined) === undefined) {
    const configured = await lstat(paths.config).then(
      () => configDocumentStore(paths.config).load().then((config) => config.wechat !== undefined),
      () => false
    );
    writeOutput(options, { channel: "wechat", status: configured ? "UNKNOWN" : "DISABLED" });
    return 0;
  }
  writeOutput(options, await sendControlEvent(socket, {
      endpointId: options.get("endpoint") ?? "local-cli",
      kind: "channel_status",
      channel: "wechat"
    }));
  return 0;
}

async function runDisconnect(args: string[]): Promise<number> {
  const channelName = args.shift();
  if (channelName !== "wechat") {
    throw new Error("Supported disconnect command: disconnect wechat");
  }
  const options = parseOptions(args);
  assertAllowedOptions(options, ["socket", "endpoint"]);
  const paths = applicationPaths();
  const socket = options.get("socket") ?? paths.socket;
  let mobileNotice: unknown = { attempted: 0, delivered: 0 };
  if (await lstat(socket).catch(() => undefined) !== undefined) {
    const response = await sendControlEvent(socket, {
      endpointId: options.get("endpoint") ?? "local-cli",
      kind: "channel_disconnect",
      channel: "wechat"
    }) as { mobileNotice?: unknown };
    mobileNotice = response.mobileNotice ?? mobileNotice;
  }
  const service = process.platform === "darwin" ? new LaunchAgentService({ paths }) : undefined;
  try {
    const result = await new WechatDisconnectService(
      paths.config,
      credentialStore(),
      configDocumentStore(paths.config)
    ).disconnect();
    const status = service === undefined ? { loaded: false } : await service.status();
    if (status.loaded && service !== undefined) await service.restart();
    writeOutput(options, {
      ...result,
      localOnly: true,
      serverCredentialRevoked: false,
      mobileNotice
    });
    return 0;
  } catch (error) {
    const status = await service?.status().catch(() => undefined);
    if (status?.loaded && service !== undefined) await service.restart().catch(() => undefined);
    throw error;
  }
}

async function runService(args: string[]): Promise<number> {
  const action = args.shift();
  const options = parseOptions(args);
  if (process.platform === "win32") {
    throw new Error("Windows foreground mode does not support LaunchAgent lifecycle commands");
  }
  const paths = applicationPaths();
  const service = new LaunchAgentService({ paths });
  if (action === "install") {
    assertAllowedOptions(options, ["release", "confirm-local"]);
    const release = requiredOption(options, "release");
    if (!options.has("confirm-local")) throw new Error("--confirm-local is required");
    const result = await service.install({
      releaseDirectory: resolve(release),
      confirmation: "INSTALL_AGENTLINK_LOCALLY"
    });
    writeOutput(options, { status: "installed", ...result });
    return 0;
  }
  if (action === "uninstall") {
    assertAllowedOptions(options, ["confirm-local"]);
    if (!options.has("confirm-local")) throw new Error("--confirm-local is required");
    await service.uninstall("UNINSTALL_AGENTLINK_LOCALLY");
    writeOutput(options, { status: "uninstalled", data: "preserved" });
    return 0;
  }
  if (action === "purge") {
    assertAllowedOptions(options, [
      "confirm-local",
      "confirm-destroy-data",
      "credential-references"
    ]);
    if (!options.has("confirm-local") || !options.has("confirm-destroy-data")) {
      throw new Error("--confirm-local and --confirm-destroy-data are required");
    }
    const credentialReferences = (options.get("credential-references") ?? "")
      .split(",")
      .filter((value) => value !== "");
    const credentials = credentialStore();
    await service.purge({
      uninstallConfirmation: "UNINSTALL_AGENTLINK_LOCALLY",
      destructiveConfirmation: "DELETE_AGENTLINK_DATA",
      credentialReferences,
      deleteCredential: (reference) => credentials.delete(reference)
    });
    writeOutput(options, { status: "purged", data: "deleted" });
    return 0;
  }
  if (action === "backup") {
    assertAllowedOptions(options, ["output"]);
    const output = resolve(requiredOption(options, "output"));
    await new SqliteBackupManager().backup(paths.database, output);
    writeOutput(options, { status: "backed_up", output });
    return 0;
  }
  if (action === "restore") {
    assertAllowedOptions(options, ["input", "confirm-local"]);
    if (!options.has("confirm-local")) throw new Error("--confirm-local is required");
    const status = await service.status();
    if (status.loaded) throw new Error("Stop or uninstall the service before restoring its database");
    const input = resolve(requiredOption(options, "input"));
    await new SqliteBackupManager().restore(input, paths.database);
    writeOutput(options, { status: "restored" });
    return 0;
  }
  usage(process.stderr);
  return 2;
}

async function runLifecycle(
  action: "status" | "start" | "stop" | "restart",
  args: string[]
): Promise<number> {
  const options = parseOptions(args);
  assertAllowedOptions(options, []);
  if (process.platform === "win32") {
    throw new Error("Windows foreground mode does not support background lifecycle commands");
  }
  const service = new LaunchAgentService({ paths: applicationPaths() as import("./platform-macos/application-paths.js").MacosApplicationPaths });
  writeOutput(options, await service[action]());
  return 0;
}

async function runLogs(args: string[]): Promise<number> {
  const options = parseOptions(args);
  assertAllowedOptions(options, ["lines"]);
  const lines = Number.parseInt(options.get("lines") ?? "200", 10);
  const paths = applicationPaths();
  const logs = process.platform === "win32"
    ? await readWindowsAgentLinkLogs(paths, lines)
    : await readAgentLinkLogs(paths as import("./platform-macos/application-paths.js").MacosApplicationPaths, lines);
  if (options.has("json")) {
    writeJson(logs);
    return 0;
  }
  process.stdout.write(`== gateway.stdout.log ==\n${logs.stdout}\n`);
  process.stdout.write(`== gateway.stderr.log ==\n${logs.stderr}\n`);
  return 0;
}

async function runDoctor(args: string[]): Promise<number> {
  const options = parseOptions(args);
  assertAllowedOptions(options, []);
  if (process.platform === "win32") {
    const diagnosis = await diagnoseWindowsAgentLink(applicationPaths());
    writeOutput(options, diagnosis);
    return diagnosis.ok === true ? 0 : 1;
  }
  const paths = applicationPaths();
  const diagnosis = await diagnoseAgentLink(
    paths,
    new LaunchAgentService({ paths }),
    undefined,
    async () => {
      const response = await sendControlEvent(paths.socket, {
        endpointId: "local-cli",
        kind: "channel_status",
        channel: "wechat"
      }) as {
        readonly ok?: boolean;
        readonly result?: { readonly status?: string };
      };
      if (response.ok !== true || typeof response.result?.status !== "string") {
        throw new Error("Gateway channel status response is invalid");
      }
      return response.result.status;
    }
  );
  writeOutput(options, diagnosis);
  return 0;
}

async function runProject(args: string[]): Promise<number> {
  const action = args.shift();
  const options = parseOptions(args);
  const paths = applicationPaths();
  await ensureApplicationPaths(paths);
  const projects = new ProjectConfigService(paths.config, configDocumentStore(paths.config));
  if (action === "list") {
    assertAllowedOptions(options, []);
    writeOutput(options, await projects.list());
    return 0;
  }
  if (action === "add" || action === "update") {
    assertAllowedOptions(options, ["slug", "path", "agent", "default-agent"]);
    const project = await projects[action]({
      slug: requiredOption(options, "slug"),
      path: resolve(requiredOption(options, "path")),
      allowedAgents: parseAgents(options.get("agent")),
      ...(options.get("default-agent") === undefined
        ? {}
        : { defaultAgent: options.get("default-agent")! })
    });
    writeOutput(options, { status: action === "add" ? "added" : "updated", project });
    return 0;
  }
  if (action === "disable" || action === "enable") {
    assertAllowedOptions(options, ["slug", "socket", "endpoint"]);
    const slug = requiredOption(options, "slug");
    const project = await projects[action](slug);
    const socket = options.get("socket") ?? paths.socket;
    if (await lstat(socket).catch(() => undefined) !== undefined) {
      try {
        await sendControlEvent(socket, {
          endpointId: options.get("endpoint") ?? "local-cli",
          kind: action === "disable" ? "project_disable" : "project_enable",
          project: slug
        });
      } catch (error) {
        await projects[action === "disable" ? "enable" : "disable"](slug);
        throw error;
      }
    }
    writeOutput(options, { status: action === "disable" ? "disabled" : "enabled", project });
    return 0;
  }
  if (action === "remove") {
    assertAllowedOptions(options, ["slug", "socket", "endpoint"]);
    const slug = requiredOption(options, "slug");
    const socket = options.get("socket") ?? paths.socket;
    if (await lstat(socket).catch(() => undefined) !== undefined) {
      await sendControlEvent(socket, {
        endpointId: options.get("endpoint") ?? "local-cli",
        kind: "project_remove",
        project: slug
      });
    } else {
      const project = (await projects.list()).find((item) => item.slug === slug);
      if (project !== undefined && await hasStoredSessions(paths.database, project.id)) {
        throw new Error(
          "Project仍有关联Session；请先启动AgentLink Gateway，再执行project remove"
        );
      }
    }
    await projects.remove(slug);
    writeOutput(options, { status: "removed", slug, directory: "preserved" });
    return 0;
  }
  usage(process.stderr);
  return 2;
}

async function hasStoredSessions(databasePath: string, projectId: string): Promise<boolean> {
  if (await lstat(databasePath).catch(() => undefined) === undefined) return false;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS count FROM agent_sessions WHERE project_id = ?"
    ).get(projectId) as { count: number };
    return row.count > 0;
  } finally {
    database.close();
  }
}

async function runPair(args: string[]): Promise<number> {
  const channel = args.shift();
  if (channel !== "wechat") {
    throw new Error("MVP pairing supports only: pair wechat");
  }
  const options = parseOptions(args);
  assertAllowedOptions(options, [
    "base-url",
    "credential-reference",
    "gateway-user",
    "qr-output"
  ]);
  const paths = applicationPaths();
  await ensureApplicationPaths(paths);
  const baseUrl = assertTrustedIlinkBaseUrl(
    options.get("base-url") ?? "https://ilinkai.weixin.qq.com"
  );
  const credentialReference =
    options.get("credential-reference") ?? "wechat-ilink-primary";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(credentialReference)) {
    throw new Error("Credential reference contains unsupported characters");
  }
  const qrOutput = options.get("qr-output") === undefined
    ? undefined
    : resolve(options.get("qr-output")!);
  const credentials = credentialStore();
  const presenter = qrOutput === undefined
    ? process.platform === "win32"
      ? new WindowsBrowserQrPresenter({
        render: renderWindowsQr,
        onOpenFailure: (url) => {
          process.stdout.write(`浏览器未自动打开，请访问：${url}\n`);
        }
      })
      : new BrowserQrPresenter({
        render: renderQr,
        onOpenFailure: (url) => {
          process.stdout.write(`浏览器未自动打开，请访问：${url}\n`);
        }
      })
    : undefined;
  let fallbackDirectory: string | undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await new WechatPairingService(
      paths.config,
      new IlinkQrLogin(new IlinkHttpClient({ baseUrl }), credentials),
      credentials,
      configDocumentStore(paths.config)
    ).pair({
      baseUrl,
      credentialReference,
      gatewayUserId: options.get("gateway-user") ?? "primary-owner",
      signal: controller.signal,
      display: async (content) => {
        if (qrOutput !== undefined) {
          await (process.platform === "win32" ? renderWindowsQr : renderQr)(content, qrOutput);
          process.stdout.write(`QR_READY ${qrOutput}\n`);
          return;
        }
        try {
          const url = await presenter!.show(content);
          process.stdout.write(`PAIRING_PAGE ${url}\n`);
        } catch {
          fallbackDirectory = await mkdtemp(join(tmpdir(), "agentlink-pair-fallback-"));
          await chmod(fallbackDirectory, 0o700);
          const fallbackPath = join(
            fallbackDirectory,
            process.platform === "win32" ? "wechat-login.svg" : "wechat-login.png"
          );
          await (process.platform === "win32" ? renderWindowsQr : renderQr)(content, fallbackPath);
          await chmod(fallbackPath, 0o600);
          process.stdout.write(`浏览器配对页不可用，请打开临时二维码：${fallbackPath}\n`);
        }
      }
    });
    await presenter?.finish("paired");
    const serviceStatus = process.platform === "darwin"
      ? await new LaunchAgentService({ paths }).status()
      : { loaded: false };
    const pairedConfig = await configDocumentStore(paths.config).load();
    const hasAgent = pairedConfig.codex !== undefined ||
      pairedConfig.grok !== undefined ||
      pairedConfig.claude !== undefined;
    if (serviceStatus.loaded && hasAgent && process.platform === "darwin") {
      await new LaunchAgentService({ paths }).restart();
    }
    const windowsAutoReloadHint =
      process.platform === "win32" && hasAgent
        ? "正在运行的前台 Gateway 会自动加载微信渠道，无需手动重启"
        : undefined;
    writeOutput(options, {
      status: "paired",
      ...result,
      gatewayRestarted: serviceStatus.loaded && hasAgent,
      ...(hasAgent
        ? (windowsAutoReloadHint === undefined ? {} : { nextAction: windowsAutoReloadHint })
        : { nextAction: "尚未配置Agent，请执行 agentlink agent configure" })
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "pairing failed";
    await presenter?.finish(
      /expired/iu.test(message) ? "expired" : controller.signal.aborted ? "cancelled" : "failed"
    ).catch(() => undefined);
    throw error;
  } finally {
    await presenter?.close().catch(() => undefined);
    if (fallbackDirectory !== undefined) {
      await rm(fallbackDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function runSession(args: string[]): Promise<number> {
  const action = args.shift();
  if (["show", "archive", "unarchive", "delete", "detach"].includes(action ?? "")) {
    const sessionId = args.shift();
    if (sessionId === undefined) throw new Error(`session ${String(action)} requires a Session ID`);
    const options = parseOptions(args);
    assertAllowedOptions(options, ["socket", "endpoint", "confirm"]);
    if (action === "delete" && !options.has("confirm")) {
      throw new Error("session delete requires --confirm");
    }
    if (action !== "delete" && options.has("confirm")) {
      throw new Error(`session ${String(action)} does not accept --confirm`);
    }
    const socket = options.get("socket") ?? applicationPaths().socket;
    const endpointId = options.get("endpoint") ?? "local-cli";
    writeOutput(options, await sendControlEvent(socket, {
      endpointId,
      kind: `session_${action}` as
        "session_show" | "session_archive" | "session_unarchive" |
        "session_delete" | "session_detach",
      sessionId
    }));
    return 0;
  }
  const options = parseOptions(args);
  assertAllowedOptions(
    options,
    ["project", "agent", "socket", "endpoint", "number", "archived", "all"]
  );
  const socket = options.get("socket") ?? applicationPaths().socket;
  const endpointId = options.get("endpoint") ?? "local-cli";
  if (action === "list") {
    if (options.has("number") || options.has("agent")) {
      throw new Error("session list does not accept --number or --agent");
    }
    if (options.has("archived") && options.has("all")) {
      throw new Error("session list accepts only one of --archived or --all");
    }
    writeOutput(options, await sendControlEvent(socket, {
      endpointId,
      kind: "session_list",
      ...(options.get("project") === undefined ? {} : { project: options.get("project")! }),
      scope: options.has("all") ? "all" : options.has("archived") ? "archived" : "active"
    }));
    return 0;
  }
  const project = requiredOption(options, "project");
  const agent = parseOptionalAgent(options.get("agent"));
  if (action === "discover") {
    if (options.has("number") || options.has("archived") || options.has("all")) {
      throw new Error("session discover accepts only project, agent, socket and endpoint options");
    }
    writeOutput(options, await sendControlEvent(socket, {
      endpointId,
      kind: "session_discover",
      project,
      ...(agent === undefined ? {} : { agent })
    }));
    return 0;
  }
  if (action === "import") {
    if (options.has("archived") || options.has("all")) {
      throw new Error("session import does not accept list scope options");
    }
    const reference = requiredOption(options, "number");
    if (!/^[1-9]\d*$/u.test(reference)) {
      throw new Error("--number must be a positive list number");
    }
    writeOutput(options, await sendControlEvent(socket, {
      endpointId,
      kind: "session_import",
      project,
      reference,
      ...(agent === undefined ? {} : { agent })
    }));
    return 0;
  }
  usage(process.stderr);
  return 2;
}

async function runAttach(args: string[]): Promise<number> {
  const sessionId = args.shift();
  const options = parseOptions(args);
  assertAllowedOptions(options, ["socket", "endpoint", "text"]);
  if (sessionId === undefined) throw new Error("attach requires a Session ID");
  const socket = options.get("socket") ?? applicationPaths().socket;
  const endpoint = options.get("endpoint") ?? "local-cli";
  const text = options.get("text");
  if (text !== undefined) {
    writeOutput(options, await sendControlEvent(socket, {
      endpointId: endpoint,
      sessionId,
      text,
      kind: "input"
    }));
    return 0;
  }
  if (await lstat(socket).catch(() => undefined) === undefined) {
    throw new Error("AgentLink Gateway socket is not available");
  }
  process.stdout.write("Attached. Enter one line per Turn; Ctrl-D exits.\n");
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    for (const line of chunk.split(/\r?\n/u).filter(Boolean)) {
      writeOutput(options, await sendControlEvent(socket, {
        endpointId: endpoint,
        sessionId,
        text: line,
        kind: "input"
      }));
    }
  }
  return 0;
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const name = value.slice(2);
    if (result.has(name)) throw new Error(`Option --${name} was provided more than once`);
    if (BOOLEAN_OPTIONS.has(name)) {
      result.set(name, "true");
      continue;
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new Error(`Option --${name} requires a value`);
    }
    result.set(name, optionValue);
    index += 1;
  }
  return result;
}

function parseAgents(value: string | undefined): readonly string[] {
  if (value === undefined) throw new Error("--agent is required");
  const agents = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (agents.length === 0) throw new Error("--agent requires at least one Agent");
  return agents;
}

function parseOptionalAgent(value: string | undefined): "codex" | "grok" | "claude" | undefined {
  if (value === undefined) return undefined;
  if (value !== "codex" && value !== "grok" && value !== "claude") {
    throw new Error("--agent must be codex, grok or claude");
  }
  return value;
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function assertAllowedOptions(
  options: ReadonlyMap<string, string>,
  allowed: readonly string[]
): void {
  const names = new Set(allowed);
  for (const name of options.keys()) {
    if (name !== "json" && !names.has(name)) throw new Error(`Unsupported option: --${name}`);
  }
}

function writeOutput(options: ReadonlyMap<string, string>, value: unknown): void {
  if (options.has("json")) {
    writeJson(value);
    return;
  }
  process.stdout.write(`${formatHumanOutput(value)}\n`);
}

function formatHumanOutput(value: unknown): string {
  const record = asRecord(value);
  if (record !== undefined && record["ok"] === true && record["result"] !== undefined) {
    return formatHumanOutput(record["result"]);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "暂无记录";
    const first = asRecord(value[0]);
    if (first?.["agent"] !== undefined && first["command"] !== undefined) return formatAgents(value);
    if (first?.["slug"] !== undefined && first["path"] !== undefined) return formatProjects(value);
    if (first?.["sessionId"] !== undefined) return formatSessions(value);
    return value.map((item, index) => `${index + 1}. ${formatHumanOutput(item)}`).join("\n");
  }
  if (record === undefined) return String(value);
  if (Array.isArray(record["result"]) && asRecord(record["result"][0])?.["sessionId"] !== undefined) {
    return formatSessions(record["result"]);
  }
  if (record["sessionId"] !== undefined) return formatSession(record);
  if (record["ok"] !== undefined && record["runtime"] !== undefined) return formatDoctor(record);
  if (record["agent"] !== undefined && record["capabilities"] !== undefined) {
    return `Agent：${String(record["agent"])}\n能力：${enabledCapabilities(record["capabilities"])} `;
  }
  if (record["channel"] !== undefined && record["status"] !== undefined) {
    return `渠道 ${String(record["channel"])}：${String(record["status"])} `;
  }
  if (record["installed"] !== undefined && record["loaded"] !== undefined) {
    return `服务：${record["loaded"] === true ? "运行中" : "未运行"}（${String(record["detail"] ?? "unknown")}）`;
  }
  if (record["status"] !== undefined) return formatStatus(record);
  return Object.entries(record).map(([key, item]) => `${key}：${formatScalar(item)}`).join("\n");
}

function formatAgents(value: readonly unknown[]): string {
  return [
    "Agent  状态      能力",
    ...value.map((item) => {
      const agent = asRecord(item)!;
      return `${String(agent["agent"])}  已配置    ${enabledCapabilities(agent["capabilities"])}`;
    })
  ].join("\n");
}

function formatProjects(value: readonly unknown[]): string {
  return [
    "项目        默认Agent  状态    路径",
    ...value.map((item) => {
      const project = asRecord(item)!;
      return `${String(project["slug"])}  ${String(project["defaultAgent"])}        ` +
        `${project["enabled"] === true ? "启用" : "停用"}  ${String(project["path"])} `;
    })
  ].join("\n");
}

function formatSessions(value: readonly unknown[]): string {
  return [
    "#  状态      Agent  来源  项目        最近      标题",
    ...value.map((item, index) => {
      const session = asRecord(item)!;
      return `${index + 1}. ${sessionStatus(session)}  ${String(session["agent"])}  ` +
        `${session["nativeLifecycleOwner"] === "EXTERNAL" ? "ORG" : "AGL"}   ` +
        `${String(session["project"])}  ${relativeTime(String(session["lastActivityAt"] ?? ""))}  ` +
        `${truncate(String(session["displayName"]), 32)}\n   ID: ${String(session["sessionId"])} `;
    }),
    "详情：agentlink session show <完整ID>；机器可读：agentlink session list --json"
  ].join("\n");
}

function formatSession(session: Readonly<Record<string, unknown>>): string {
  return [
    `会话：${String(session["displayName"] ?? session["sessionId"] ?? "未知")}`,
    `状态：${sessionStatus(session)}`,
    `Agent：${String(session["agent"] ?? "?")} · 项目：${String(session["project"] ?? "?")}`,
    `ID：${String(session["sessionId"] ?? "?")}`
  ].join("\n");
}

function formatDoctor(value: Readonly<Record<string, unknown>>): string {
  const runtime = asRecord(value["runtime"]);
  const service = asRecord(value["service"]);
  const channel = asRecord(value["channel"]);
  const runtimeDistribution = runtime?.["releaseVersion"] ?? runtime?.["distribution"] ?? "未安装";
  return [
    `诊断：${value["ok"] === true ? "通过" : "发现问题"}`,
    `运行时：${String(runtime?.["version"] ?? "未知")} · ${String(runtimeDistribution)}`,
    `服务：${service?.["loaded"] === true ? "运行中" : "未运行"}`,
    `微信：${String(channel?.["status"] ?? "未知")}`,
    "详情：agentlink doctor --json"
  ].join("\n");
}

function formatStatus(value: Readonly<Record<string, unknown>>): string {
  const status = String(value["status"]);
  const nextAction = typeof value["nextAction"] === "string"
    ? `\n下一步：${value["nextAction"]}`
    : "";
  const project = asRecord(value["project"]);
  if (project !== undefined) return `项目已${status}：${String(project["slug"])}${nextAction}`;
  const agent = value["agent"];
  return agent === undefined
    ? `操作完成：${status}${nextAction}`
    : `Agent ${String(agent)}：${status}${nextAction}`;
}

function sessionStatus(session: Readonly<Record<string, unknown>>): string {
  if (session["state"] === "OPEN" && session["runtimeState"] === "ALIVE") return "可用";
  if (session["state"] === "CLOSED") return "已关闭";
  if (session["state"] === "UNKNOWN") {
    return session["nativeThreadId"] === null || session["nativeThreadId"] === undefined
      ? "不可恢复"
      : "待核实";
  }
  return String(session["state"] ?? "未知");
}

function enabledCapabilities(value: unknown): string {
  const capabilities = asRecord(value);
  if (capabilities === undefined) return "未知";
  return Object.entries(capabilities)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name)
    .join(", ") || "无";
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "未知";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}小时前`;
  return `${Math.floor(seconds / 86_400)}天前`;
}

function truncate(value: string, limit: number): string {
  const points = [...value];
  return points.length <= limit ? value : `${points.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function formatScalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function renderQr(content: string, outputPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      new URL("./platform-macos/agentlink-qr-code-renderer", import.meta.url).pathname,
      [outputPath],
      { shell: false, stdio: ["pipe", "ignore", "pipe"], env: {} }
    );
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic = `${diagnostic}${String(chunk)}`.slice(0, 512);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === null && code === 0) resolvePromise();
      else reject(new Error(
        `QR renderer failed: code=${String(code)} signal=${String(signal)} ${diagnostic}`
      ));
    });
    child.stdin.end(content, "utf8");
  });
}

function usage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    "AgentLink 本机控制命令\n\n" +
    "常用\n" +
    "  agentlink --version | -v\n" +
    "  agentlink doctor\n" +
    "  agentlink status | start | stop | restart | logs [--lines <n>]\n" +
    "  agentlink pair wechat\n" +
    "  agentlink channel status wechat\n\n" +
    "Agent 配置\n" +
    "  agentlink agent list\n" +
    "  agentlink agent status <codex|grok|claude>\n" +
    "  agentlink agent capabilities <codex|grok|claude>\n" +
    "  agentlink agent configure <codex|grok|claude> --command <绝对路径>\n" +
    "  agentlink agent remove <codex|grok|claude> --confirm-local\n\n" +
    "项目\n" +
    "  agentlink project list|add|update|disable|enable|remove\n\n" +
    "会话\n" +
    "  agentlink session discover --project <slug> [--agent <codex|grok>]\n" +
    "  agentlink session import --project <slug> --number <n> [--agent <codex|grok>]\n" +
    "  agentlink session list [--project <slug>] [--archived|--all]\n" +
    "  agentlink session show|archive|unarchive|detach <session-id>\n" +
    "  agentlink session delete <session-id> --confirm\n" +
    "  agentlink attach <session-id> [--socket <path>] [--endpoint <id>] [--text <text>]\n\n" +
    "维护\n" +
    "  agentlink service install --release <目录> --confirm-local\n" +
    "  agentlink service uninstall --confirm-local\n" +
    "  agentlink service purge --confirm-local --confirm-destroy-data [--credential-references <a,b>]\n" +
    "  agentlink service backup --output <file>\n" +
    "  agentlink service restore --input <file> --confirm-local\n\n" +
    "说明\n" +
    "  带 --confirm-local 或 --confirm 的命令会修改本机状态。\n" +
    "  使用 agentlink --help、agentlink -h 或 agentlink help 查看本帮助。\n"
  );
}

function subcommandHelp(command: string, args: readonly string[]): string | undefined {
  const requested = args.length === 1 && isHelpToken(args[0]);
  const action = args[0];
  const actionRequested = args.length === 2 && action !== undefined && isHelpToken(args[1]);
  if (!requested && !actionRequested) return undefined;
  const target = actionRequested ? `${command} ${action}` : command;
  return commandUsage[target] ?? commandUsage[command];
}

function isHelpToken(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

const commandUsage: Readonly<Record<string, string>> = {
  agent: [
    "用法：agentlink agent <命令> [选项]",
    "",
    "命令：list、status <codex|grok|claude>、capabilities <codex|grok|claude>",
    "      configure <codex|grok|claude> --command <绝对路径> [--isolated-home-root <路径>]",
    "      remove <codex|grok|claude> --confirm-local",
    "选项：--json"
  ].join("\n"),
  project: [
    "用法：agentlink project <命令> [选项]",
    "",
    "命令：list、add、update、enable、disable、remove",
    "提示：使用 agentlink project <命令> --help 查看参数。",
    "选项：--json"
  ].join("\n"),
  "project add": [
    "用法：agentlink project add --slug <名称> --path <绝对路径> --agent <codex,grok> [--default-agent <codex|grok>]",
    "示例：agentlink project add --slug myproject --path /Users/me/work/myproject --agent codex,grok --default-agent codex",
    "选项：--json"
  ].join("\n"),
  "project update": "用法：agentlink project update --slug <名称> --path <绝对路径> --agent <codex,grok> [--default-agent <codex|grok>] [--json]",
  "project enable": "用法：agentlink project enable --slug <名称> [--json]",
  "project disable": "用法：agentlink project disable --slug <名称> [--json]",
  "project remove": "用法：agentlink project remove --slug <名称> [--json]",
  service: "用法：agentlink service <install|uninstall|purge|backup|restore> [选项]\n提示：运行状态请使用 agentlink status|start|stop|restart。",
  session: "用法：agentlink session <list|show|discover|import|archive|unarchive|delete|detach> [选项]\n提示：使用 agentlink session <命令> --help 查看参数。",
  "session list": "用法：agentlink session list [--project <slug>] [--archived|--all] [--json]",
  "session show": "用法：agentlink session show <session-id> [--json]",
  "session discover": "用法：agentlink session discover --project <slug> [--agent <codex|grok>] [--json]",
  "session import": "用法：agentlink session import --project <slug> --number <n> [--agent <codex|grok>] [--json]",
  attach: "用法：agentlink attach <session-id> [--text <内容>] [--json]",
  doctor: "用法：agentlink doctor [--json]",
  logs: "用法：agentlink logs [--lines <n>] [--json]",
  channel: "用法：agentlink channel status wechat [--json]"
};

const entrypoint = process.argv[1];
const entrypointPath = entrypoint === undefined ? undefined : resolve(entrypoint);
const modulePath = fileURLToPath(import.meta.url);
const canonicalEntrypointPath = entrypointPath === undefined
  ? undefined
  : canonicalPath(entrypointPath);
const canonicalModulePath = canonicalPath(modulePath);
const isEntrypoint = entrypointPath !== undefined && (
  canonicalEntrypointPath !== undefined && (
    process.platform === "win32"
      ? canonicalEntrypointPath.toLowerCase() === canonicalModulePath.toLowerCase()
        || basename(entrypointPath).toLowerCase() === "ctl.js"
      : canonicalEntrypointPath === canonicalModulePath
  )
);
if (isEntrypoint) {
  try {
    process.exitCode = await runCtl(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "agentlink failed"}\n`
    );
    process.exitCode = 1;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
