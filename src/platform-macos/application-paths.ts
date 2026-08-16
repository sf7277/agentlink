import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ApplicationPaths } from "../platform/application-paths.js";

export interface MacosApplicationPaths extends ApplicationPaths {}

export function macosApplicationPaths(home = process.env["HOME"]): MacosApplicationPaths {
  if (home === undefined || !home.startsWith("/")) {
    throw new Error("A trusted absolute HOME is required");
  }
  const trustedHome = realpathSync(resolve(home));
  const applicationSupport = join(trustedHome, "Library", "Application Support", "AgentLink");
  const caches = join(trustedHome, "Library", "Caches", "AgentLink");
  const logs = join(trustedHome, "Library", "Logs", "AgentLink");
  const runtime = join(applicationSupport, "run");
  return {
    applicationSupport,
    caches,
    logs,
    runtime,
    releases: join(applicationSupport, "releases"),
    backups: join(applicationSupport, "backups"),
    config: join(applicationSupport, "config.json"),
    database: join(applicationSupport, "agentlink.sqlite"),
    socket: join(runtime, "gateway.sock"),
    launchAgent: join(trustedHome, "Library", "LaunchAgents", "com.agentlink.gateway.plist")
  };
}

export async function ensureMacosApplicationPaths(paths: MacosApplicationPaths): Promise<void> {
  for (const path of [
    paths.applicationSupport,
    paths.caches,
    paths.logs,
    paths.runtime,
    paths.releases,
    paths.backups
  ]) {
    await ensurePrivateDirectory(path);
  }
  await mkdir(dirname(paths.launchAgent), { recursive: true });
}

export async function assertPrivateOwnedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0 ||
    await realpath(path) !== resolve(path)
  ) {
    throw new Error(`AgentLink directory is not private and canonical: ${path}`);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing non-directory AgentLink path: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`AgentLink path belongs to another user: ${path}`);
  }
  await chmod(path, 0o700);
  await assertPrivateOwnedDirectory(path);
}
