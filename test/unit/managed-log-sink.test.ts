import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MANAGED_LOG_MAX_BYTES,
  MANAGED_LOG_RECORD_MAX_BYTES,
  ManagedLogSink
} from "../../src/platform-macos/managed-log-sink.js";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";

test("managed logs enforce rotation, history and single-record bounds", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-managed-log-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const sink = await ManagedLogSink.create(paths.logs);
  const record = "x".repeat(400 * 1024);
  for (let index = 0; index < 12; index += 1) sink.write("stdout", record);
  sink.write("stderr", "s".repeat(100 * 1024));
  sink.close();

  for (const stream of ["stdout", "stderr"] as const) {
    for (let index = 0; index <= 3; index += 1) {
      const path = join(
        paths.logs,
        `gateway.${stream}.log${index === 0 ? "" : `.${index}`}`
      );
      const metadata = await lstat(path).catch(() => undefined);
      if (metadata !== undefined) {
        assert.ok(metadata.size <= MANAGED_LOG_MAX_BYTES);
        assert.equal(metadata.mode & 0o777, 0o600);
      }
    }
    await assert.rejects(lstat(join(paths.logs, `gateway.${stream}.log.4`)));
  }
  const stderr = await readFile(join(paths.logs, "gateway.stderr.log"), "utf8");
  const line = stderr.trimEnd();
  assert.ok(Buffer.byteLength(`${line}\n`) <= MANAGED_LOG_RECORD_MAX_BYTES);
  assert.match(line, /log_record_truncated/u);
});

test("managed logs reject symlink and non-private existing files", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-managed-log-unsafe-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const target = join(home, "target.log");
  await writeFile(target, "outside\n", { mode: 0o600 });
  await symlink(target, join(paths.logs, "gateway.stdout.log"));
  await assert.rejects(ManagedLogSink.create(paths.logs), /trusted private/u);

  const secondHome = await mkdtemp(join(tmpdir(), "agentlink-managed-log-public-"));
  const secondPaths = macosApplicationPaths(secondHome);
  await ensureMacosApplicationPaths(secondPaths);
  const publicLog = join(secondPaths.logs, "gateway.stderr.log");
  await writeFile(publicLog, "public\n", { mode: 0o644 });
  await chmod(publicLog, 0o644);
  await assert.rejects(ManagedLogSink.create(secondPaths.logs), /trusted private/u);
});
