import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareBoundedRolloutImport,
  TRUNCATION_MARKER
} from "../../src/agent-codex/adapter/bounded-rollout-import.js";

const THREAD_ID = "019f7535-f85d-7f00-847b-e7a0ccb17724";

test("large rollout retains newest complete Q&A pairs without modifying the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-rollout-"));
  const project = join(root, "project");
  const sessions = join(root, "sessions", "2026", "07", "18");
  await mkdir(project);
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, `rollout-test-${THREAD_ID}.jsonl`);
  const records = [
    record("session_meta", { id: THREAD_ID, cwd: project }),
    record("event_msg", { type: "task_started", model_context_window: 400 }),
    record("event_msg", { type: "user_message", message: "旧问题" + "甲".repeat(200) }),
    record("event_msg", { type: "agent_message", phase: "final_answer", message: "旧回答" }),
    record("event_msg", { type: "user_message", message: "最新问题" }),
    record("event_msg", { type: "agent_message", phase: "commentary", message: "过程不可导入" }),
    record("event_msg", { type: "agent_message", phase: "final_answer", message: "最新回答" }),
    record("event_msg", { type: "user_message", message: "未完成问题" })
  ].join("\n");
  await writeFile(path, records, { mode: 0o600 });
  await chmod(path, 0o600);
  const before = sha(await readFile(path));

  try {
    const result = await prepareBoundedRolloutImport(THREAD_ID, project, {
      searchRoot: join(root, "sessions"), largeThresholdBytes: 1
    });
    assert.ok(result);
    assert.equal(result.totalPairs, 2);
    assert.equal(result.retainedPairs, 1);
    assert.equal(result.items.length, 3);
    assert.equal(itemText(result.items[0]!), TRUNCATION_MARKER);
    assert.equal(itemText(result.items[1]!), "最新问题");
    assert.equal(itemText(result.items[2]!), "最新回答");
    assert.equal(sha(await readFile(path)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a newest pair larger than the whole budget is explicitly truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-rollout-"));
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  await mkdir(project);
  await mkdir(sessions);
  const path = join(sessions, `rollout-test-${THREAD_ID}.jsonl`);
  await writeFile(path, [
    record("session_meta", { id: THREAD_ID, cwd: project }),
    record("event_msg", { type: "task_started", model_context_window: 256 }),
    record("event_msg", { type: "user_message", message: "问".repeat(500) }),
    record("event_msg", { type: "agent_message", phase: "final_answer", message: "答".repeat(500) })
  ].join("\n"), { mode: 0o600 });
  try {
    const result = await prepareBoundedRolloutImport(THREAD_ID, project, {
      searchRoot: sessions, largeThresholdBytes: 1
    });
    assert.ok(result);
    assert.equal(result.retainedPairs, 1);
    assert.match(itemText(result.items[1]!), /问答本身超过导入预算/u);
    assert.match(itemText(result.items[2]!), /问答本身超过导入预算/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function record(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, payload });
}
function itemText(item: Record<string, unknown>): string {
  return String(((item["content"] as Record<string, unknown>[])[0] ?? {})["text"]);
}
function sha(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
