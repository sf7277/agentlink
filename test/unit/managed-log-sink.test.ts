import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MANAGED_LOG_MAX_BYTES,
  MANAGED_LOG_RECORD_MAX_BYTES,
  ManagedLogSink
} from "../../src/platform-macos/managed-log-sink.js";

test("managed logs enforce rotation, history and single-record bounds", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-managed-log-"));
  const logDirectory = join(home, "logs");
  await mkdir(logDirectory, { recursive: true });
  const sink = await ManagedLogSink.create(logDirectory);
  const record = "x".repeat(400 * 1024);
  for (let index = 0; index < 12; index += 1) sink.write("stdout", record);
  sink.write("stderr", "s".repeat(100 * 1024));
  sink.close();

  for (const stream of ["stdout", "stderr"] as const) {
    for (let index = 0; index <= 3; index += 1) {
      const path = join(
        logDirectory,
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
    await assert.rejects(lstat(join(logDirectory, `gateway.${stream}.log.4`)));
  }
  const stderr = await readFile(join(logDirectory, "gateway.stderr.log"), "utf8");
  const line = stderr.trimEnd();
  assert.ok(Buffer.byteLength(`${line}\n`) <= MANAGED_LOG_RECORD_MAX_BYTES);
  assert.match(line, /log_record_truncated/u);
});

test("managed logs reject symlink and non-private existing files", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-managed-log-unsafe-"));
  const logDirectory = join(home, "logs");
  await mkdir(logDirectory, { recursive: true });
  const target = join(home, "target.log");
  await writeFile(target, "outside\n", { mode: 0o600 });
  let linkCreated = true;
  try {
    await symlink(target, join(logDirectory, "gateway.stdout.log"));
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      linkCreated = false;
    } else {
      throw error;
    }
  }
  if (linkCreated) {
    await assert.rejects(ManagedLogSink.create(logDirectory), /trusted private/u);
  }
  // Windows privacy is enforced by the Windows platform layer (ACL checks),
  // not by Unix mode bits, so the mode-based part is macOS-only.
  if (process.platform === "win32") return;

  const secondHome = await mkdtemp(join(tmpdir(), "agentlink-managed-log-public-"));
  const secondLogDirectory = join(secondHome, "logs");
  await mkdir(secondLogDirectory, { recursive: true });
  const publicLog = join(secondLogDirectory, "gateway.stderr.log");
  await writeFile(publicLog, "public\n", { mode: 0o644 });
  await chmod(publicLog, 0o644);
  await assert.rejects(ManagedLogSink.create(secondLogDirectory), /trusted private/u);
});
