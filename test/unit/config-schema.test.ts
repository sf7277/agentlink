import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayConfigSchema } from "../../src/composition/config-schema.js";

test("config schema fixes the tested default queue limit and rejects unknown fields", () => {
  assert.deepEqual(gatewayConfigSchema.parse({}), {
    queueLimit: 32,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 256 * 1024,
    requestsPerMinute: 120,
    approvalLeaseMs: 5 * 60_000,
    projects: []
  });
  assert.throws(() => gatewayConfigSchema.parse({ queueLimit: 0 }));
  assert.throws(() => gatewayConfigSchema.parse({ maxInputBytes: 10 }));
  assert.doesNotThrow(() => gatewayConfigSchema.parse({
    codex: {
      command: "codex",
      maxActiveTurns: 4,
      requestPermissionsTool: true,
      experimentalApi: false
    }
  }));
  assert.doesNotThrow(() => gatewayConfigSchema.parse({
    wechat: {
      accountId: "wechat",
      baseUrl: "https://ilinkai.weixin.qq.com",
      credentialReference: "wechat.token",
      controllers: [{ senderId: "owner", gatewayUserId: "owner" }]
    }
  }));
  assert.doesNotThrow(() => gatewayConfigSchema.parse({
    grok: { command: "grok" },
    wechat: {
      accountId: "wechat",
      baseUrl: "https://ilinkai.weixin.qq.com",
      credentialReference: "wechat.token",
      controllers: [{ senderId: "owner", gatewayUserId: "owner" }]
    }
  }));
  assert.throws(() => gatewayConfigSchema.parse({ unexpected: true }));
});

test("config schema accepts a claude section and validates defaultAgent against it", () => {
  const parsed = gatewayConfigSchema.parse({ claude: {} });
  // Claude runs the user's own CLI, defaulting to `claude` on PATH.
  assert.deepEqual(parsed.claude, { command: "claude", maxActiveTurns: 4 });
  assert.equal(
    gatewayConfigSchema.parse({ claude: { command: "/opt/homebrew/bin/claude" } }).claude?.command,
    "/opt/homebrew/bin/claude"
  );
  assert.throws(() => gatewayConfigSchema.parse({ claude: { unexpected: true } }));
  const project = {
    id: "p1",
    slug: "demo",
    path: "/tmp/demo",
    allowedAgents: ["claude"],
    defaultAgent: "claude"
  };
  assert.doesNotThrow(() => gatewayConfigSchema.parse({ claude: {}, projects: [project] }));
  assert.throws(
    () => gatewayConfigSchema.parse({ projects: [project] }),
    /configured adapter/u
  );
  assert.throws(
    () => gatewayConfigSchema.parse({
      claude: {},
      projects: [{ ...project, allowedAgents: ["wechat"], defaultAgent: "wechat" }]
    }),
    /configured adapter/u
  );
});
