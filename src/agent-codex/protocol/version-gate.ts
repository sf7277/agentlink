import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

export interface VersionSupport {
  readonly minimum: string;
  readonly verified: readonly string[];
}

export function parseCodexVersion(output: string): CodexVersion {
  const match = /codex-cli\s+(\d+)\.(\d+)\.(\d+)/u.exec(output.trim());
  if (match === null) throw new Error(`Unrecognized Codex version output: ${output.trim()}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`
  };
}

export function assertSupportedVersion(version: CodexVersion, support: VersionSupport): void {
  const minimum = parseCodexVersion(`codex-cli ${support.minimum}`);
  if (compareVersion(version, minimum) < 0) {
    throw new Error(`Codex ${version.raw} is below minimum ${minimum.raw}`);
  }
  if (version.major !== minimum.major || version.minor !== minimum.minor) {
    throw new Error(`Codex ${version.raw} requires a new compatibility review`);
  }
}

export async function readCodexVersion(command = "codex"): Promise<CodexVersion> {
  const { stdout } = await execFileAsync(command, ["--version"], {
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    env: { PATH: process.env["PATH"] ?? "" }
  });
  return parseCodexVersion(stdout);
}

function compareVersion(left: CodexVersion, right: CodexVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}
