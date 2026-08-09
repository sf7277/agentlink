import { chmod, lstat, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { assertWindowsPrivatePath } from "../../platform-windows/security.js";

/**
 * Prepare an isolated GROK_HOME for AgentLink-managed Grok processes.
 * OAuth auth remains independent, while the native TUI policy file is read in
 * place so AgentLink does not create a second permission policy.
 */
export async function prepareIsolatedGrokHome(
  root: string,
  nativeGrokHome?: string
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(root);
  const canonicalRoot = await realpath(root);
  await linkNativePolicyConfig(canonicalRoot, nativeGrokHome);
  await prepareIndependentAuthFile(join(canonicalRoot, "auth.json"));
  return canonicalRoot;
}

async function linkNativePolicyConfig(root: string, nativeGrokHome: string | undefined): Promise<void> {
  const target = join(root, "config.toml");
  const source = nativeGrokHome === undefined ? undefined : join(nativeGrokHome, "config.toml");
  if (source === undefined) return;
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Grok native config must be a regular file");
  }
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(source, "file");
  } else {
    const uid = process.getuid?.();
    if ((uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o022) !== 0) {
      throw new Error("Grok native config must be an owned non-writable regular file");
    }
  }
  const canonicalSource = await realpath(source);
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    if (!existing.isFile() && !existing.isSymbolicLink()) {
      throw new Error("Grok isolated config must be a regular file or symlink");
    }
    await rm(target, { force: true });
  }
  await symlink(canonicalSource, target);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Grok isolated home must be a private canonical directory");
  }
  if (process.platform === "win32") {
    await assertWindowsPrivatePath(path, "directory");
    return;
  }
  const uid = process.getuid?.();
  if ((uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o077) !== 0) {
    throw new Error("Grok isolated home must be a private canonical directory");
  }
  await chmod(path, 0o700);
}

async function prepareIndependentAuthFile(path: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (process.platform === "win32") {
    if (!metadata.isFile()) {
      throw new Error("Grok isolated auth must be a private owned regular file");
    }
    await assertWindowsPrivatePath(path, "file");
    return;
  }
  const uid = process.getuid?.();
  if (
    !metadata.isFile() || metadata.nlink !== 1 ||
    (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Grok isolated auth must be a private owned regular file");
  }
}
