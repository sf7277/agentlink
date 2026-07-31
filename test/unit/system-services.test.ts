import assert from "node:assert/strict";
import { test } from "node:test";
import { RandomIdGenerator } from "../../src/composition/system-services.js";

test("production approval leases use compact random mobile codes", () => {
  const ids = new RandomIdGenerator();
  const first = ids.next("approval-short");
  const second = ids.next("approval-short");
  assert.match(first, /^P-[A-F0-9]{12}$/u);
  assert.match(second, /^P-[A-F0-9]{12}$/u);
  assert.notEqual(first, second);
  assert.match(ids.next("session"), /^session-[0-9a-f-]{36}$/u);
});
