import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ILINK_ADAPTER_IDENTITY } from "../../src/channel-wechat/protocol/http-client.js";
import { AGENTLINK_VERSION } from "../../src/version.js";

test("package, Codex client and iLink identities share one product version", async () => {
  const packageDocument = JSON.parse(await readFile("package.json", "utf8")) as {
    version: string;
  };
  assert.equal(AGENTLINK_VERSION, packageDocument.version);
  assert.equal(ILINK_ADAPTER_IDENTITY.adapterVersion, AGENTLINK_VERSION);
  assert.equal(ILINK_ADAPTER_IDENTITY.appClientVersion, AGENTLINK_VERSION);
  assert.equal(ILINK_ADAPTER_IDENTITY.channelVersion, `agentlink/${AGENTLINK_VERSION}`);
  assert.equal(ILINK_ADAPTER_IDENTITY.botAgent, `AgentLink/${AGENTLINK_VERSION}`);
});
