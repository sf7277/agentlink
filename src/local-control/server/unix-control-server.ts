import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { ZodError } from "zod";
import type {
  LocalControlEvent,
  LocalControlPort
} from "../../core/contracts/ports.js";
import { sanitizeDiagnostic } from "../../core/application/safe-diagnostics.js";
import { parseLocalControlEvent } from "../protocol.js";

export interface UnixControlServerOptions {
  readonly maxLineBytes?: number;
  readonly maxPublishedBytes?: number;
  readonly maxRequestsPerMinute?: number;
  readonly allowedEndpointIds?: ReadonlySet<string>;
}

export class UnixControlServer implements LocalControlPort {
  readonly #clients = new Set<Socket>();
  #requestTimes: number[] = [];
  readonly #maxLineBytes: number;
  readonly #maxPublishedBytes: number;
  readonly #maxRequestsPerMinute: number;
  readonly #allowedEndpointIds: ReadonlySet<string>;
  #server: Server | undefined;
  #handler: ((event: LocalControlEvent) => Promise<unknown>) | undefined;

  public constructor(
    private readonly socketPath: string,
    options: UnixControlServerOptions = {}
  ) {
    this.#maxLineBytes = options.maxLineBytes ?? 64 * 1024;
    this.#maxPublishedBytes = options.maxPublishedBytes ?? 64 * 1024;
    this.#maxRequestsPerMinute = options.maxRequestsPerMinute ?? 120;
    this.#allowedEndpointIds = options.allowedEndpointIds ?? new Set(["local-cli"]);
  }

  public async start(onEvent: (event: LocalControlEvent) => Promise<unknown>): Promise<void> {
    if (this.#server !== undefined) throw new Error("Local control server is already started");
    if (Buffer.byteLength(this.socketPath, "utf8") > 103) {
      throw new Error("Local control socket path exceeds the macOS Unix Socket limit");
    }
    this.#handler = onEvent;
    await this.assertPrivateParent();
    await this.removeStaleSocket();
    this.#server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.socketPath, () => resolve());
    });
    await chmod(this.socketPath, 0o600);
  }

  public async stop(): Promise<void> {
    for (const client of this.#clients) client.destroy();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
    await unlink(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  public publish(sessionId: string, payload: Readonly<Record<string, unknown>>): void {
    const line = `${JSON.stringify({ sessionId, payload })}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maxPublishedBytes) {
      throw new Error("Local control publication exceeds size limit");
    }
    for (const client of this.#clients) client.write(line);
  }

  private accept(socket: Socket): void {
    this.#clients.add(socket);
    socket.on("close", () => this.#clients.delete(socket));
    socket.on("error", () => undefined);
    let pendingLineBytes = 0;
    socket.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        pendingLineBytes = byte === 0x0a ? 0 : pendingLineBytes + 1;
        if (pendingLineBytes > this.#maxLineBytes) {
          socket.destroy(new Error("Local control request exceeds size limit"));
          return;
        }
      }
    });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => {
      void this.handleLine(socket, line);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    try {
      if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
        throw new Error("Local control request exceeds size limit");
      }
      this.assertRate();
      const event = parseLocalControlEvent(JSON.parse(line) as unknown);
      if (!this.#allowedEndpointIds.has(event.endpointId)) {
        throw new Error("Local control endpoint is not authorized");
      }
      const result = await this.#handler?.(event);
      socket.write(`${JSON.stringify({
        ok: true,
        ...(result === undefined ? {} : { result })
      })}\n`);
    } catch (error) {
      const message = error instanceof ZodError || error instanceof SyntaxError
        ? "Invalid local control request"
        : sanitizeDiagnostic(error instanceof Error ? error.message : "Invalid request");
      socket.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    }
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const metadata = await lstat(this.socketPath);
      if (!metadata.isSocket()) throw new Error("Refusing to replace a non-socket local control path");
      const uid = process.getuid?.();
      if (uid !== undefined && metadata.uid !== uid) {
        throw new Error("Refusing to replace a socket owned by another user");
      }
      await this.assertNoActiveGateway();
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async assertNoActiveGateway(): Promise<void> {
    const state = await new Promise<"active" | "stale" | "indeterminate">((resolve) => {
      const socket = createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve("indeterminate");
      }, 1_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve("active");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
          resolve("stale");
          return;
        }
        resolve("indeterminate");
      });
    });
    if (state === "active") {
      throw new Error("Local control server is already active");
    }
    if (state === "indeterminate") {
      throw new Error("Refusing to replace a local control socket whose activity is unknown");
    }
  }

  private async assertPrivateParent(): Promise<void> {
    const metadata = await lstat(dirname(this.socketPath));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Local control socket parent is not a real directory");
    }
    const uid = process.getuid?.();
    if (uid !== undefined && metadata.uid !== uid) {
      throw new Error("Local control socket parent belongs to another user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Local control socket parent must not be accessible by group or others");
    }
  }

  private assertRate(): void {
    const now = Date.now();
    const cutoff = now - 60_000;
    this.#requestTimes = this.#requestTimes.filter((item) => item > cutoff);
    if (this.#requestTimes.length >= this.#maxRequestsPerMinute) {
      throw new Error("Local control request rate exceeded");
    }
    this.#requestTimes.push(now);
  }
}
