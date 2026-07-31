import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  rename,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AtomicInstallError, type ReleaseInstaller } from "./update-coordinator.js";

export class AtomicFileInstaller implements ReleaseInstaller {
  public constructor(private readonly options: {
    readonly healthCheck?: (installedPath: string) => Promise<void>;
    readonly maxArtifactBytes?: number;
  } = {}) {}

  public async install(input: {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly expectedSha256: string;
    readonly expectedSize: number;
  }): Promise<void> {
    const targetPath = resolve(input.targetPath);
    const parent = dirname(targetPath);
    if (basename(targetPath) === "." || basename(targetPath) === "..") {
      throw new AtomicInstallError("unchanged", "Install target is invalid");
    }
    await assertPrivateDirectory(parent);
    const source = await openVerifiedSource(
      input.sourcePath,
      input.expectedSize,
      input.expectedSha256,
      this.options.maxArtifactBytes ?? 1024 * 1024 * 1024
    );
    const suffix = randomUUID();
    const candidate = join(parent, `.agentlink-candidate-${suffix}`);
    const backup = join(parent, `.agentlink-rollback-${suffix}`);
    let hadTarget = false;
    let targetBackedUp = false;
    let candidateInstalled = false;
    let committed = false;
    try {
      await copyVerifiedHandle(source, candidate, input.expectedSize);
      await chmod(candidate, 0o700);
      await syncDirectory(parent);
      const existing = await safeLstat(targetPath);
      if (existing !== undefined) {
        if (!existing.isFile() || existing.uid !== process.getuid?.()) {
          throw new AtomicInstallError("unchanged", "Existing install target is not a trusted regular file");
        }
        hadTarget = true;
        await rename(targetPath, backup);
        targetBackedUp = true;
      }
      await rename(candidate, targetPath);
      candidateInstalled = true;
      await syncDirectory(parent);
      await verifyPath(targetPath, input.expectedSize, input.expectedSha256);
      await this.options.healthCheck?.(targetPath);
      if (targetBackedUp) await unlink(backup);
      committed = true;
      await syncDirectory(parent);
    } catch (error) {
      if (committed) {
        throw new AtomicInstallError(
          "unknown",
          "Release was replaced but final durability confirmation failed",
          { cause: error }
        );
      }
      if (!candidateInstalled) {
        if (targetBackedUp) {
          try {
            await rename(backup, targetPath);
            await syncDirectory(parent);
          } catch (rollbackError) {
            throw new AtomicInstallError(
              "unknown",
              "Update failed and the previous release could not be restored",
              { cause: rollbackError }
            );
          }
        }
        await safeUnlink(candidate);
        if (error instanceof AtomicInstallError) throw error;
        throw new AtomicInstallError("unchanged", "Update staging failed", { cause: error });
      }
      try {
        await unlink(targetPath);
        if (hadTarget) await rename(backup, targetPath);
        await syncDirectory(parent);
      } catch (rollbackError) {
        throw new AtomicInstallError(
          "unknown",
          "Installed release failed validation and rollback was uncertain",
          { cause: rollbackError }
        );
      }
      throw new AtomicInstallError(
        "rolled_back",
        "Installed release failed validation and was rolled back",
        { cause: error }
      );
    } finally {
      await source.close();
      await safeUnlink(candidate);
    }
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new AtomicInstallError("unchanged", "Install directory must be private and owned by this user");
  }
}

async function openVerifiedSource(
  path: string,
  expectedSize: number,
  expectedSha256: string,
  maxBytes: number
) {
  if (expectedSize > maxBytes) {
    throw new AtomicInstallError("unchanged", "Update artifact exceeds installer size limit");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new AtomicInstallError("unchanged", "Update artifact cannot be opened safely", { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size !== expectedSize
    ) {
      throw new AtomicInstallError("unchanged", "Update artifact metadata does not match");
    }
    const digest = await digestHandle(handle, stat.size);
    if (digest !== expectedSha256) {
      throw new AtomicInstallError("unchanged", "Update artifact hash does not match");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copyVerifiedHandle(
  source: Awaited<ReturnType<typeof open>>,
  destination: string,
  size: number
): Promise<void> {
  const target = await open(destination, "wx", 0o700);
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) throw new Error("Update artifact changed while staging");
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(chunk, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await target.sync();
  } finally {
    await target.close();
  }
}

async function verifyPath(path: string, size: number, sha256: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== size || await digestHandle(handle, size) !== sha256) {
      throw new Error("Installed artifact verification failed");
    }
  } finally {
    await handle.close();
  }
}

async function digestHandle(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== size) throw new Error("Update artifact ended unexpectedly");
  return hash.digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
