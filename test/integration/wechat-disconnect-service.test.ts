import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CredentialStore } from "../../src/core/contracts/ports.js";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";
import { WechatDisconnectService } from "../../src/platform-macos/wechat-disconnect-service.js";

test("wechat disconnect removes only local configuration and credential idempotently", async () => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "agentlink-disconnect-"));
  await chmod(temporaryHome, 0o700);
  const home = await realpath(temporaryHome);
  const configPath = join(home, "config.json");
  const deleted: string[] = [];
  const credentials: CredentialStore = {
    put: async () => undefined,
    get: async () => undefined,
    delete: async (reference) => { deleted.push(reference); }
  };
  const store = new AtomicConfigStore(configPath);
  await store.save({
    codex: { command: "codex", maxActiveTurns: 4, requestPermissionsTool: true, experimentalApi: false },
    wechat: {
      accountId: "wechat", baseUrl: "https://ilinkai.weixin.qq.com",
      credentialReference: "wechat.token", controllers: [{ senderId: "owner", gatewayUserId: "owner" }]
    },
    projects: []
  });
  const service = new WechatDisconnectService(configPath, credentials, store);
  assert.deepEqual(await service.disconnect(), {
    status: "disconnected", credentialReference: "wechat.token", credentialDeleted: true
  });
  assert.equal((await store.load()).wechat, undefined);
  assert.deepEqual(deleted, ["wechat.token"]);
  assert.deepEqual(await service.disconnect(), {
    status: "already_disconnected", credentialDeleted: true
  });
});
