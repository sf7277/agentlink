import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Creates a test directory with the same private ACL contract as AgentLink. */
export async function createPrivateTestRoot(prefix: string): Promise<string> {
  const base = process.platform === "win32"
    ? process.env["LOCALAPPDATA"]
    : tmpdir();
  if (base === undefined) throw new Error("A test application-data directory is required");
  const root = await realpath(await mkdtemp(join(base, prefix)));
  if (process.platform !== "win32") return root;

  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const environment = {
    SystemRoot: systemRoot,
    Path: process.env["Path"] ?? process.env["PATH"] ?? ""
  };
  try {
    const whoami = await execFileAsync(`${systemRoot}\\System32\\whoami.exe`, [
      "/user", "/fo", "csv", "/nh"
    ], { windowsHide: true, maxBuffer: 16 * 1024, env: environment });
    const currentSid = whoami.stdout.match(/S-1-[0-9-]+/u)?.[0];
    if (currentSid === undefined) throw new Error("Could not determine the current Windows SID");
    await execFileAsync(`${systemRoot}\\System32\\icacls.exe`, [
      root,
      "/inheritance:r",
      "/grant:r",
      `*${currentSid}:(OI)(CI)F`,
      "SYSTEM:(OI)(CI)F"
    ], { windowsHide: true, maxBuffer: 64 * 1024, env: environment });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
