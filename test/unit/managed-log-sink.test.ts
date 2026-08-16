import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  MANAGED_LOG_MAX_BYTES,
  MANAGED_LOG_RECORD_MAX_BYTES,
  ManagedLogSink
} from "../../src/platform-macos/managed-log-sink.js";
import { createPrivateTestRoot } from "../fakes/windows-private-test-path.js";

async function prepareLogDirectory(prefix: string): Promise<{
  readonly root: string;
  readonly logs: string;
}> {
  const root = await createPrivateTestRoot(prefix);
  const logs = join(root, "logs");
  await mkdir(logs, { recursive: true });
  if (process.platform !== "win32") await chmod(logs, 0o700);
  return { root, logs };
}

test("managed logs enforce rotation, history and single-record bounds", async () => {
  const fixture = await prepareLogDirectory("agentlink-managed-log-");
  try {
    const sink = await ManagedLogSink.create(fixture.logs);
    const record = "x".repeat(400 * 1024);
    for (let index = 0; index < 12; index += 1) sink.write("stdout", record);
    sink.write("stderr", "s".repeat(100 * 1024));
    sink.close();

    for (const stream of ["stdout", "stderr"] as const) {
      for (let index = 0; index <= 3; index += 1) {
        const path = join(
          fixture.logs,
          `gateway.${stream}.log${index === 0 ? "" : `.${index}`}`
        );
        const metadata = await lstat(path).catch(() => undefined);
        if (metadata !== undefined) {
          assert.ok(metadata.size <= MANAGED_LOG_MAX_BYTES);
          if (process.platform !== "win32") {
            assert.equal(metadata.mode & 0o777, 0o600);
          }
        }
      }
      await assert.rejects(lstat(join(fixture.logs, `gateway.${stream}.log.4`)));
    }
    const stderr = await readFile(join(fixture.logs, "gateway.stderr.log"), "utf8");
    const line = stderr.trimEnd();
    assert.ok(Buffer.byteLength(`${line}\n`) <= MANAGED_LOG_RECORD_MAX_BYTES);
    assert.match(line, /log_record_truncated/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("managed logs reject symlink and non-private existing files", async () => {
  const fixture = await prepareLogDirectory("agentlink-managed-log-unsafe-");
  try {
    const target = join(fixture.root, "target.log");
    await writeFile(target, "outside\n", { mode: 0o600 });
    let linkCreated = true;
    try {
      await symlink(target, join(fixture.logs, "gateway.stdout.log"));
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        linkCreated = false;
      } else {
        throw error;
      }
    }
    if (linkCreated) {
      await assert.rejects(ManagedLogSink.create(fixture.logs), /trusted private/u);
    }
    // Windows privacy is enforced by the Windows platform layer (ACL checks),
    // not by Unix mode bits, so the mode-based part is macOS-only.
    if (process.platform === "win32") return;

    const secondFixture = await prepareLogDirectory("agentlink-managed-log-public-");
    try {
      const publicLog = join(secondFixture.logs, "gateway.stderr.log");
      await writeFile(publicLog, "public\n", { mode: 0o644 });
      await chmod(publicLog, 0o644);
      await assert.rejects(ManagedLogSink.create(secondFixture.logs), /trusted private/u);
    } finally {
      await rm(secondFixture.root, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
