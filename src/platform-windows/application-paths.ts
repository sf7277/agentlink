import { mkdir, lstat } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import type { ApplicationPaths } from "../platform/application-paths.js";
import { assertWindowsPrivatePath } from "./security.js";

export interface WindowsApplicationPaths extends ApplicationPaths {}

export function windowsApplicationPaths(
  localAppData = process.env["LOCALAPPDATA"]
): WindowsApplicationPaths {
  if (localAppData === undefined || !win32.isAbsolute(localAppData)) {
    throw new Error("A trusted absolute LOCALAPPDATA is required on Windows");
  }
  const root = win32.join(localAppData, "AgentLink");
  const runtime = win32.join(root, "run");
  return {
    applicationSupport: root,
    caches: win32.join(root, "cache"),
    logs: win32.join(root, "logs"),
    runtime,
    releases: win32.join(root, "releases"),
    backups: win32.join(root, "backups"),
    config: win32.join(root, "config.json"),
    database: win32.join(root, "agentlink.sqlite"),
    socket: "\\\\.\\pipe\\agentlink-gateway",
    launchAgent: win32.join(runtime, "windows-service-not-supported")
  };
}

export async function ensureWindowsApplicationPaths(
  paths: WindowsApplicationPaths
): Promise<void> {
  for (const directory of [
    paths.applicationSupport,
    paths.caches,
    paths.logs,
    paths.runtime,
    paths.releases,
    paths.backups
  ]) {
    await mkdir(directory, { recursive: true });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing non-directory AgentLink path: ${directory}`);
    }
    await assertWindowsPrivatePath(directory, "directory");
  }
  await mkdir(dirname(paths.config), { recursive: true });
}
