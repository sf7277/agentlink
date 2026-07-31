import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { join } from "node:path";
import { sanitizeDiagnostic } from "../core/application/safe-diagnostics.js";
import { assertPrivateOwnedDirectory } from "./application-paths.js";

export const MANAGED_LOG_MAX_BYTES = 1024 * 1024;
export const MANAGED_LOG_HISTORY = 3;
export const MANAGED_LOG_RECORD_MAX_BYTES = 64 * 1024;

type LogStream = "stdout" | "stderr";

export class ManagedLogSink {
  readonly #files = new Map<LogStream, ManagedLogFile>();

  private constructor(logDirectory: string) {
    this.#files.set(
      "stdout",
      new ManagedLogFile(join(logDirectory, "gateway.stdout.log"))
    );
    this.#files.set(
      "stderr",
      new ManagedLogFile(join(logDirectory, "gateway.stderr.log"))
    );
  }

  public static async create(logDirectory: string): Promise<ManagedLogSink> {
    await assertPrivateOwnedDirectory(logDirectory);
    return new ManagedLogSink(logDirectory);
  }

  public write(stream: LogStream, record: string): void {
    this.#files.get(stream)!.write(normalizeRecord(record));
  }

  public close(): void {
    for (const file of this.#files.values()) file.close();
    this.#files.clear();
  }
}

class ManagedLogFile {
  #descriptor: number;
  #size: number;

  public constructor(readonly path: string) {
    assertManagedFilesSafe(path);
    this.#descriptor = openManagedFile(path);
    this.#size = fstatSync(this.#descriptor).size;
    if (this.#size >= MANAGED_LOG_MAX_BYTES) {
      closeSync(this.#descriptor);
      rotate(path);
      this.#descriptor = openManagedFile(path);
      this.#size = 0;
    }
  }

  public write(record: Buffer): void {
    if (this.#size + record.length > MANAGED_LOG_MAX_BYTES) {
      closeSync(this.#descriptor);
      rotate(this.path);
      this.#descriptor = openManagedFile(this.path);
      this.#size = 0;
    }
    let offset = 0;
    while (offset < record.length) {
      offset += writeSync(this.#descriptor, record, offset, record.length - offset);
    }
    this.#size += record.length;
  }

  public close(): void {
    if (this.#descriptor >= 0) {
      closeSync(this.#descriptor);
      this.#descriptor = -1;
    }
  }
}

function normalizeRecord(record: string): Buffer {
  const withNewline = record.endsWith("\n") ? record : `${record}\n`;
  const bytes = Buffer.from(withNewline, "utf8");
  if (bytes.length <= MANAGED_LOG_RECORD_MAX_BYTES) return bytes;
  const truncated = JSON.stringify({
    event: "log_record_truncated",
    status: "warning",
    originalBytes: bytes.length,
    message: sanitizeDiagnostic(record, 60 * 1024)
  });
  const normalized = Buffer.from(`${truncated}\n`, "utf8");
  if (normalized.length > MANAGED_LOG_RECORD_MAX_BYTES) {
    throw new Error("Managed log truncation exceeded the record boundary");
  }
  return normalized;
}

function assertManagedFilesSafe(path: string): void {
  for (let index = 0; index <= MANAGED_LOG_HISTORY; index += 1) {
    const candidate = index === 0 ? path : `${path}.${index}`;
    let metadata;
    try {
      metadata = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const uid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (uid !== undefined && metadata.uid !== uid) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error(`AgentLink log path is not a trusted private regular file: ${candidate}`);
    }
  }
}

function openManagedFile(path: string): number {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  const metadata = fstatSync(descriptor);
  const uid = process.getuid?.();
  if (!metadata.isFile() || (uid !== undefined && metadata.uid !== uid)) {
    closeSync(descriptor);
    throw new Error("AgentLink log descriptor is not a trusted owned regular file");
  }
  return descriptor;
}

function rotate(path: string): void {
  for (let index = MANAGED_LOG_HISTORY; index >= 1; index -= 1) {
    const source = index === 1 ? path : `${path}.${index - 1}`;
    const destination = `${path}.${index}`;
    try {
      if (index === MANAGED_LOG_HISTORY) unlinkSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      renameSync(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
