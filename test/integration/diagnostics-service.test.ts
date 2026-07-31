import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  diagnoseAgentLink,
  readAgentLinkLogs
} from "../../src/platform-macos/diagnostics-service.js";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";

test("doctor is read-only and log tail is bounded to managed private files", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-doctor-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const codex = join(home, "codex");
  await writeFile(codex, "", { mode: 0o700 });
  await new AtomicConfigStore(paths.config).save({
    codex: {
      command: codex,
      maxActiveTurns: 4,
      requestPermissionsTool: true,
      experimentalApi: true
    },
    wechat: {
      accountId: "account",
      baseUrl: "https://example.invalid",
      credentialReference: "credential",
      controllers: [{ senderId: "owner", gatewayUserId: "user" }]
    },
    projects: []
  });
  const database = new Database(paths.database);
  database.exec("CREATE TABLE health(id INTEGER PRIMARY KEY)");
  database.close();
  await chmod(paths.database, 0o600);
  await writeFile(`${paths.logs}/gateway.stdout.log`, "one\ntwo\nthree\n", { mode: 0o600 });
  await writeFile(`${paths.logs}/gateway.stderr.log`, "", { mode: 0o600 });

  const logs = await readAgentLinkLogs(paths, 2);
  assert.match(logs.stdout, /two\nthree/u);
  const result = await diagnoseAgentLink(
    paths,
    { status: async () => ({ installed: true, loaded: true, detail: "loaded" }) },
    async () => "codex-cli 0.144.4"
  );
  assert.equal(result["database"], "ok");
  assert.equal(result["codex"], "codex-cli 0.144.4");
  assert.equal(result["socket"], "missing");
  assert.equal(result["ok"], false);
});

test("readAgentLinkLogs rejects unsafe logs without mutating them", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-logs-mode-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const stdoutPath = `${paths.logs}/gateway.stdout.log`;
  const stderrPath = `${paths.logs}/gateway.stderr.log`;
  await writeFile(stdoutPath, "alpha\nbeta\n", { mode: 0o644 });
  await writeFile(stderrPath, "err\n", { mode: 0o644 });
  await chmod(stdoutPath, 0o644);
  await chmod(stderrPath, 0o644);

  await assert.rejects(() => readAgentLinkLogs(paths, 10), /not a trusted private regular file/u);
  const { stat } = await import("node:fs/promises");
  const mode = (await stat(stdoutPath)).mode & 0o777;
  assert.equal(mode, 0o644);
});

test("doctor checks every configured Agent and does not require Codex", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-doctor-grok-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const grok = join(home, "grok");
  await writeFile(grok, "", { mode: 0o700 });
  await new AtomicConfigStore(paths.config).save({
    grok: { command: grok },
    projects: []
  });
  const database = new Database(paths.database);
  database.exec("CREATE TABLE health(id INTEGER PRIMARY KEY)");
  database.close();
  const checked: string[] = [];
  const result = await diagnoseAgentLink(
    paths,
    { status: async () => ({ installed: true, loaded: true, detail: "loaded" }) },
    async (_command, agent) => {
      checked.push(agent ?? "unknown");
      return "grok 0.2.106";
    }
  );
  assert.deepEqual(checked, ["grok"]);
  assert.equal(result["grok"], "grok 0.2.106");
  assert.deepEqual(result["agents"], { grok: "grok 0.2.106" });
});

test("doctor reports bundled service runtime, log boundaries and authorized channel status", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-doctor-runtime-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const runtime = join(paths.releases, "0.2.0", "runtime", "bin", "node");
  await mkdir(join(paths.releases, "0.2.0", "runtime", "bin"), {
    recursive: true,
    mode: 0o700
  });
  await copyFile(process.execPath, runtime);
  await chmod(runtime, 0o700);
  await writeFile(paths.launchAgent, `
<plist><dict><key>ProgramArguments</key><array>
<string>${runtime}</string><string>/entrypoint.js</string>
</array></dict></plist>
`, { mode: 0o600 });
  await new AtomicConfigStore(paths.config).save({
    wechat: {
      accountId: "account",
      baseUrl: "https://example.invalid",
      credentialReference: "credential",
      controllers: [{ senderId: "owner", gatewayUserId: "user" }]
    },
    projects: []
  });
  await writeFile(`${paths.logs}/gateway.stdout.log`, "ready\n", { mode: 0o600 });
  await writeFile(`${paths.logs}/gateway.stderr.log`, "", { mode: 0o600 });
  const result = await diagnoseAgentLink(
    paths,
    { status: async () => ({ installed: true, loaded: true, detail: "loaded" }) },
    async () => "unused",
    async () => "HEALTHY"
  );
  assert.deepEqual(result["channel"], { channel: "wechat", status: "HEALTHY" });
  assert.deepEqual(result["runtime"], {
    status: "ok",
    configuredPath: runtime,
    canonicalPath: runtime,
    version: `v${process.versions.node}`,
    installedRelease: true,
    releaseVersion: "0.2.0"
  });
  assert.equal((result["logs"] as { status: string }).status, "ok");
});
