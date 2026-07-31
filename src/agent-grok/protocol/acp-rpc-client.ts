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

export interface AcpRpcClientOptions {
  readonly maxLineBytes?: number;
  readonly maxPendingRequests?: number;
  readonly requestTimeoutMs?: number;
}

export class RpcResponseError extends Error {
  public constructor(
    public readonly method: string,
    public readonly rpcError: RpcError
  ) {
    super(`${method} failed (${rpcError.code}): ${rpcError.message}`);
    this.name = "RpcResponseError";
  }
}

export class AcpRpcClient extends EventEmitter {
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
    options: AcpRpcClientOptions = {}
  ) {
    super();
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.#maxPendingRequests = options.maxPendingRequests ?? 128;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30 * 60_000;
    transport.onLine((line) => this.handleLine(line));
    transport.onClose((error) => this.handleClose(error));
  }

  public async initialize(clientVersion: string): Promise<unknown> {
    if (this.#initialized) throw new Error("ACP connection is already initialized");
    const result = await this.requestRaw("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      clientInfo: { name: "agentlink", version: clientVersion }
    });
    await this.notifyRaw("initialized", {});
    this.#initialized = true;
    return result;
  }

  public request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.#initialized) throw new Error("ACP connection is not initialized");
    return this.requestRaw(method, params) as Promise<T>;
  }

  public notify(method: string, params: unknown): Promise<void> {
    if (!this.#initialized) throw new Error("ACP connection is not initialized");
    return this.notifyRaw(method, params);
  }

  public pendingCount(): number {
    return this.#pending.size;
  }

  public protocolHealthy(maxIdleMs: number, now = Date.now()): boolean {
    return !this.#closed && now - this.#lastActivityAt <= maxIdleMs;
  }

  public async close(): Promise<void> {
    this.handleClose(new Error("ACP connection closed by client"));
    await this.transport.close();
  }

  private requestRaw(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("ACP connection is closed"));
    if (this.#pending.size >= this.#maxPendingRequests) {
      return Promise.reject(new Error("ACP pending request limit reached"));
    }
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${this.#requestTimeoutMs}ms`));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", method, id, params }).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private notifyRaw(method: string, params: unknown): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("ACP connection is closed"));
    return this.write({ jsonrpc: "2.0", method, params });
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      throw new Error("ACP outbound line exceeds limit");
    }
    await this.transport.writeLine(line);
    this.#lastActivityAt = Date.now();
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      this.emit("protocolError", new Error("ACP inbound line exceeds limit"));
      return;
    }
    this.#lastActivityAt = Date.now();
    let inbound;
    try {
      inbound = parseInbound(line);
    } catch (error) {
      this.emit("protocolError", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (inbound.kind === "response") {
      const pending = this.#pending.get(inbound.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(inbound.id);
      if (inbound.error !== undefined) {
        pending.reject(new RpcResponseError(pending.method, inbound.error));
      } else {
        pending.resolve(inbound.result);
      }
      return;
    }
    if (inbound.kind === "notification") {
      this.emit("notification", inbound.method, inbound.params);
      return;
    }
    const reverse: ReverseRequest = {
      id: inbound.id,
      method: inbound.method,
      params: inbound.params,
      respond: async (result) => {
        await this.write({ jsonrpc: "2.0", id: inbound.id, result });
      },
      reject: async (error) => {
        await this.write({ jsonrpc: "2.0", id: inbound.id, error });
      }
    };
    this.emit("request", reverse);
  }

  private handleClose(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("ACP connection closed"));
      this.#pending.delete(id);
    }
    this.emit("close", error ?? new Error("ACP connection closed"));
  }
}
