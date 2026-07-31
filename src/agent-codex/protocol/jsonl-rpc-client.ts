import { EventEmitter } from "node:events";
import { parseInbound, type RpcError, type RpcId } from "./wire.js";

export interface JsonlTransport {
  writeLine(line: string): Promise<void>;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
}

export interface ReverseRequest {
  readonly id: RpcId;
  readonly method: string;
  readonly params: unknown;
  respond(result: unknown): Promise<void>;
  reject(error: RpcError): Promise<void>;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface JsonlRpcClientOptions {
  readonly maxLineBytes?: number;
  readonly maxPendingRequests?: number;
  readonly requestTimeoutMs?: number;
}

// thread/resume always returns historical Turns and has no includeTurns switch in Codex 0.144.x.
// Keep a bounded but independent protocol envelope; channel output limits are not protocol limits.
export const CODEX_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class RpcResponseError extends Error {
  public constructor(
    public readonly method: string,
    public readonly rpcError: RpcError
  ) {
    super(`${method} failed (${rpcError.code}): ${rpcError.message}`);
    this.name = "RpcResponseError";
  }
}

export class JsonlRpcClient extends EventEmitter {
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #maxLineBytes: number;
  readonly #maxPendingRequests: number;
  readonly #requestTimeoutMs: number;
  #nextRequestId = 1;
  #closed = false;
  #initialized = false;
  #lastActivityAt = Date.now();

  public constructor(
    private readonly transport: JsonlTransport,
    options: JsonlRpcClientOptions = {}
  ) {
    super();
    this.#maxLineBytes = options.maxLineBytes ?? CODEX_MAX_LINE_BYTES;
    this.#maxPendingRequests = options.maxPendingRequests ?? 128;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    transport.onLine((line) => this.handleLine(line));
    transport.onClose((error) => this.handleClose(error));
  }

  public async initialize(
    clientVersion: string,
    options: { readonly experimentalApi?: boolean } = {}
  ): Promise<unknown> {
    if (this.#initialized) throw new Error("App-server connection is already initialized");
    const result = await this.requestRaw("initialize", {
      clientInfo: { name: "agentlink", title: "AgentLink", version: clientVersion },
      capabilities: {
        experimentalApi: options.experimentalApi ?? false,
        requestAttestation: false
      }
    });
    await this.notifyRaw("initialized", {});
    this.#initialized = true;
    return result;
  }

  public request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.#initialized) throw new Error("App-server connection is not initialized");
    return this.requestRaw(method, params) as Promise<T>;
  }

  public notify(method: string, params: unknown): Promise<void> {
    if (!this.#initialized) throw new Error("App-server connection is not initialized");
    return this.notifyRaw(method, params);
  }

  public pendingCount(): number {
    return this.#pending.size;
  }

  public protocolHealthy(maxIdleMs: number, now = Date.now()): boolean {
    return !this.#closed && now - this.#lastActivityAt <= maxIdleMs;
  }

  public async close(): Promise<void> {
    this.handleClose(new Error("App-server connection closed by client"));
    await this.transport.close();
  }

  private requestRaw(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("App-server connection is closed"));
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(new Error("App-server pending request limit reached"));
    }
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${this.#requestTimeoutMs}ms`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      void this.write({ method, id, params }).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("App-server write failed"));
      });
    });
  }

  private notifyRaw(method: string, params: unknown): Promise<void> {
    return this.write({ method, params });
  }

  private async write(message: Readonly<Record<string, unknown>>): Promise<void> {
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      throw new Error("Outbound app-server message exceeds line limit");
    }
    await this.transport.writeLine(line);
    this.#lastActivityAt = Date.now();
  }

  private handleLine(line: string): void {
    try {
      this.#lastActivityAt = Date.now();
      if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
        throw new Error("Inbound app-server message exceeds line limit");
      }
      const message = parseInbound(line);
      if (message.kind === "response") {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) throw new Error(`Unknown app-server response id: ${message.id}`);
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new RpcResponseError(pending.method, message.error));
        } else {
          pending.resolve(message.result);
        }
      } else if (message.kind === "request") {
        const request: ReverseRequest = {
          id: message.id,
          method: message.method,
          params: message.params,
          respond: (result) => this.write({ id: message.id, result }),
          reject: (error) => this.write({ id: message.id, error })
        };
        this.emit("request", request);
      } else {
        this.emit("notification", message.method, message.params);
      }
    } catch (error) {
      this.emit("protocolError", error instanceof Error ? error : new Error("Protocol error"));
    }
  }

  private handleClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const reason = error ?? new Error("App-server transport closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.emit("close", reason);
  }
}
