import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWindowsQr } from "../../src/platform-windows/qr-code-renderer.js";
import { windowsApplicationPaths } from "../../src/platform-windows/application-paths.js";
import { WindowsCredentialStore } from "../../src/platform-windows/credential-store.js";
import { WindowsAtomicConfigStore } from "../../src/platform-windows/atomic-config-store.js";
import { WindowsControlServer } from "../../src/local-control/server/windows-control-server.js";
import { sendControlEvent } from "../../src/local-control/client/control-client.js";

test("Windows application paths stay under LOCALAPPDATA", () => {
  const paths = windowsApplicationPaths("C:\\Users\\alice\\AppData\\Local");
  assert.equal(paths.applicationSupport, "C:\\Users\\alice\\AppData\\Local\\AgentLink");
  assert.equal(paths.config, "C:\\Users\\alice\\AppData\\Local\\AgentLink\\config.json");
  assert.equal(paths.socket, "\\\\.\\pipe\\agentlink-gateway");
});

test("Windows QR renderer produces SVG without a native helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlink-windows-qr-test-"));
  const output = join(directory, "login.svg");
  try {
    await renderWindowsQr("agentlink-test-content", output);
    const svg = await readFile(output, "utf8");
    assert.match(svg, /^<svg\b/u);
    assert.match(svg, /viewBox=/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows credential store has no non-Windows fallback and round-trips on Windows", async (t) => {
  const store = new WindowsCredentialStore();
  if (process.platform !== "win32") {
    await assert.rejects(store.get("wechat-ilink-primary"), /only available on Windows/u);
    return;
  }
  const reference = `test-windows-acceptance-${Date.now().toString(36)}`;
  try {
    await store.put(reference, "round-trip-secret");
    assert.equal(await store.get(reference), "round-trip-secret");
  } finally {
    await store.delete(reference);
  }
  assert.equal(await store.get(reference), undefined);
});

test("Windows config store round-trips without Unix mode or UID checks", async () => {
  const base = process.platform === "win32"
    ? process.env["LOCALAPPDATA"]
    : tmpdir();
  if (base === undefined) throw new Error("A test application-data directory is required");
  const directory = await mkdtemp(join(base, "agentlink-windows-config-test-"));
  const output = join(directory, "config.json");
  try {
    const store = new WindowsAtomicConfigStore(output);
    await store.save({});
    assert.deepEqual(await store.load(), {
      projects: [],
      queueLimit: 32,
      maxInputBytes: 64 * 1024,
      maxOutputBytes: 256 * 1024,
      requestsPerMinute: 120,
      approvalLeaseMs: 5 * 60 * 1000
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows control server only loads on Windows", async (t) => {
  const server = new WindowsControlServer("\\\\.\\pipe\\agentlink-gateway-test");
  if (process.platform !== "win32") {
    await assert.rejects(
      server.start(async () => undefined),
      /only available on Windows/u
    );
    return;
  }
  await server.start(async () => undefined);
  await server.stop();
});

test("Windows control server refuses a duplicate Gateway", async (t) => {
  const name = "\\\\.\\pipe\\agentlink-gateway-duplicate-test";
  const first = new WindowsControlServer(name);
  if (process.platform !== "win32") {
    await assert.rejects(first.start(async () => undefined), /only available on Windows/u);
    return;
  }
  await first.start(async () => undefined);
  try {
    const second = new WindowsControlServer(name);
    await assert.rejects(second.start(async () => undefined), /already running/u);
  } finally {
    await first.stop();
  }
});

test("local control client reports a missing endpoint without an unhandled stream error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentlink-missing-control-"));
  try {
    await assert.rejects(
      sendControlEvent(join(directory, "gateway.sock"), {
        endpointId: "local-cli",
        kind: "channel_status",
        channel: "wechat"
      }),
      /ENOENT/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
