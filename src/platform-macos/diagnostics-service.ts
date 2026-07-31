import { execFile } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import type { GatewayConfig } from "../composition/config-schema.js";
import {
  assertSupportedClaudeSdkVersion,
  readClaudeSdkVersion
} from "../agent-claude/supervisor/runtime.js";
import {
  assertSupportedClaudeVersion,
  readClaudeVersion
} from "../agent-claude/protocol/version-gate.js";
import { AtomicConfigStore } from "./atomic-config-store.js";
import type {
  MacosApplicationPaths
} from "./application-paths.js";
import type { ServiceStatus } from "./launch-agent-service.js";
import {
  MANAGED_LOG_HISTORY,
  MANAGED_LOG_MAX_BYTES,
  MANAGED_LOG_RECORD_MAX_BYTES
} from "./managed-log-sink.js";

const execFileAsync = promisify(execFile);

export interface StatusReader {
  status(): Promise<ServiceStatus>;
}

export async function readAgentLinkLogs(
  paths: MacosApplicationPaths,
  lines = 200
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
    throw new Error("Log line count must be between 1 and 10000");
  }
  return {
    stdout: await readPrivateTail(`${paths.logs}/gateway.stdout.log`, lines),
    stderr: await readPrivateTail(`${paths.logs}/gateway.stderr.log`, lines)
  };
}

export async function diagnoseAgentLink(
  paths: MacosApplicationPaths,
  service: StatusReader,
  runAgentVersion: (command: string, agent?: "codex" | "grok") => Promise<string> =
    defaultAgentVersion,
  readChannelStatus?: () => Promise<string>
): Promise<Readonly<Record<string, unknown>>> {
  const status = await service.status();
  let config: GatewayConfig | undefined;
  let configError: string | undefined;
  try {
    config = await new AtomicConfigStore(paths.config).load();
  } catch (error) {
    configError = error instanceof Error ? error.message : "Config check failed";
  }
  const socket = await optionalMetadata(paths.socket);
  let database = "missing";
  if (await optionalMetadata(paths.database) !== undefined) {
    try {
      const db = new Database(paths.database, { readonly: true, fileMustExist: true });
      try {
        const result = db.pragma("integrity_check", { simple: true });
        database = result === "ok" ? "ok" : "failed";
      } finally {
        db.close();
      }
    } catch {
      database = "failed";
    }
  }
  const agents: Record<string, string | { status: "failed"; error: string }> = {};
  for (const agent of ["codex", "grok"] as const) {
    const configured = config?.[agent];
    if (configured === undefined) continue;
    try {
      agents[agent] = await runAgentVersion(configured.command, agent);
    } catch (error) {
      agents[agent] = {
        status: "failed",
        error: error instanceof Error ? error.message : `${agent} version check failed`
      };
    }
  }
  if (config?.claude !== undefined) {
    // Health is the user's CLI version plus the pinned SDK version.
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
  const configuredAgentCount = Object.keys(agents).length;
  const agentsHealthy = configuredAgentCount > 0 &&
    Object.values(agents).every((value) => typeof value === "string");
  const runtime = await serviceRuntime(paths);
  const logs = await managedLogStatus(paths);
  let channel = config?.wechat === undefined ? "DISABLED" : "UNKNOWN";
  if (config?.wechat !== undefined && readChannelStatus !== undefined) {
    try {
      channel = await readChannelStatus();
    } catch {
      channel = "UNKNOWN";
    }
  }
  const channelHealthy = config?.wechat === undefined || channel === "HEALTHY";
  return {
    ok: status.installed &&
      status.loaded &&
      config !== undefined &&
      database === "ok" &&
      socket?.isSocket() === true &&
      agentsHealthy &&
      runtime.status === "ok" &&
      logs.status === "ok" &&
      channelHealthy,
    node: process.versions.node,
    runtime,
    logs,
    channel: { channel: "wechat", status: channel },
    service: status,
    config: config === undefined ? { status: "failed", error: configError } : {
      status: "ok",
      projects: config.projects.length,
      wechatConfigured: config.wechat !== undefined,
      codexConfigured: config.codex !== undefined,
      grokConfigured: config.grok !== undefined,
      claudeConfigured: config.claude !== undefined
    },
    database,
    socket: socket === undefined
      ? "missing"
      : socket.isSocket() && (socket.mode & 0o077) === 0
        ? "ok"
        : "unsafe",
    agents,
    codex: agents["codex"] ?? { status: "failed", error: "not configured" },
    grok: agents["grok"] ?? { status: "failed", error: "not configured" }
  };
}

async function serviceRuntime(paths: MacosApplicationPaths): Promise<Readonly<Record<string, unknown>>> {
  try {
    const plistMetadata = await lstat(paths.launchAgent);
    const uid = process.getuid?.();
    if (
      !plistMetadata.isFile() ||
      plistMetadata.isSymbolicLink() ||
      (uid !== undefined && plistMetadata.uid !== uid) ||
      (plistMetadata.mode & 0o077) !== 0 ||
      plistMetadata.size > 1024 * 1024
    ) {
      throw new Error("LaunchAgent plist is unsafe");
    }
    const plist = await readFile(paths.launchAgent, "utf8");
    const argumentsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u
      .exec(plist)?.[1];
    const encodedPath = argumentsBlock === undefined
      ? undefined
      : /<string>([\s\S]*?)<\/string>/u.exec(argumentsBlock)?.[1];
    if (encodedPath === undefined) throw new Error("LaunchAgent runtime path is missing");
    const configuredPath = decodeXml(encodedPath);
    const canonicalPath = await realpath(configuredPath);
    const metadata = await lstat(canonicalPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) {
      throw new Error("LaunchAgent runtime is not an executable regular file");
    }
    const version = (await execFileAsync(canonicalPath, ["--version"], {
      timeout: 5_000,
      maxBuffer: 1024,
      env: {}
    })).stdout.trim();
    const releasesRoot = await realpath(paths.releases);
    const releaseRelative = relative(releasesRoot, canonicalPath);
    const parts = releaseRelative.split("/");
    const installedRelease = (
      parts.length === 4 &&
      parts[0] !== "" &&
      parts[1] === "runtime" &&
      parts[2] === "bin" &&
      parts[3] === "node" &&
      !releaseRelative.startsWith("../")
    );
    return {
      status: installedRelease ? "ok" : "external",
      configuredPath,
      canonicalPath,
      version,
      installedRelease,
      ...(installedRelease ? { releaseVersion: parts[0] } : {})
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Runtime inspection failed"
    };
  }
}

async function managedLogStatus(paths: MacosApplicationPaths): Promise<Readonly<Record<string, unknown>>> {
  const streams: Record<string, unknown> = {};
  let healthy = true;
  for (const stream of ["stdout", "stderr"] as const) {
    const files: Array<{ path: string; size: number; safe: boolean }> = [];
    for (let index = 0; index <= MANAGED_LOG_HISTORY; index += 1) {
      const path = `${paths.logs}/gateway.${stream}.log${index === 0 ? "" : `.${index}`}`;
      const metadata = await optionalMetadata(path);
      if (metadata === undefined) {
        if (index === 0) healthy = false;
        continue;
      }
      const uid = process.getuid?.();
      const safe = metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        (uid === undefined || metadata.uid === uid) &&
        (metadata.mode & 0o077) === 0 &&
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

async function defaultAgentVersion(command: string): Promise<string> {
  const result = await execFileAsync(command, ["--version"], {
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    env: {
      HOME: process.env["HOME"] ?? "",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
    }
  });
  return result.stdout.trim().slice(0, 200);
}

async function readPrivateTail(path: string, lines: number): Promise<string> {
  const metadata = await optionalMetadata(path);
  if (metadata === undefined) return "";
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("AgentLink log is not a trusted private regular file");
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

async function optionalMetadata(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}
