import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DomainError } from "../../core/domain/errors.js";

/**
 * Write boundary for the shared user-owned ~/.claude directory.
 *
 * AgentLink deliberately shares the interactive TUI's Claude home (owner
 * decision). The only writes allowed through this module are:
 *   1. nothing — session files are written by the claude subprocess itself;
 *   2. deleting an AGENTLINK-owned session JSONL whose id matches exactly.
 * Credentials, settings, CLAUDE.md, other session files and the Keychain are
 * never read or modified here.
 */

const SAFE_NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function isSafeClaudeNativeSessionId(value: string): boolean {
  return SAFE_NATIVE_SESSION_ID.test(value);
}

/**
 * Claude Code stores sessions under projects/<encoded-cwd>/ where every
 * non-alphanumeric byte of the canonical cwd is replaced by "-". This must
 * stay byte-identical with the CLI's own encoding; integration tests assert
 * it against a native-session-compatible fixture.
 */
export function encodedClaudeProjectDirectory(projectRoot: string): string {
  return projectRoot.replace(/[^A-Za-z0-9]/gu, "-");
}

export function claudeSessionFilePath(
  claudeHome: string,
  projectRoot: string,
  nativeSessionId: string
): string {
  if (!isSafeClaudeNativeSessionId(nativeSessionId)) {
    throw new DomainError(
      "native_session_id_invalid",
      "Claude原生Session标识不安全，拒绝访问"
    );
  }
  return join(
    claudeHome,
    "projects",
    encodedClaudeProjectDirectory(projectRoot),
    `${nativeSessionId}.jsonl`
  );
}

export type ClaudeSessionFileState = "missing" | "file" | "other";

/**
 * Verifies the session directory really lives directly under
 * <claudeHome>/projects. Checking only the final path component would let a
 * symlinked `projects/<encoded>` directory redirect reads and deletes outside
 * the boundary.
 */
async function assertContainedSessionDirectory(
  claudeHome: string,
  projectRoot: string
): Promise<void> {
  const projectsDirectory = join(claudeHome, "projects");
  const sessionDirectory = join(
    projectsDirectory,
    encodedClaudeProjectDirectory(projectRoot)
  );
  const [canonicalProjects, canonicalSession] = await Promise.all([
    realpath(projectsDirectory),
    realpath(sessionDirectory)
  ]);
  if (dirname(canonicalSession) !== canonicalProjects) {
    throw new DomainError(
      "native_session_path_invalid",
      "Claude会话目录不在受管的projects目录内，拒绝访问"
    );
  }
}

export async function claudeSessionFileState(
  claudeHome: string,
  projectRoot: string,
  nativeSessionId: string
): Promise<ClaudeSessionFileState> {
  const path = claudeSessionFilePath(claudeHome, projectRoot, nativeSessionId);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  try {
    await assertContainedSessionDirectory(claudeHome, projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    if (error instanceof DomainError) return "other";
    throw error;
  }
  const uid = process.getuid?.();
  return metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    (uid === undefined || metadata.uid === uid)
    ? "file"
    : "other";
}

export interface ClaudeSessionDeleteOptions {
  readonly claudeHome: string;
  readonly projectRoot: string;
  readonly nativeSessionId: string;
}

/**
 * Deletes exactly one session JSONL. Missing before deletion is a no-op;
 * anything that is not a privately owned regular file is refused so the
 * boundary can never follow a symlink or remove foreign data.
 */
export async function deleteOwnedClaudeSessionFile(
  options: ClaudeSessionDeleteOptions
): Promise<void> {
  const path = claudeSessionFilePath(
    options.claudeHome,
    options.projectRoot,
    options.nativeSessionId
  );
  const before = await claudeSessionFileState(
    options.claudeHome,
    options.projectRoot,
    options.nativeSessionId
  );
  if (before === "missing") return;
  if (before !== "file") {
    throw new DomainError(
      "native_session_path_invalid",
      "Claude原生Session路径不是当前用户私有的普通文件，拒绝删除"
    );
  }
  // Re-assert containment immediately before removal so the check cannot be
  // satisfied by a directory that was swapped after the state probe.
  await assertContainedSessionDirectory(options.claudeHome, options.projectRoot);
  await rm(path, { force: false });
  const after = await claudeSessionFileState(
    options.claudeHome,
    options.projectRoot,
    options.nativeSessionId
  );
  if (after !== "missing") {
    throw new Error("Claude Session delete could not be verified");
  }
}
