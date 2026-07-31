import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  stat,
  symlink,
  utimes
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IsolatedArtifactStore } from "../../src/local-artifacts/isolated-artifact-store.js";

test("artifact store isolates Sessions, enforces limits and safely expires files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentlink-artifacts-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const store = new IsolatedArtifactStore({
    root,
    maxBytes: 16,
    retentionMs: 1_000,
    allowedMediaTypes: new Set(["text/plain"])
  });
  const record = await store.put(
    "session-1", "text/plain", Buffer.from("safe artifact"),
    new Date("2026-07-19T00:00:00.000Z")
  );
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "session-1"))).mode & 0o777, 0o700);
  assert.equal((await stat(record.path)).mode & 0o777, 0o600);
  assert.equal(await readFile(record.path, "utf8"), "safe artifact");
  await assert.rejects(
    store.put("../escape", "text/plain", Buffer.from("x")),
    /unsupported characters/u
  );
  await assert.rejects(
    store.put("session-1", "application/octet-stream", Buffer.from("x")),
    /media type/u
  );
  await assert.rejects(
    store.put("session-1", "text/plain", Buffer.alloc(17)),
    /size/u
  );
  const old = new Date("2026-07-18T00:00:00.000Z");
  await utimes(record.path, old, old);
  const outside = join(root, "..", "outside-artifact-target");
  await symlink(outside, join(root, "untrusted-link"));
  assert.equal(await store.cleanup(new Date("2026-07-19T00:00:02.000Z")), 2);
  await assert.rejects(lstat(record.path), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
});
