import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { JsonlTransport } from "../protocol/acp-rpc-client.js";
import { BoundedTail } from "./bounded-tail.js";
import { sanitizeDiagnostic } from "../../core/application/safe-diagnostics.js";

export interface ChildTransportOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly maxLineBytes?: number;
  readonly stderrTailBytes?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export class ChildProcessTransport extends EventEmitter implements JsonlTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #maxLineBytes: number;
  readonly #stderrTail: BoundedTail;
  #stdoutBuffer = Buffer.alloc(0);
  #closed = false;

  public constructor(options: ChildTransportOptions = {}) {
    super();
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.#stderrTail = new BoundedTail(options.stderrTailBytes ?? 64 * 1024);
    const environment = allowedGrokEnvironment(options.environment ?? process.env);
    this.#child = spawn(
      options.command ?? "grok",
      [...(options.args ?? ["agent", "--no-leader", "stdio"])],
      {
        cwd: options.cwd,
        env: { ...environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    this.#child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) =>
      this.#stderrTail.append(sanitizeDiagnostic(
        chunk,
        Math.max(16, this.#stderrTail.capacity())
      ))
    );
    this.#child.once("error", (error) => this.finish(error));
    this.#child.once("exit", (code, signal) => {
      this.finish(new Error(`Grok agent exited code=${String(code)} signal=${String(signal)}`));
    });
  }

  public writeLine(line: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Grok agent process is closed"));
    return new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${line}\n`, "utf8", (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
  }

  public onLine(listener: (line: string) => void): void {
    this.on("line", listener);
  }

  public onClose(listener: (error?: Error) => void): void {
    this.on("transportClose", listener);
  }

  public stderrTail(): string {
    return this.#stderrTail.read();
  }

  public alive(): boolean {
    return !this.#closed;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, 2_000);
      force.unref();
      this.#child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
    });
  }

  private handleStdout(chunk: Buffer): void {
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    if (this.#stdoutBuffer.length > this.#maxLineBytes && !this.#stdoutBuffer.includes(0x0a)) {
      this.finish(new Error("Grok agent stdout line exceeds limit"));
      this.#child.kill("SIGKILL");
      return;
    }
    let newline = this.#stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const lineBuffer = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (lineBuffer.length > this.#maxLineBytes) {
        this.finish(new Error("Grok agent stdout line exceeds limit"));
        this.#child.kill("SIGKILL");
        return;
      }
      this.emit("line", lineBuffer.toString("utf8"));
      newline = this.#stdoutBuffer.indexOf(0x0a);
    }
  }

  private finish(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("transportClose", error);
  }
}

export function allowedGrokEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const names = ["HOME", "PATH", "TMPDIR", "GROK_HOME"];
  return Object.fromEntries(names.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}
