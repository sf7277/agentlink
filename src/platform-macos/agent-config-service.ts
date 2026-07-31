import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { startCodexRuntime } from "../agent-codex/supervisor/runtime.js";
import { readCodexVersion } from "../agent-codex/protocol/version-gate.js";
import { startGrokRuntime } from "../agent-grok/supervisor/runtime.js";
import { readGrokVersion } from "../agent-grok/protocol/version-gate.js";
import { startClaudeRuntime } from "../agent-claude/supervisor/runtime.js";
import { AGENTLINK_VERSION } from "../version.js";
import { AtomicConfigStore } from "./atomic-config-store.js";

export type ConfigurableAgentKind = "codex" | "grok" | "claude";

export interface AgentVerification {
  readonly version: string;
}

export interface AgentCommandVerifier {
  verify(
    kind: ConfigurableAgentKind,
    command: string,
    probeRoot: string
  ): Promise<AgentVerification>;
}

export class AgentConfigService {
  public constructor(
    private readonly configPath: string,
    private readonly probeParent: string,
    private readonly verifier: AgentCommandVerifier = new NativeAgentCommandVerifier()
  ) {}

  public async list(): Promise<readonly {
    agent: ConfigurableAgentKind;
    command: string;
    capabilities: ReturnType<typeof agentCapabilities>;
  }[]> {
    const config = await new AtomicConfigStore(this.configPath).load();
    return (["codex", "grok", "claude"] as const).flatMap((agent): {
      agent: ConfigurableAgentKind;
      command: string;
      capabilities: ReturnType<typeof agentCapabilities>;
    }[] => {
      const entry = config[agent];
      return entry === undefined ? [] : [{
        agent,
        command: entry.command,
        capabilities: agentCapabilities(agent)
      }];
    });
  }

  public async configure(input: {
    readonly agent: ConfigurableAgentKind;
    readonly command?: string;
    readonly isolatedHomeRoot?: string;
  }): Promise<{
    readonly agent: ConfigurableAgentKind;
    readonly command: string;
    readonly version: string;
  }> {
    if (input.command === undefined) throw new Error("Agent command is required");
    const command = await trustedExecutable(input.command);
    const probeRoot = await mkdtemp(join(this.probeParent, `.agent-${input.agent}-probe-`));
    let verification: AgentVerification;
    try {
      verification = await this.verifier.verify(input.agent, command, probeRoot);
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
    const store = new AtomicConfigStore(this.configPath);
    const config = await store.load();
    if (input.agent === "claude") {
      await store.save({
        ...config,
        claude: {
          command,
          maxActiveTurns: config.claude?.maxActiveTurns ?? 4
        }
      });
    } else if (input.agent === "codex") {
      await store.save({
        ...config,
        codex: {
          command,
          maxActiveTurns: config.codex?.maxActiveTurns ?? 4,
          requestPermissionsTool: config.codex?.requestPermissionsTool ?? true,
          experimentalApi: config.codex?.experimentalApi ?? false
        }
      });
    } else {
      const isolatedHomeRoot = input.isolatedHomeRoot === undefined
        ? config.grok?.isolatedHomeRoot
        : await trustedPrivateDirectory(input.isolatedHomeRoot);
      await store.save({
        ...config,
        grok: {
          command,
          maxActiveTurns: config.grok?.maxActiveTurns ?? 4,
          ...(isolatedHomeRoot === undefined ? {} : { isolatedHomeRoot })
        }
      });
    }
    return { agent: input.agent, command, version: verification.version };
  }

  public async remove(agent: ConfigurableAgentKind): Promise<void> {
    const store = new AtomicConfigStore(this.configPath);
    const config = await store.load();
    if (config[agent] === undefined) throw new Error(`Agent is not configured: ${agent}`);
    const referencing = config.projects.filter((project) => project.allowedAgents.includes(agent));
    if (referencing.length > 0) {
      throw new Error(
        `Agent is referenced by Projects: ${referencing.map((project) => project.slug).join(", ")}`
      );
    }
    const { [agent]: _removed, ...retained } = config;
    await store.save(retained);
  }
}

export function agentCapabilities(agent: ConfigurableAgentKind) {
  if (agent === "codex") {
    return {
      new: true,
      delete: true,
      close: true,
      archive: true,
      unarchive: true,
      import: true,
      steer: true
    };
  }
  if (agent === "claude") {
    // Claude adopts existing TUI sessions but has no native
    // close/archive concept and no steering.
    return {
      new: true,
      delete: true,
      close: false,
      archive: false,
      unarchive: false,
      import: true,
      steer: false
    };
  }
  return {
    new: true,
    delete: true,
    close: false,
    archive: false,
    unarchive: false,
    import: false,
    steer: false
  };
}

class NativeAgentCommandVerifier implements AgentCommandVerifier {
  public async verify(
    kind: ConfigurableAgentKind,
    command: string,
    probeRoot: string
  ): Promise<AgentVerification> {
    if (kind === "claude") {
      const runtime = await startClaudeRuntime({ command });
      await runtime.close();
      return { version: `${runtime.cliVersion} · sdk ${runtime.sdkVersion}` };
    }
    if (kind === "codex") {
      const version = await readCodexVersion(command);
      const runtime = await startCodexRuntime({
        command,
        clientVersion: AGENTLINK_VERSION,
        requestPermissionsTool: true,
        experimentalApi: false
      });
      await runtime.close();
      return { version: version.raw };
    }
    const version = await readGrokVersion(command);
    const runtime = await startGrokRuntime({
      command,
      clientVersion: AGENTLINK_VERSION,
      isolatedHomeRoot: probeRoot
    });
    await runtime.close();
    return { version: version.raw };
  }
}

async function trustedExecutable(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Agent command must be an absolute path");
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)
  ) {
    throw new Error("Agent command must be a trusted executable file");
  }
  return canonical;
}

async function trustedPrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Grok isolated home root must be absolute");
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new Error("Grok isolated home root must be a private owned directory");
  }
  return canonical;
}
