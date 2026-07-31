import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionLinearizer } from "../../src/core/application/session-linearizer.js";

test("serializes operations for one Session but does not globally serialize Sessions", async () => {
  const linearizer = new SessionLinearizer();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = linearizer.run("a", async () => { order.push("a1-start"); await gate; order.push("a1-end"); });
  const second = linearizer.run("a", () => { order.push("a2"); });
  const other = linearizer.run("b", () => { order.push("b1"); });
  await other;
  assert.deepEqual(order, ["a1-start", "b1"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1-start", "b1", "a1-end", "a2"]);
});
