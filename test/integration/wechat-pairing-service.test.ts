import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";
import { AtomicConfigStore } from "../../src/platform-macos/atomic-config-store.js";
import { WechatPairingService } from "../../src/platform-macos/wechat-pairing-service.js";
import { FakeCredentialStore } from "../fakes/core-fakes.js";

test("pairing stores the token only in the credential store and writes non-secret config", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-pairing-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const credentials = new FakeCredentialStore();
  const displayed: string[] = [];
  const service = new WechatPairingService(
    paths.config,
    {
      login: async (input) => {
        await input.display("https://example.invalid/qr");
        await credentials.put(input.credentialReference, "secret-token");
        return {
          accountId: "account-1",
          userId: "owner-1",
          baseUrl: "https://ilinkai.weixin.qq.com"
        };
      }
    },
    credentials
  );
  await service.pair({
    baseUrl: "https://ilinkai.weixin.qq.com",
    credentialReference: "wechat-ilink-primary",
    gatewayUserId: "primary-owner",
    display: async (value) => { displayed.push(value); }
  });
  const config = await new AtomicConfigStore(paths.config).load();
  assert.deepEqual(displayed, ["https://example.invalid/qr"]);
  assert.equal(await credentials.get("wechat-ilink-primary"), "secret-token");
  assert.equal(
    [...credentials.values.keys()].some((key) => key.includes(".pending.")),
    false
  );
  assert.equal(config.wechat?.accountId, "account-1");
  assert.equal(config.wechat?.controllers[0]?.senderId, "owner-1");
  assert.equal(config.codex, undefined);
  assert.equal(config.grok, undefined);
  assert.doesNotMatch(JSON.stringify(config), /secret-token/u);
});
