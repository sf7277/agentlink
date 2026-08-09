import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions
} from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Windows environment variables required to launch .cmd/.bat through cmd.exe. */
const WINDOWS_LAUNCH_ENV_NAMES = [
  "Path",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA"
] as const;

export interface CaptureCommandOutputOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Capture stdout from a trusted command. On Windows, .cmd/.bat files are
 * launched through the controlled cmd.exe launcher instead of execFile(),
 * which cannot start .cmd/.bat directly (EINVAL). The caller-provided
 * environment is layered over Windows launch essentials so cmd.exe and the
 * batch file's inner commands resolve without ambient variables.
 */
export async function captureCommandOutput(
  command: string,
  args: readonly string[],
  options: CaptureCommandOutputOptions = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 16 * 1024;
  const environment = {
    ...(process.platform === "win32"
      ? Object.fromEntries(
        WINDOWS_LAUNCH_ENV_NAMES.flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        })
      )
      : {}),
    ...(options.env ?? {})
  };
  const child = spawnWindowsAgent(command, [...args], {
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  return await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (process.platform === "win32") void forceKillWindowsProcessTree(child);
      else child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
        fail(new Error(`Command output exceeds ${maxBytes} bytes: ${command}`));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    child.once("error", (error) => {
      fail(error instanceof Error ? error : new Error(`Could not start command: ${command}`));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const diagnostic = stderr === "" ? "" : `\n${stderr.slice(0, 2_000)}`;
      reject(new Error(
        `Command failed with code=${String(code)} signal=${String(signal)}: ${command}${diagnostic}`
      ));
    });
  });
}

/** Spawn a trusted .exe directly, or a trusted batch file through cmd.exe. */
export function spawnWindowsAgent(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {}
): ChildProcessWithoutNullStreams {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command)) {
    const { shell: _shell, windowsVerbatimArguments: _ignored, ...spawnOptions } = options;
    return spawn(command, [...args], { ...spawnOptions, shell: false }) as ChildProcessWithoutNullStreams;
  }
  for (const value of [command, ...args]) {
    if (/[&|<>^%!\r\n"]/u.test(value)) {
      throw new Error("Windows batch Agent arguments contain unsupported shell characters");
    }
  }
  const comspec = process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "C:\\Windows\\System32\\cmd.exe";
  // cmd.exe /s strips the first and last quote of the command string, so the
  // full line must be wrapped in an extra pair of quotes to preserve quoting.
  const inner = [`"${command}"`, ...args.map((value) => `"${value}"`)].join(" ");
  const commandLine = `"${inner}"`;
  return spawn(comspec, ["/d", "/s", "/c", commandLine], {
    ...options,
    shell: false,
    windowsVerbatimArguments: true
  }) as ChildProcessWithoutNullStreams;
}

export async function forceKillWindowsProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  const taskkill = `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\taskkill.exe`;
  await execFileAsync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
    timeout: 5_000,
    windowsHide: true,
    env: {
      SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
      Path: process.env["Path"] ?? process.env["PATH"] ?? ""
    }
  }).catch(() => undefined);
}
