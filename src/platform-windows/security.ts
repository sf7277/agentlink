import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, win32 } from "node:path";

const execFileAsync = promisify(execFile);
const BROAD_SIDS = new Set([
  "S-1-1-0",    // Everyone
  "S-1-5-11",   // Authenticated Users
  "S-1-5-32-545", // BUILTIN\\Users
  "S-1-5-32-546"  // BUILTIN\\Guests
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
  const powershell = `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=$env:AGENTLINK_SECURITY_PATH",
    "$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$acl=Get-Acl -LiteralPath $p -ErrorAction Stop",
    "$entries=@($acl.Access | ForEach-Object {",
    "  $sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "  [pscustomobject]@{sid=$sid;type=[string]$_.AccessControlType;rights=[string]$_.FileSystemRights}",
    "})",
    "[pscustomobject]@{currentSid=$current;entries=$entries} | ConvertTo-Json -Compress"
  ].join("\n");
  const result = await execFileAsync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], {
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
    env: {
      SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
      Path: process.env["Path"] ?? process.env["PATH"] ?? "",
      AGENTLINK_SECURITY_PATH: path
    }
  });
  const parsed = JSON.parse(result.stdout) as {
    readonly currentSid?: string;
    readonly entries?: ReadonlyArray<{
      readonly sid?: string;
      readonly type?: string;
    }>;
  };
  const entries = parsed.entries ?? [];
  if (parsed.currentSid === undefined ||
      !entries.some((entry) => entry.sid === parsed.currentSid && entry.type === "Allow")) {
    throw new Error(`AgentLink Windows ACL does not grant the current user access: ${path}`);
  }
  if (entries.some((entry) => entry.type === "Allow" && entry.sid !== undefined && BROAD_SIDS.has(entry.sid))) {
    throw new Error(`AgentLink Windows ACL grants broad user access: ${path}`);
  }
}
