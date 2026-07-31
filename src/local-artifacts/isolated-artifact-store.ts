import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rmdir,
  unlink,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DomainError } from "../core/domain/errors.js";

export interface ArtifactRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly path: string;
  readonly mediaType: string;
  readonly size: number;
  readonly expiresAt: string;
}

export interface IsolatedArtifactStoreOptions {
  readonly root: string;
  readonly maxBytes?: number;
  readonly retentionMs?: number;
  readonly allowedMediaTypes?: ReadonlySet<string>;
}

export class IsolatedArtifactStore {
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #retentionMs: number;
  readonly #allowedMediaTypes: ReadonlySet<string>;

  public constructor(options: IsolatedArtifactStoreOptions) {
    this.#root = resolve(options.root);
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.#retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
    this.#allowedMediaTypes = options.allowedMediaTypes ?? new Set([
      "image/jpeg", "image/png", "text/plain"
    ]);
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(this.#root);
    await chmod(this.#root, 0o700);
  }

  public async put(
    sessionId: string,
    mediaType: string,
    bytes: Uint8Array,
    now = new Date()
  ): Promise<ArtifactRecord> {
    validateSegment(sessionId, "Session ID");
    if (!this.#allowedMediaTypes.has(mediaType)) {
      throw new DomainError("artifact_type_unsupported", "Artifact media type is not allowed");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > this.#maxBytes) {
      throw new DomainError("artifact_size_invalid", "Artifact size is outside the allowed range");
    }
    await this.initialize();
    const sessionRoot = join(this.#root, sessionId);
    await mkdir(sessionRoot, { mode: 0o700 });
    await assertOwnedDirectory(sessionRoot);
    await chmod(sessionRoot, 0o700);
    const id = randomUUID();
    const path = join(sessionRoot, id);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return {
      id,
      sessionId,
      path,
      mediaType,
      size: bytes.byteLength,
      expiresAt: new Date(now.getTime() + this.#retentionMs).toISOString()
    };
  }

  public async delete(record: ArtifactRecord): Promise<void> {
    validateSegment(record.sessionId, "Session ID");
    validateSegment(record.id, "Artifact ID");
    const expected = resolve(this.#root, record.sessionId, record.id);
    if (resolve(record.path) !== expected) {
      throw new DomainError("artifact_path_invalid", "Artifact path is outside its Session");
    }
    await unlink(expected).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  public async cleanup(now = new Date()): Promise<number> {
    await this.initialize();
    const cutoff = now.getTime() - this.#retentionMs;
    let removed = 0;
    for (const session of await readdir(this.#root, { withFileTypes: true })) {
      const sessionPath = join(this.#root, session.name);
      if (session.isSymbolicLink()) {
        await unlink(sessionPath);
        removed += 1;
        continue;
      }
      if (!session.isDirectory()) continue;
      await assertOwnedDirectory(sessionPath);
      for (const entry of await readdir(sessionPath, { withFileTypes: true })) {
        const path = join(sessionPath, entry.name);
        const metadata = await lstat(path);
        if (entry.isSymbolicLink() || (metadata.isFile() && metadata.mtimeMs <= cutoff)) {
          await unlink(path);
          removed += 1;
        }
      }
      await rmdir(sessionPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTEMPTY") throw error;
      });
    }
    return removed;
  }
}

async function assertOwnedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new DomainError("artifact_directory_invalid", "Artifact directory is not a real directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new DomainError("artifact_owner_invalid", "Artifact directory belongs to another user");
  }
}

function validateSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new DomainError("artifact_segment_invalid", `${label} contains unsupported characters`);
  }
}
