import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { sendControlEvent } from "../../src/local-control/client/unix-control-client.js";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";

test("Gateway host validates managed config, creates private runtime state and shuts down cleanly", async () => {
  const home = await mkdtemp("/tmp/agentlink-gateway-host-");
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  await new AtomicConfigStore(paths.config).save({
    queueLimit: 32,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 256 * 1024,
    requestsPerMinute: 120,
    projects: []
  });
  const child = spawn(process.execPath, [
    join(process.cwd(), "dist/src/main.js"),
    "--config",
    paths.config
  ], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      HOME: home,
      PATH: process.env["PATH"] ?? ""
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await Promise.race([
    waitFor(async () => (await readFile(
      join(paths.logs, "gateway.stdout.log"),
      "utf8"
    ).catch(() => "")).includes('"gateway_started"')),
    new Promise<never>((_resolve, reject) => {
      child.once("exit", (code, signal) => {
        reject(new Error(
          `Gateway exited before ready: code=${String(code)} signal=${String(signal)} ${stderr.slice(0, 500)}`
        ));
      });
    })
  ]);
  const response = await sendControlEvent(paths.socket, {
    endpointId: "local-cli",
    sessionId: "fixture-session",
    text: "input",
    kind: "input"
  }) as { ok: boolean; error: string };
  assert.equal(response.ok, false);
  assert.match(response.error, /adapters are not configured/u);
  child.kill("SIGTERM");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null });
  const managedStdout = await readFile(join(paths.logs, "gateway.stdout.log"), "utf8");
  assert.match(managedStdout, /gateway_stopping/u);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(paths.socket)));
  await chmod(paths.database, 0o600);
});

test("Gateway health check opens config and migrations without leaving a socket", async () => {
  const home = await mkdtemp("/tmp/agentlink-gateway-health-");
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  await new AtomicConfigStore(paths.config).save({
    queueLimit: 32,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 256 * 1024,
    requestsPerMinute: 120,
    projects: []
  });
  const result = await runChild([
    join(process.cwd(), "dist/src/main.js"),
    "--config",
    paths.config,
    "--health-check"
  ], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /health_check/u);
  assert.equal(result.stderr, "");
  await assert.rejects(import("node:fs/promises").then(({ lstat }) => lstat(paths.socket)));
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const started = Date.now();
  while (!await predicate()) {
    if (Date.now() - started > 5_000) throw new Error("Gateway host did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runChild(args: readonly string[], home: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      shell: false,
      env: { HOME: home, PATH: process.env["PATH"] ?? "" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
