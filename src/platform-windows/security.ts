import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, win32 } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const BROAD_SIDS = new Set([
  "S-1-1-0",    // Everyone
  "S-1-5-11",   // Authenticated Users
  "S-1-5-32-545", // BUILTIN\\Users
  "S-1-5-32-546",  // BUILTIN\\Guests
  "WD",          // Everyone (SDDL alias)
  "AU",          // Authenticated Users (SDDL alias)
  "BU",          // BUILTIN\\Users (SDDL alias)
  "BG"           // BUILTIN\\Guests (SDDL alias)
]);

export async function assertWindowsPrivatePath(
  path: string,
  kind: "file" | "directory"
): Promise<void> {
  if (process.platform !== "win32") return;
  const metadata = await lstat(path);
  if ((kind === "file" && !metadata.isFile()) ||
      (kind === "directory" && !metadata.isDirectory()) ||
      metadata.isSymbolicLink()) {
    throw new Error(`AgentLink Windows path is not a trusted ${kind}: ${path}`);
  }
  const canonical = await realpath(path);
  await assertNoReparsePointAncestors(path);
  await assertWindowsPrivateAcl(canonical);
}

/**
 * Reject paths whose directory chain contains a symlink or junction. The
 * final component itself is already checked by the caller; ancestors are
 * scanned because Windows junctions hide under the target path's parent
 * directories. Comparing realpath() against the literal input is unreliable
 * here because 8.3 short names expand differently (e.g. ADMINI~1).
 */
async function assertNoReparsePointAncestors(path: string): Promise<void> {
  const root = win32.parse(path).root;
  let current = dirname(path);
  while (true) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`AgentLink Windows path traverses a reparse-point alias: ${current}`);
    }
    if (current.toLowerCase() === root.toLowerCase()) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function assertWindowsPrivateAcl(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const descriptor = await readWindowsSecurityDescriptor(path);
  const allowSids: string[] = [];
  for (const match of descriptor.sddl.matchAll(/\(([^)]+)\)/gu)) {
    const fields = match[1]!.split(";");
    if (fields[0] === "A") allowSids.push(fields.at(-1)!);
  }
  if (!allowSids.includes(descriptor.currentSid)) {
    throw new Error(`AgentLink Windows ACL does not grant the current user access: ${path}`);
  }
  if (allowSids.some((sid) => BROAD_SIDS.has(sid))) {
    throw new Error(`AgentLink Windows ACL grants broad user access: ${path}`);
  }
}

async function readWindowsSecurityDescriptor(path: string): Promise<{
  readonly currentSid: string;
  readonly sddl: string;
}> {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const environment = {
    SystemRoot: systemRoot,
    Path: process.env["Path"] ?? process.env["PATH"] ?? ""
  };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agentlink-acl-"));
  const savedAcl = join(temporaryRoot, "acl.txt");
  try {
    const icacls = `${systemRoot}\\System32\\icacls.exe`;
    await execFileAsync(icacls, [path, "/save", savedAcl, "/c"], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: environment
    });
    const current = await execFileAsync(`${systemRoot}\\System32\\whoami.exe`, [
      "/user", "/fo", "csv", "/nh"
    ], {
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 16 * 1024,
      env: environment
    });
    const currentSid = current.stdout.match(/S-1-[0-9-]+/u)?.[0];
    if (currentSid === undefined) throw new Error("Could not determine the current Windows SID");
    const bytes = await readFile(savedAcl);
    const text = bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder("utf-16le").decode(bytes.subarray(2))
      : bytes.toString("utf8");
    const sddl = text.match(/D:[^\r\n]+/u)?.[0];
    if (sddl === undefined) throw new Error("Could not read the Windows security descriptor");
    return { currentSid, sddl };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
