import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSupportedGrokVersion,
  parseGrokVersion
} from "../../src/agent-grok/protocol/version-gate.js";

test("parseGrokVersion accepts grok --version style output", () => {
  assert.deepEqual(parseGrokVersion("grok 0.2.106 (bde89716f679)"), {
    major: 0,
    minor: 2,
    patch: 106,
    raw: "0.2.106"
  });
});

test("assertSupportedGrokVersion enforces minimum 0.2.106", () => {
  assert.doesNotThrow(() =>
    assertSupportedGrokVersion(parseGrokVersion("0.2.106"))
  );
  assert.throws(
    () => assertSupportedGrokVersion(parseGrokVersion("0.2.100")),
    /below minimum/u
  );
});
