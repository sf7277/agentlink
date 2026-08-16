import { lstat, open } from "node:fs/promises";
import Database from "better-sqlite3";
import {
  assertSupportedClaudeSdkVersion,
  readClaudeSdkVersion
} from "../agent-claude/supervisor/runtime.js";
import {
  assertSupportedClaudeVersion,
  readClaudeVersion
} from "../agent-claude/protocol/version-gate.js";
import type { GatewayConfig } from "../composition/config-schema.js";
import type { ApplicationPaths } from "../platform/application-paths.js";
import { configDocumentStore } from "../platform/factory.js";
import {
  MANAGED_LOG_HISTORY,
  MANAGED_LOG_MAX_BYTES,
  MANAGED_LOG_RECORD_MAX_BYTES
} from "../platform-macos/managed-log-sink.js";
import { sendControlEvent } from "../local-control/client/control-client.js";
import { captureCommandOutput } from "./process-control.js";

export async function diagnoseWindowsAgentLink(
  paths: ApplicationPaths
): Promise<Readonly<Record<string, unknown>>> {
  let config: GatewayConfig | undefined;
  let configError: string | undefined;
  try {
    config = await configDocumentStore(paths.config).load();
  } catch (error) {
    configError = error instanceof Error ? error.message : "Config check failed";
  }

  const control = await readControlStatus(paths.socket);
  const service = {
    installed: await isDirectory(paths.applicationSupport),
    loaded: control.loaded,
    detail: control.loaded ? "foreground_loaded" : "foreground_not_loaded"
  };
  const database = await readDatabaseStatus(paths.database);
  const logs = await managedLogStatus(paths.logs);
  const agents = await readAgentStatuses(config);
  const agentsHealthy = Object.keys(agents).length > 0 &&
    Object.values(agents).every((value) => typeof value === "string");
  const channel = control.channel;
  const channelHealthy = config?.wechat === undefined || channel === "HEALTHY";
  const socket = control.loaded ? "ok" : "missing";
  const runtime = {
    status: control.loaded ? "ok" : "failed",
    mode: "foreground",
    platform: "win32",
    version: process.versions.node,
    distribution: "npm"
  };

  return {
    ok: service.installed && service.loaded && config !== undefined &&
      database === "ok" && socket === "ok" && agentsHealthy &&
      logs.status === "ok" && channelHealthy,
    node: process.versions.node,
    runtime,
    logs,
    channel: { channel: "wechat", status: channel },
    service,
    config: config === undefined ? { status: "failed", error: configError } : {
      status: "ok",
      projects: config.projects.length,
      wechatConfigured: config.wechat !== undefined,
      codexConfigured: config.codex !== undefined,
      grokConfigured: config.grok !== undefined,
      claudeConfigured: config.claude !== undefined
    },
    database,
    socket,
    agents,
    codex: agents["codex"] ?? { status: "failed", error: "not configured" },
    grok: agents["grok"] ?? { status: "failed", error: "not configured" },
    claude: agents["claude"] ?? { status: "failed", error: "not configured" }
  };
}

export async function readWindowsAgentLinkLogs(
  paths: ApplicationPaths,
  lines = 200
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
    throw new Error("Log line count must be between 1 and 10000");
  }
  return {
    stdout: await readPrivateTail(`${paths.logs}\\gateway.stdout.log`, lines),
    stderr: await readPrivateTail(`${paths.logs}\\gateway.stderr.log`, lines)
  };
}

async function readControlStatus(endpoint: string): Promise<{
  readonly loaded: boolean;
  readonly channel: string;
}> {
  try {
    const response = await sendControlEvent(endpoint, {
      endpointId: "local-cli",
      kind: "channel_status",
      channel: "wechat"
    }) as {
      readonly ok?: boolean;
      readonly result?: { readonly status?: unknown };
    };
    return {
      loaded: response.ok === true,
      channel: response.ok === true && typeof response.result?.status === "string"
        ? response.result.status
        : "UNKNOWN"
    };
  } catch {
    return { loaded: false, channel: "UNKNOWN" };
  }
}

async function readDatabaseStatus(path: string): Promise<string> {
  if (await optionalMetadata(path) === undefined) return "missing";
  try {
    const database = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return database.pragma("integrity_check", { simple: true }) === "ok" ? "ok" : "failed";
    } finally {
      database.close();
    }
  } catch {
    return "failed";
  }
}

async function readAgentStatuses(
  config: GatewayConfig | undefined
): Promise<Record<string, string | { readonly status: "failed"; readonly error: string }>> {
  const agents: Record<string, string | { readonly status: "failed"; readonly error: string }> = {};
  for (const agent of ["codex", "grok"] as const) {
    const configured = config?.[agent];
    if (configured === undefined) continue;
    try {
      agents[agent] = await readAgentVersion(configured.command);
    } catch (error) {
      agents[agent] = {
        status: "failed",
        error: error instanceof Error ? error.message : `${agent} version check failed`
      };
    }
  }
  if (config?.claude !== undefined) {
    try {
      const cli = await readClaudeVersion(config.claude.command);
      assertSupportedClaudeVersion(cli);
      const sdk = readClaudeSdkVersion();
      assertSupportedClaudeSdkVersion(sdk);
      agents["claude"] = `claude ${cli.raw} · sdk ${sdk}`;
    } catch (error) {
      agents["claude"] = {
        status: "failed",
        error: error instanceof Error ? error.message : "claude version check failed"
      };
    }
  }
  return agents;
}

async function readAgentVersion(command: string): Promise<string> {
  const path = process.env["Path"] ?? process.env["PATH"] ?? "";
  const stdout = await captureCommandOutput(command, ["--version"], {
    timeoutMs: 5_000,
    maxBytes: 16 * 1024,
    env: {
      Path: path,
      USERPROFILE: process.env["USERPROFILE"] ?? "",
      LOCALAPPDATA: process.env["LOCALAPPDATA"] ?? "",
      TEMP: process.env["TEMP"] ?? "",
      TMP: process.env["TMP"] ?? ""
    }
  });
  return stdout.trim().slice(0, 200);
}

async function managedLogStatus(logDirectory: string): Promise<Readonly<Record<string, unknown>>> {
  const streams: Record<string, unknown> = {};
  let healthy = true;
  for (const stream of ["stdout", "stderr"] as const) {
    const files: Array<{ path: string; size: number; safe: boolean }> = [];
    for (let index = 0; index <= MANAGED_LOG_HISTORY; index += 1) {
      const path = `${logDirectory}\\gateway.${stream}.log${index === 0 ? "" : `.${index}`}`;
      const metadata = await optionalMetadata(path);
      if (metadata === undefined) {
        if (index === 0) healthy = false;
        continue;
      }
      const safe = metadata.isFile() && !metadata.isSymbolicLink() &&
        metadata.size <= MANAGED_LOG_MAX_BYTES;
      if (!safe) healthy = false;
      files.push({ path, size: metadata.size, safe });
    }
    streams[stream] = files;
  }
  return {
    status: healthy ? "ok" : "unsafe",
    maxFileBytes: MANAGED_LOG_MAX_BYTES,
    historyFiles: MANAGED_LOG_HISTORY,
    maxRecordBytes: MANAGED_LOG_RECORD_MAX_BYTES,
    streams
  };
}

async function readPrivateTail(path: string, lines: number): Promise<string> {
  const metadata = await optionalMetadata(path);
  if (metadata === undefined) return "";
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MANAGED_LOG_MAX_BYTES) {
    throw new Error("AgentLink log is not a trusted Windows regular file");
  }
  const bytes = Math.min(metadata.size, 256 * 1024);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, metadata.size - bytes);
    return buffer.toString("utf8").split(/\r?\n/u).slice(-lines - 1).join("\n");
  } finally {
    await handle.close();
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const metadata = await optionalMetadata(path);
  return metadata?.isDirectory() === true && metadata.isSymbolicLink() === false;
}

async function optionalMetadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
