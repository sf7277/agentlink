import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CredentialStore } from "../core/contracts/ports.js";
import { sanitizeDiagnostic as sanitizeSafeDiagnostic } from "../core/application/safe-diagnostics.js";

export interface KeychainCredentialStoreOptions {
  readonly service?: string;
  readonly helperPath?: string;
  readonly maxOutputBytes?: number;
}

export class KeychainCredentialStore implements CredentialStore {
  readonly #service: string;
  readonly #helperPath: string;
  readonly #maxOutputBytes: number;

  public constructor(options: KeychainCredentialStoreOptions = {}) {
    this.#service = options.service ?? "com.agentlink.credentials";
    this.#helperPath = options.helperPath ??
      fileURLToPath(new URL("./agentlink-keychain-helper", import.meta.url));
    this.#maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  }

  public async put(reference: string, secret: string): Promise<void> {
    validateReference(reference);
    if (secret.length === 0) throw new Error("Credential secret must not be empty");
    await this.run(["put", this.#service, reference], secret);
  }

  public async get(reference: string): Promise<string | undefined> {
    validateReference(reference);
    const result = await this.run(
      ["get", this.#service, reference],
      undefined,
      new Set([0, 44])
    );
    return result.code === 44 ? undefined : result.stdout.replace(/\r?\n$/u, "");
  }

  public async delete(reference: string): Promise<void> {
    validateReference(reference);
    await this.run(
      ["delete", this.#service, reference],
      undefined,
      new Set([0, 44])
    );
  }

  public async listReferences(): Promise<readonly string[]> {
    const result = await this.run(["list", this.#service]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("macOS Keychain returned an invalid reference list");
    }
    if (!Array.isArray(parsed) || !parsed.every((item) =>
      typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item)
    )) {
      throw new Error("macOS Keychain returned an unsafe reference list");
    }
    return parsed;
  }

  public async cleanupPendingReferences(): Promise<number> {
    const pending = (await this.listReferences()).filter((reference) =>
      reference.includes(".pending.")
    );
    for (const reference of pending) await this.delete(reference);
    return pending.length;
  }

  private run(
    args: readonly string[],
    stdin?: string,
    acceptedExitCodes = new Set([0])
  ): Promise<{ readonly code: number; readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#helperPath, [...args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: allowedEnvironment(process.env)
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>
      ): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > this.#maxOutputBytes) {
          child.kill("SIGKILL");
          reject(new Error("macOS Keychain command output exceeded limit"));
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => reject(error));
      child.once("exit", (code, signal) => {
        const resolvedCode = code ?? -1;
        if (signal !== null) {
          reject(new Error(`macOS Keychain command terminated by ${signal}`));
        } else if (!acceptedExitCodes.has(resolvedCode)) {
          reject(new Error(
            `macOS Keychain command failed (${resolvedCode}): ${sanitizeDiagnostic(stderr)}`
          ));
        } else {
          resolve({ code: resolvedCode, stdout: stdout.toString("utf8") });
        }
      });
      if (stdin === undefined) child.stdin.end();
      else child.stdin.end(stdin, "utf8");
    });
  }
}

function allowedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const names = ["HOME", "PATH", "TMPDIR"];
  return Object.fromEntries(names.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function validateReference(reference: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(reference)) {
    throw new Error("Credential reference contains unsupported characters");
  }
}

function sanitizeDiagnostic(value: Buffer<ArrayBufferLike>): string {
  return sanitizeSafeDiagnostic(value);
}
