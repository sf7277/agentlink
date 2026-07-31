import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  RealClaudeSdkClient,
  allowedClaudeEnvironment
} from "../sdk/real-claude-sdk-client.js";
import {
  assertSupportedClaudeVersion,
  readClaudeVersion
} from "../protocol/version-gate.js";
import type { ClaudeSdkClient } from "../sdk/claude-sdk-client.js";

/**
 * The Claude "runtime" is the pinned Agent SDK plus the shared user Claude
 * home; there is no long-lived shared subprocess (each session owns its own
 * SDK-managed claude process, mirroring the IsolatedCodexAdapter topology).
 */

export const CLAUDE_SDK_MINIMUM_VERSION = "0.3.220";

export interface ClaudeRuntimeOptions {
  /** Absolute path to the user's Claude Code CLI. */
  readonly command: string;
  /** Override for tests only; production always shares the user's ~/.claude. */
  readonly claudeHome?: string;
}

export interface ClaudeRuntime {
  readonly client: ClaudeSdkClient;
  readonly claudeHome: string;
  readonly sdkVersion: string;
  readonly cliVersion: string;
  close(): Promise<void>;
}

export function readClaudeSdkVersion(): string {
  // The SDK's exports map does not expose ./package.json; resolve the entry
  // module and read the manifest beside it instead.
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const manifest = JSON.parse(
    readFileSync(join(dirname(entry), "package.json"), "utf8")
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("Claude Agent SDK package version is unreadable");
  }
  return manifest.version;
}

export function assertSupportedClaudeSdkVersion(version: string): void {
  if (compareVersions(version, CLAUDE_SDK_MINIMUM_VERSION) < 0) {
    throw new Error(
      `Claude Agent SDK ${version} is below the verified minimum ${CLAUDE_SDK_MINIMUM_VERSION}`
    );
  }
}

export function defaultClaudeHome(): string {
  return join(homedir(), ".claude");
}

export async function startClaudeRuntime(
  options: ClaudeRuntimeOptions
): Promise<ClaudeRuntime> {
  const sdkVersion = readClaudeSdkVersion();
  assertSupportedClaudeSdkVersion(sdkVersion);
  // AgentLink runs the user's own CLI, so its version must be gated the same
  // way Codex and Grok are; a drifting CLI must fail loudly, not silently.
  const cliVersion = await readClaudeVersion(options.command);
  assertSupportedClaudeVersion(cliVersion);
  const client = new RealClaudeSdkClient({
    environment: allowedClaudeEnvironment(),
    claudeExecutablePath: options.command
  });
  return {
    client,
    claudeHome: options.claudeHome ?? defaultClaudeHome(),
    sdkVersion,
    cliVersion: cliVersion.raw,
    // Terminates every live per-session subprocess started by this client.
    close: async () => {
      await client.close();
    }
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}
