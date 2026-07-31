import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareIsolatedGrokHome } from "../../src/agent-grok/home/isolated-home.js";

test("prepareIsolatedGrokHome preserves an independent private auth file", async () => {
  const base = await mkdtempSafe("agentlink-grok-home-auth-");
  const isolated = join(base, "isolated");
  await mkdir(isolated, { recursive: true, mode: 0o700 });
  const auth = join(isolated, "auth.json");
  await writeFile(auth, '{"fixture":"agentlink"}', { mode: 0o600 });

  const home = await prepareIsolatedGrokHome(isolated);
  assert.equal(home, await realpath(isolated));
  assert.equal((await lstat(auth)).isSymbolicLink(), false);
  assert.equal(await readFile(auth, "utf8"), '{"fixture":"agentlink"}');
  await prepareIsolatedGrokHome(isolated);
  assert.equal(await readFile(auth, "utf8"), '{"fixture":"agentlink"}');
});

test("prepareIsolatedGrokHome removes only a legacy auth symlink", async () => {
  const base = await mkdtempSafe("agentlink-grok-home-link-");
  const isolated = join(base, "isolated");
  const tuiAuth = join(base, "tui-auth.json");
  await mkdir(isolated, { recursive: true, mode: 0o700 });
  await writeFile(tuiAuth, '{"fixture":"tui"}', { mode: 0o600 });
  await symlink(tuiAuth, join(isolated, "auth.json"));

  await prepareIsolatedGrokHome(isolated);
  await assert.rejects(() => lstat(join(isolated, "auth.json")), { code: "ENOENT" });
  assert.equal(await readFile(tuiAuth, "utf8"), '{"fixture":"tui"}');
});

test("prepareIsolatedGrokHome leaves missing auth absent", async () => {
  const base = await mkdtempSafe("agentlink-grok-home-missing-");
  const isolated = join(base, "isolated");
  await prepareIsolatedGrokHome(isolated);
  await assert.rejects(() => lstat(join(isolated, "auth.json")), { code: "ENOENT" });
});

test("prepareIsolatedGrokHome inherits native policy config without sharing auth", async () => {
  const base = await mkdtempSafe("agentlink-grok-home-policy-");
  const nativeHome = join(base, "native");
  const isolated = join(base, "isolated");
  await mkdir(nativeHome, { mode: 0o700 });
  const nativeConfig = join(nativeHome, "config.toml");
  await writeFile(nativeConfig, '[ui]\npermission_mode = "ask"\n', { mode: 0o600 });

  await prepareIsolatedGrokHome(isolated, nativeHome);
  const linked = join(isolated, "config.toml");
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.equal(await realpath(linked), await realpath(nativeConfig));
  await assert.rejects(() => lstat(join(isolated, "auth.json")), { code: "ENOENT" });
});

test("prepareIsolatedGrokHome rejects unsafe auth files and symlink roots", async () => {
  const base = await mkdtempSafe("agentlink-grok-home-unsafe-");
  const isolated = join(base, "isolated");
  await mkdir(isolated, { mode: 0o700 });
  await mkdir(join(isolated, "auth.json"), { mode: 0o700 });
  await assert.rejects(
    () => prepareIsolatedGrokHome(isolated),
    /auth must be a private owned regular file/u
  );

  const realRoot = join(base, "real-root");
  await mkdir(realRoot, { mode: 0o700 });
  const linkedRoot = join(base, "linked-root");
  await symlink(realRoot, linkedRoot);
  await assert.rejects(
    () => prepareIsolatedGrokHome(linkedRoot),
    /private canonical directory/u
  );
});

async function mkdtempSafe(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), prefix));
}
