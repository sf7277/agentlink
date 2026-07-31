import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";
import {
  AgentConfigService,
  type AgentCommandVerifier,
  type ConfigurableAgentKind
} from "../../src/platform-macos/agent-config-service.js";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";

class FakeVerifier implements AgentCommandVerifier {
  readonly calls: {
    kind: ConfigurableAgentKind;
    command: string;
    probeRoot: string;
  }[] = [];

  public async verify(
    kind: ConfigurableAgentKind,
    command: string,
    probeRoot: string
  ): Promise<{ version: string }> {
    this.calls.push({ kind, command, probeRoot });
    return { version: `${kind}-test-version` };
  }
}

async function executable(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test("Agent config is verified before persistence and exposes product capabilities", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-agent-config-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  await new AtomicConfigStore(paths.config).save({});
  const verifier = new FakeVerifier();
  const service = new AgentConfigService(paths.config, paths.runtime, verifier);
  const codex = await executable(home, "codex");
  const grok = await executable(home, "grok");
  const grokHome = join(home, "grok-home");
  await mkdir(grokHome, { mode: 0o700 });
  const canonicalCodex = await realpath(codex);
  const canonicalGrokHome = await realpath(grokHome);

  assert.deepEqual(await service.configure({ agent: "codex", command: codex }), {
    agent: "codex",
    command: canonicalCodex,
    version: "codex-test-version"
  });
  await service.configure({
    agent: "grok",
    command: grok,
    isolatedHomeRoot: grokHome
  });
  assert.deepEqual(verifier.calls.map((call) => call.kind), ["codex", "grok"]);
  assert.deepEqual((await service.list()).map((entry) => ({
    agent: entry.agent,
    import: entry.capabilities.import
  })), [
    { agent: "codex", import: true },
    { agent: "grok", import: false }
  ]);
  assert.equal(
    (await new AtomicConfigStore(paths.config).load()).grok?.isolatedHomeRoot,
    canonicalGrokHome
  );
});

test("Agent removal rejects Project references and untrusted commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-agent-remove-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const codex = await executable(home, "codex");
  const verifier = new FakeVerifier();
  const store = new AtomicConfigStore(paths.config);
  await store.save({
    codex: {
      command: codex,
      maxActiveTurns: 4,
      requestPermissionsTool: true,
      experimentalApi: false
    },
    projects: [{
      id: "project-1",
      slug: "agentlink",
      path: home,
      allowedAgents: ["codex"],
      defaultAgent: "codex",
      enabled: true
    }]
  });
  const service = new AgentConfigService(paths.config, paths.runtime, verifier);

  await assert.rejects(service.remove("codex"), /referenced by Projects/u);
  await assert.rejects(
    service.configure({ agent: "grok", command: "grok" }),
    /absolute path/u
  );
  assert.equal(verifier.calls.length, 0);

  const config = await store.load();
  await store.save({ ...config, projects: [] });
  await service.remove("codex");
  assert.equal((await store.load()).codex, undefined);
});

test("Claude configure verifies the user's CLI, persists it and exposes its capability matrix", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-agent-claude-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const verifier = new FakeVerifier();
  const store = new AtomicConfigStore(paths.config);
  await store.save({});
  const service = new AgentConfigService(paths.config, paths.runtime, verifier);
  const claude = await executable(home, "claude");
  const canonicalClaude = await realpath(claude);

  // Claude runs the user's own CLI, so --command is required and trust-checked
  // exactly like codex and grok.
  await assert.rejects(
    service.configure({ agent: "claude", command: "claude" }),
    /absolute path/u
  );
  assert.equal(verifier.calls.length, 0);

  assert.deepEqual(await service.configure({ agent: "claude", command: claude }), {
    agent: "claude",
    command: canonicalClaude,
    version: "claude-test-version"
  });
  assert.deepEqual(verifier.calls.map((call) => call.kind), ["claude"]);
  assert.deepEqual((await store.load()).claude, {
    command: canonicalClaude,
    maxActiveTurns: 4
  });

  assert.deepEqual(await service.list(), [{
    agent: "claude",
    command: canonicalClaude,
    capabilities: {
      new: true,
      delete: true,
      close: false,
      archive: false,
      unarchive: false,
      // Claude adopts existing TUI sessions.
      import: true,
      steer: false
    }
  }]);
  await service.remove("claude");
  assert.equal((await store.load()).claude, undefined);
});
