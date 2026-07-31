import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_MINIMUM_VERSION,
  assertSupportedClaudeVersion,
  parseClaudeVersion
} from "../../src/agent-claude/protocol/version-gate.js";

test("Claude CLI version parsing accepts the real --version output", () => {
  assert.deepEqual(parseClaudeVersion("2.1.220 (Claude Code)\n"), {
    raw: "2.1.220 (Claude Code)",
    major: 2,
    minor: 1,
    patch: 220
  });
  assert.throws(() => parseClaudeVersion("unknown"), /unreadable/u);
});

test("Claude CLI version gate rejects builds below the verified minimum", () => {
  assert.doesNotThrow(() =>
    assertSupportedClaudeVersion(parseClaudeVersion(CLAUDE_MINIMUM_VERSION)));
  assert.doesNotThrow(() => assertSupportedClaudeVersion(parseClaudeVersion("2.1.221")));
  assert.doesNotThrow(() => assertSupportedClaudeVersion(parseClaudeVersion("2.2.0")));
  assert.doesNotThrow(() => assertSupportedClaudeVersion(parseClaudeVersion("3.0.0")));
  for (const low of ["2.1.219", "2.0.999", "1.9.9"]) {
    assert.throws(
      () => assertSupportedClaudeVersion(parseClaudeVersion(low)),
      /below minimum/u,
      low
    );
  }
});
