import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deleteGrokNativeSession } from
  "../../src/agent-grok/supervisor/native-session-delete.js";
import { DomainError } from "../../src/core/domain/errors.js";

test("Grok native delete uses fixed CLI arguments and verifies native disappearance", async () => {
  const root = await mkdtemp("/tmp/agentlink-grok-delete-");
  const projectRoot = "/tmp/project";
  const nativeSessionId = "session-safe-1";
  const nativePath = join(
    root,
    "sessions",
    encodeURIComponent(projectRoot),
    nativeSessionId
  );
  await mkdir(nativePath, { recursive: true });
  const calls: unknown[][] = [];

  await deleteGrokNativeSession({
    command: "/trusted/grok",
    grokHome: root,
    projectRoot,
    nativeSessionId,
    execute: async (command, args, environment) => {
      calls.push([command, args, environment["GROK_HOME"]]);
      await rm(nativePath, { recursive: true });
    }
  });

  assert.deepEqual(calls, [[
    "/trusted/grok",
    ["sessions", "delete", nativeSessionId],
    root
  ]]);
  assert.equal(await lstat(nativePath).then(() => false, () => true), true);
});

test("Grok native delete distinguishes definite rejection from uncertain execution", async () => {
  const root = await mkdtemp("/tmp/agentlink-grok-delete-errors-");
  const projectRoot = "/tmp/project";
  const nativeSessionId = "session-safe-2";
  const nativePath = join(
    root,
    "sessions",
    encodeURIComponent(projectRoot),
    nativeSessionId
  );
  await mkdir(nativePath, { recursive: true });

  await assert.rejects(
    deleteGrokNativeSession({
      command: "/trusted/grok",
      grokHome: root,
      projectRoot,
      nativeSessionId,
      execute: async () => {
        const error = new Error("exit 2") as Error & { code: number };
        error.code = 2;
        throw error;
      }
    }),
    (error) => error instanceof DomainError && error.code === "native_delete_rejected"
  );
  await assert.rejects(
    deleteGrokNativeSession({
      command: "/trusted/grok",
      grokHome: root,
      projectRoot,
      nativeSessionId,
      execute: async () => {
        const error = new Error("timed out") as Error & {
          code: string;
          killed: boolean;
        };
        error.code = "ETIMEDOUT";
        error.killed = true;
        throw error;
      }
    }),
    (error) => error instanceof Error && !(error instanceof DomainError)
  );
});
