import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeSessionFilePath,
  claudeSessionFileState,
  deleteOwnedClaudeSessionFile,
  encodedClaudeProjectDirectory,
  isSafeClaudeNativeSessionId
} from "../../src/agent-claude/home/write-boundary.js";
import { DomainError } from "../../src/core/domain/errors.js";

const SESSION_ID = "019f8fa2-273d-7200-a92e-0a85c7e3e9bc";

async function claudeHomeWithSession(projectRoot: string, sessionId: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "agentlink-claude-home-"));
  const directory = join(home, "projects", encodedClaudeProjectDirectory(projectRoot));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${sessionId}.jsonl`), "{}\n", { mode: 0o600 });
  return home;
}

test("encodedClaudeProjectDirectory replaces every non-alphanumeric byte with a dash", () => {
  assert.equal(
    encodedClaudeProjectDirectory("/Users/example/work/agentlink"),
    "-Users-example-work-agentlink"
  );
  assert.equal(
    encodedClaudeProjectDirectory("/tmp/my.app_v2 beta"),
    "-tmp-my-app-v2-beta"
  );
});

test("claudeSessionFilePath rejects unsafe native session ids", () => {
  assert.equal(isSafeClaudeNativeSessionId(SESSION_ID), true);
  for (const unsafe of ["../evil", "", ".hidden", "a/b", "a\\b", "-lead"]) {
    assert.equal(isSafeClaudeNativeSessionId(unsafe), false, unsafe);
    assert.throws(
      () => claudeSessionFilePath("/tmp/home", "/tmp/project", unsafe),
      (error: unknown) =>
        error instanceof DomainError && error.code === "native_session_id_invalid"
    );
  }
});

test("claudeSessionFileState distinguishes missing, file and untrusted paths", async () => {
  const projectRoot = "/tmp/project";
  const home = await claudeHomeWithSession(projectRoot, SESSION_ID);
  assert.equal(await claudeSessionFileState(home, projectRoot, SESSION_ID), "file");
  assert.equal(
    await claudeSessionFileState(home, projectRoot, "019f8fa2-273d-7200-a92e-0a85c7e3e999"),
    "missing"
  );
  const linkId = "119f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  await symlink(
    claudeSessionFilePath(home, projectRoot, SESSION_ID),
    claudeSessionFilePath(home, projectRoot, linkId)
  );
  assert.equal(await claudeSessionFileState(home, projectRoot, linkId), "other");
});

test("deleteOwnedClaudeSessionFile deletes exactly the target file", async () => {
  const projectRoot = "/tmp/project";
  const home = await claudeHomeWithSession(projectRoot, SESSION_ID);
  const otherId = "219f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  const otherPath = claudeSessionFilePath(home, projectRoot, otherId);
  await writeFile(otherPath, "{}\n", { mode: 0o600 });
  await deleteOwnedClaudeSessionFile({
    claudeHome: home,
    projectRoot,
    nativeSessionId: SESSION_ID
  });
  assert.equal(await claudeSessionFileState(home, projectRoot, SESSION_ID), "missing");
  assert.equal((await lstat(otherPath)).isFile(), true);
  // Missing before deletion is a no-op, never an error.
  await deleteOwnedClaudeSessionFile({
    claudeHome: home,
    projectRoot,
    nativeSessionId: SESSION_ID
  });
});

test("write boundary refuses a symlinked project directory", async () => {
  const projectRoot = "/tmp/project";
  // A legitimate home holds the real file; the boundary home points at it via
  // a symlinked projects/<encoded> directory. Checking only the final path
  // component would let this redirect reads and deletes outside the boundary.
  const realHome = await claudeHomeWithSession(projectRoot, SESSION_ID);
  const attackerHome = await mkdtemp(join(tmpdir(), "agentlink-claude-attacker-"));
  await mkdir(join(attackerHome, "projects"), { recursive: true });
  await symlink(
    join(realHome, "projects", encodedClaudeProjectDirectory(projectRoot)),
    join(attackerHome, "projects", encodedClaudeProjectDirectory(projectRoot))
  );
  assert.equal(await claudeSessionFileState(attackerHome, projectRoot, SESSION_ID), "other");
  await assert.rejects(
    deleteOwnedClaudeSessionFile({
      claudeHome: attackerHome,
      projectRoot,
      nativeSessionId: SESSION_ID
    }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "native_session_path_invalid"
  );
  assert.equal(await claudeSessionFileState(realHome, projectRoot, SESSION_ID), "file");
});

test("deleteOwnedClaudeSessionFile refuses symlinks instead of following them", async () => {
  const projectRoot = "/tmp/project";
  const home = await claudeHomeWithSession(projectRoot, SESSION_ID);
  const linkId = "319f8fa2-273d-7200-a92e-0a85c7e3e9bc";
  const targetPath = claudeSessionFilePath(home, projectRoot, SESSION_ID);
  await symlink(targetPath, claudeSessionFilePath(home, projectRoot, linkId));
  await assert.rejects(
    deleteOwnedClaudeSessionFile({
      claudeHome: home,
      projectRoot,
      nativeSessionId: linkId
    }),
    (error: unknown) =>
      error instanceof DomainError && error.code === "native_session_path_invalid"
  );
  assert.equal((await lstat(targetPath)).isFile(), true);
});
