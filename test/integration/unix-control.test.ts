import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LocalControlEvent } from "../../src/core/contracts/ports.js";
import { sendControlEvent } from "../../src/local-control/client/unix-control-client.js";
import { UnixControlServer } from "../../src/local-control/server/unix-control-server.js";

test("Unix Socket validates events, is private, and preserves endpoint source", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-socket-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, "gateway.sock");
  const events: LocalControlEvent[] = [];
  const server = new UnixControlServer(socketPath);
  await server.start(async (event) => { events.push(event); });
  context.after(() => server.stop());
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  const response = await sendControlEvent(socketPath, {
    endpointId: "local-cli",
    sessionId: "session-1",
    text: "continue",
    kind: "input"
  });
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(events, [{
    endpointId: "local-cli",
    sessionId: "session-1",
    text: "continue",
    kind: "input"
  }]);
  const impostor = await sendControlEvent(socketPath, {
    endpointId: "impostor",
    sessionId: "session-1",
    text: "spoofed",
    kind: "input"
  }) as { ok: boolean; error: string };
  assert.equal(impostor.ok, false);
  assert.match(impostor.error, /not authorized/u);
  assert.equal(events.length, 1);
});

test("Unix Socket bounds input, output and request rate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-socket-limits-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, "gateway.sock");
  const server = new UnixControlServer(socketPath, {
    maxLineBytes: 256,
    maxPublishedBytes: 256,
    maxRequestsPerMinute: 1
  });
  await server.start(async () => undefined);
  context.after(() => server.stop());
  assert.deepEqual(await sendControlEvent(socketPath, {
    endpointId: "local-cli", sessionId: "session-1", text: "ok", kind: "input"
  }), { ok: true });
  const limited = await sendControlEvent(socketPath, {
    endpointId: "local-cli", sessionId: "session-1", text: "again", kind: "input"
  }) as { ok: boolean; error: string };
  assert.equal(limited.ok, false);
  assert.match(limited.error, /rate exceeded/u);
  assert.throws(() => server.publish("session-1", { text: "x".repeat(300) }), /size limit/u);
});

test("Unix Socket returns scoped Session discovery results without requiring a Session ID", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "al-sm-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, "gateway.sock");
  const server = new UnixControlServer(socketPath);
  await server.start(async (event) => {
    if (event.kind === "session_discover") {
      return [{ number: 1, project: event.project }];
    }
    return undefined;
  });
  context.after(() => server.stop());
  assert.deepEqual(await sendControlEvent(socketPath, {
    endpointId: "local-cli",
    kind: "session_discover",
    project: "agentlink"
  }), {
    ok: true,
    result: [{ number: 1, project: "agentlink" }]
  });
});

test("Unix Socket safely replaces a same-owner socket left by a killed process", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-stale-socket-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, "gateway.sock");
  const child = spawn(process.execPath, [
    "-e",
    [
      "const net=require('node:net');",
      "const path=process.argv.at(-1);",
      "net.createServer(()=>{}).listen(path,()=>process.stdout.write('READY\\n'));",
      "setInterval(()=>{},1000);"
    ].join(""),
    socketPath
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`stale socket helper exited ${String(code)}`)));
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal((await lstatSocket(socketPath)).isSocket(), true);

  const server = new UnixControlServer(socketPath);
  await server.start(async () => undefined);
  context.after(() => server.stop());
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
});

test("Unix Socket refuses to replace an active same-owner control server", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-active-socket-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, "gateway.sock");
  const first = new UnixControlServer(socketPath);
  await first.start(async () => ({ instance: "first" }));
  context.after(() => first.stop());

  const second = new UnixControlServer(socketPath);
  await assert.rejects(second.start(async () => ({ instance: "second" })), /already active/u);
  assert.deepEqual(await sendControlEvent(socketPath, {
    endpointId: "local-cli", sessionId: "session-1", text: "still-first", kind: "input"
  }), { ok: true, result: { instance: "first" } });
});

test("Unix Socket rejects overlong paths before creating a server", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-unix-length-"));
  const server = new UnixControlServer(join(root, "x".repeat(110)));
  await assert.rejects(
    server.start(async () => undefined),
    /exceeds the macOS Unix Socket limit/u
  );
});

async function lstatSocket(path: string) {
  const { lstat } = await import("node:fs/promises");
  return lstat(path);
}
