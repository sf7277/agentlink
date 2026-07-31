import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DomainError } from "../../core/domain/errors.js";
import { allowedGrokEnvironment } from "./child-process-transport.js";

const execFileAsync = promisify(execFile);
const SAFE_NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface GrokNativeSessionDeleteOptions {
  readonly command: string;
  readonly grokHome: string;
  readonly projectRoot: string;
  readonly nativeSessionId: string;
  readonly timeoutMs?: number;
  readonly execute?: (
    command: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>>
  ) => Promise<void>;
}

export async function deleteGrokNativeSession(
  options: GrokNativeSessionDeleteOptions
): Promise<void> {
  if (!SAFE_NATIVE_SESSION_ID.test(options.nativeSessionId)) {
    throw new DomainError(
      "native_session_id_invalid",
      "Grok原生Session标识不安全，拒绝删除"
    );
  }
  const nativePath = join(
    options.grokHome,
    "sessions",
    encodeURIComponent(options.projectRoot),
    options.nativeSessionId
  );
  const before = await nativeSessionPathState(nativePath);
  if (before === "missing") return;
  if (before !== "directory") {
    throw new DomainError(
      "native_session_path_invalid",
      "Grok原生Session路径不是可信目录，拒绝删除"
    );
  }

  let commandError: unknown;
  try {
    const environment = allowedGrokEnvironment({
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      TMPDIR: process.env["TMPDIR"] ?? "/tmp",
      GROK_HOME: options.grokHome
    });
    if (options.execute !== undefined) {
      await options.execute(
        options.command,
        ["sessions", "delete", options.nativeSessionId],
        environment
      );
    } else {
      await execFileAsync(
        options.command,
        ["sessions", "delete", options.nativeSessionId],
        {
          env: environment,
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: 64 * 1024,
          encoding: "utf8"
        }
      );
    }
  } catch (error) {
    commandError = error;
  }

  const after = await nativeSessionPathState(nativePath);
  if (after === "missing") return;
  if (after !== "directory") {
    throw new Error("Grok Session delete left an untrusted native path");
  }
  if (commandError !== undefined && isDefiniteCommandRejection(commandError)) {
    throw new DomainError(
      "native_delete_rejected",
      "Grok CLI未删除目标Session，原生状态保持不变"
    );
  }
  if (commandError !== undefined) {
    throw new Error("Grok CLI delete result could not be verified", { cause: commandError });
  }
  throw new DomainError(
    "native_delete_not_applied",
    "Grok CLI返回成功，但目标Session仍存在"
  );
}

async function nativeSessionPathState(
  path: string
): Promise<"missing" | "directory" | "other"> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function isDefiniteCommandRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = error as Error & {
    code?: string | number;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
  return detail.killed !== true &&
    (detail.signal === undefined || detail.signal === null) &&
    detail.code !== "ETIMEDOUT";
}
