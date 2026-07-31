import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { verifyProtocolFixture } from "../../src/agent-codex/protocol/fixture-gate.js";
import {
  assertSupportedVersion,
  parseCodexVersion
} from "../../src/agent-codex/protocol/version-gate.js";

test("Codex version gate accepts verified patch line and rejects incompatible versions", () => {
  const support = { minimum: "0.144.4", verified: ["0.144.4", "0.144.5"] };
  assert.doesNotThrow(() => assertSupportedVersion(parseCodexVersion("codex-cli 0.144.4"), support));
  assert.doesNotThrow(() => assertSupportedVersion(parseCodexVersion("codex-cli 0.144.5"), support));
  assert.throws(
    () => assertSupportedVersion(parseCodexVersion("codex-cli 0.143.9"), support),
    /below minimum|compatibility review/u
  );
  assert.throws(
    () => assertSupportedVersion(parseCodexVersion("codex-cli 0.145.0"), support),
    /compatibility review/u
  );
});

test("0.144.4 stable fixture contains every required lifecycle and approval method", async () => {
  const fixture = await verifyProtocolFixture(
    join(process.cwd(), "protocol-fixtures/codex/0.144.4")
  );
  assert.equal(fixture.codexVersion, "0.144.4");
  assert.ok(fixture.methods.includes("thread/list"));
  assert.ok(fixture.methods.includes("thread/read"));
  assert.ok(fixture.methods.includes("thread/inject_items"));
  assert.ok(fixture.methods.includes("turn/steer"));
  assert.ok(fixture.methods.includes("turn/interrupt"));
});

test("0.144.5 current patch preserves the selected stable protocol surface", async () => {
  const root = join(process.cwd(), "protocol-fixtures/codex");
  const compatibility = JSON.parse(
    await readFile(join(root, "0.144.5/compatibility.json"), "utf8")
  ) as {
    codexVersion: string;
    selectedTypeScriptFilesDiffer: boolean;
    sha256: Record<string, string>;
  };
  assert.equal(compatibility.codexVersion, "0.144.5");
  assert.equal(compatibility.selectedTypeScriptFilesDiffer, false);
  for (const name of ["ClientRequest.ts", "ServerRequest.ts"]) {
    const content = await readFile(join(root, "0.144.4/generated/ts", name));
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      compatibility.sha256[name]
    );
  }
});
