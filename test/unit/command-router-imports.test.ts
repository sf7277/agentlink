import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../../src/core/application/command-router.js";

test("/imports defaults to five and accepts a positive count or all", () => {
  assert.deepEqual(parseCommand("/imports demo"), {
    kind: "imports", project: "demo", limit: 5
  });
  assert.deepEqual(parseCommand("/imports demo 12"), {
    kind: "imports", project: "demo", limit: 12
  });
  assert.deepEqual(parseCommand("/imports demo all"), {
    kind: "imports", project: "demo", limit: "all"
  });
  assert.deepEqual(parseCommand("/imports grok demo all"), {
    kind: "imports", agent: "grok", project: "demo", limit: "all"
  });
  assert.deepEqual(parseCommand("/imports claude demo"), {
    kind: "imports", agent: "claude", project: "demo", limit: 5
  });
  assert.throws(() => parseCommand("/imports demo 0"), /positive number or all/u);
});

test("/import remains a single list-item import", () => {
  assert.deepEqual(parseCommand("/import 2"), { kind: "import_session", reference: "2" });
  assert.throws(() => parseCommand("/import 1 2"), /exactly one/u);
});
