import { captureCommandOutput } from "../../platform-windows/process-control.js";

/**
 * Minimum Claude Code CLI verified against the pinned Agent SDK.
 * Bump together with the SDK version after re-running the native compatibility
 * probes and release checks.
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
  const stdout = await captureCommandOutput(command, ["--version"], {
    timeoutMs: 30_000,
    maxBytes: 64 * 1024,
    // The version probe must not inherit ambient configuration.
    env: process.platform === "win32"
      ? {
        Path: process.env["Path"] ?? process.env["PATH"] ?? "",
        USERPROFILE: process.env["USERPROFILE"] ?? "",
        LOCALAPPDATA: process.env["LOCALAPPDATA"] ?? "",
        TEMP: process.env["TEMP"] ?? "",
        TMP: process.env["TMP"] ?? ""
      }
      : {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        TMPDIR: process.env["TMPDIR"] ?? "/tmp",
        USER: process.env["USER"] ?? ""
      }
  });
  return parseClaudeVersion(stdout);
}
