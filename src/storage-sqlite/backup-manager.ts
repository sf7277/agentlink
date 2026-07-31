import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  open,
  rename,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";

export class SqliteBackupManager {
  public async backup(sourcePath: string, destinationPath: string): Promise<void> {
    await assertTrustedDatabase(sourcePath);
    await assertPrivateDirectory(dirname(destinationPath));
    const temporary = `${destinationPath}.tmp-${randomUUID()}`;
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(temporary);
    } finally {
      source.close();
    }
    try {
      await finalizeStandaloneDatabase(temporary);
      await chmod(temporary, 0o600);
      await syncFile(temporary);
      await rename(temporary, destinationPath);
      await syncDirectory(dirname(destinationPath));
    } catch (error) {
      await safeUnlink(temporary);
      throw error;
    } finally {
      await removeSidecars(temporary);
    }
  }

  public async restore(backupPath: string, destinationPath: string): Promise<void> {
    await assertTrustedDatabase(backupPath);
    await validateDatabase(backupPath);
    const parent = dirname(destinationPath);
    await assertPrivateDirectory(parent);
    if (resolve(backupPath) === resolve(destinationPath)) {
      throw new Error("SQLite backup and destination must be different files");
    }
    const suffix = randomUUID();
    const candidate = join(parent, `.agentlink-db-candidate-${suffix}`);
    const rollback = join(parent, `.agentlink-db-rollback-${suffix}`);
    let hadDestination = false;
    let backedUp = false;
    let installed = false;
    let committed = false;
    try {
      await copyFile(
        backupPath,
        candidate,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
      );
      await chmod(candidate, 0o600);
      await syncFile(candidate);
      await validateDatabase(candidate);
      const existing = await optionalLstat(destinationPath);
      if (existing !== undefined) {
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new Error("SQLite restore destination is not a regular file");
        }
        hadDestination = true;
        await rename(destinationPath, rollback);
        backedUp = true;
      }
      await rename(candidate, destinationPath);
      installed = true;
      await syncDirectory(parent);
      await validateDatabase(destinationPath);
      if (backedUp) await unlink(rollback);
      committed = true;
      await syncDirectory(parent);
    } catch (error) {
      if (committed) {
        throw new Error("SQLite restore completed but final durability confirmation failed", {
          cause: error
        });
      }
      if (installed) await safeUnlink(destinationPath);
      if (backedUp) {
        try {
          await rename(rollback, destinationPath);
          await syncDirectory(parent);
        } catch (rollbackError) {
          throw new Error("SQLite restore failed and rollback is uncertain", { cause: rollbackError });
        }
      }
      await safeUnlink(candidate);
      throw new Error(
        hadDestination ? "SQLite restore failed and previous database was restored" : "SQLite restore failed",
        { cause: error }
      );
    } finally {
      await safeUnlink(candidate);
    }
  }
}

async function assertTrustedDatabase(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(`SQLite file is not private and trusted: ${basename(path)}`);
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("SQLite backup directory must be private and owned by this user");
  }
}

async function validateDatabase(path: string): Promise<void> {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = database.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error("SQLite integrity check failed");
  } finally {
    database.close();
  }
}

async function finalizeStandaloneDatabase(path: string): Promise<void> {
  const database = new Database(path, { fileMustExist: true });
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
    const result = database.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error("SQLite integrity check failed");
  } finally {
    database.close();
  }
  await removeSidecars(path);
}

async function removeSidecars(path: string): Promise<void> {
  await Promise.all([
    safeUnlink(`${path}-wal`),
    safeUnlink(`${path}-shm`)
  ]);
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function optionalLstat(path: string) {
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
