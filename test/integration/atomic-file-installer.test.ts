import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AtomicFileInstaller } from "../../src/update/atomic-file-installer.js";
import { AtomicInstallError } from "../../src/update/update-coordinator.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentlink-atomic-install-"));
  await chmod(root, 0o700);
  const source = join(root, "download.bin");
  const target = join(root, "agentlink");
  const next = Buffer.from("new verified release", "utf8");
  await writeFile(source, next, { mode: 0o600 });
  await chmod(source, 0o600);
  await writeFile(target, "old release", { mode: 0o700 });
  await chmod(target, 0o700);
  return {
    root,
    source,
    target,
    next,
    sha256: createHash("sha256").update(next).digest("hex")
  };
}

test("atomic installer replaces a private same-owner release and removes rollback data", async () => {
  const fixture = await setup();
  await new AtomicFileInstaller().install({
    sourcePath: fixture.source,
    targetPath: fixture.target,
    expectedSha256: fixture.sha256,
    expectedSize: fixture.next.length
  });
  assert.deepEqual(await readFile(fixture.target), fixture.next);
  assert.deepEqual(
    (await readdir(fixture.root)).sort(),
    ["agentlink", "download.bin"]
  );
});

test("failed post-install health check atomically restores the previous release", async () => {
  const fixture = await setup();
  const installer = new AtomicFileInstaller({
    healthCheck: async () => { throw new Error("injected health check failure"); }
  });
  await assert.rejects(
    installer.install({
      sourcePath: fixture.source,
      targetPath: fixture.target,
      expectedSha256: fixture.sha256,
      expectedSize: fixture.next.length
    }),
    (error) =>
      error instanceof AtomicInstallError &&
      error.replacementState === "rolled_back"
  );
  assert.equal(await readFile(fixture.target, "utf8"), "old release");
  assert.deepEqual(
    (await readdir(fixture.root)).sort(),
    ["agentlink", "download.bin"]
  );
});

test("hash mismatch, public directories and symlink artifacts never replace the target", async () => {
  const fixture = await setup();
  const installer = new AtomicFileInstaller();
  await assert.rejects(
    installer.install({
      sourcePath: fixture.source,
      targetPath: fixture.target,
      expectedSha256: "0".repeat(64),
      expectedSize: fixture.next.length
    }),
    (error) =>
      error instanceof AtomicInstallError &&
      error.replacementState === "unchanged"
  );
  assert.equal(await readFile(fixture.target, "utf8"), "old release");

  const link = join(fixture.root, "download-link");
  await symlink(fixture.source, link);
  await assert.rejects(
    installer.install({
      sourcePath: link,
      targetPath: fixture.target,
      expectedSha256: fixture.sha256,
      expectedSize: fixture.next.length
    }),
    AtomicInstallError
  );
  assert.equal(await readFile(fixture.target, "utf8"), "old release");

  await chmod(fixture.root, 0o755);
  await assert.rejects(
    installer.install({
      sourcePath: fixture.source,
      targetPath: fixture.target,
      expectedSha256: fixture.sha256,
      expectedSize: fixture.next.length
    }),
    AtomicInstallError
  );
  assert.equal(await readFile(fixture.target, "utf8"), "old release");
});
