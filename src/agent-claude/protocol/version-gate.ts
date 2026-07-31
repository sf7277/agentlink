import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Minimum Claude Code CLI verified against the pinned Agent SDK.
 * Bump together with the SDK version after re-running the task18 Phase B
 * probes (task14 long-term maintenance check).
 */
export const CLAUDE_MINIMUM_VERSION = "2.1.220";

export interface ClaudeVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parses `2.1.220 (Claude Code)` as printed by `claude --version`. */
export function parseClaudeVersion(raw: string): ClaudeVersion {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(raw.trim());
  if (match === null) {
    throw new Error(`Claude Code version is unreadable: ${raw.trim().slice(0, 120)}`);
  }
  return {
    raw: raw.trim(),
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10)
  };
}

export function assertSupportedClaudeVersion(
  version: ClaudeVersion,
  minimum = CLAUDE_MINIMUM_VERSION
): void {
  const min = parseClaudeVersion(minimum);
  const ordered = [
    [version.major, min.major],
    [version.minor, min.minor],
    [version.patch, min.patch]
  ] as const;
  for (const [actual, required] of ordered) {
    if (actual > required) return;
    if (actual < required) {
      throw new Error(`Claude Code ${version.raw} is below minimum ${min.raw}`);
    }
  }
}

export async function readClaudeVersion(command: string): Promise<ClaudeVersion> {
  const { stdout } = await execFileAsync(command, ["--version"], {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    // The version probe must not inherit ambient configuration.
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      TMPDIR: process.env["TMPDIR"] ?? "/tmp",
      USER: process.env["USER"] ?? ""
    }
  });
  return parseClaudeVersion(stdout);
}
