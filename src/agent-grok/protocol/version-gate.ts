import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GrokVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

/** Probe baseline from task 15 / ADR 0005. */
export const GROK_MINIMUM_VERSION = "0.2.106";

export function parseGrokVersion(output: string): GrokVersion {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(output.trim());
  if (match === null) throw new Error(`Unrecognized Grok version output: ${output.trim()}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: `${match[1]}.${match[2]}.${match[3]}`
  };
}

export function assertSupportedGrokVersion(
  version: GrokVersion,
  minimum = GROK_MINIMUM_VERSION
): void {
  const min = parseGrokVersion(minimum);
  if (compareVersion(version, min) < 0) {
    throw new Error(`Grok ${version.raw} is below minimum ${min.raw}`);
  }
}

export async function readGrokVersion(command = "grok"): Promise<GrokVersion> {
  const { stdout } = await execFileAsync(command, ["--version"], {
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    env: { PATH: process.env["PATH"] ?? "" }
  });
  return parseGrokVersion(stdout);
}

function compareVersion(left: GrokVersion, right: GrokVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}
