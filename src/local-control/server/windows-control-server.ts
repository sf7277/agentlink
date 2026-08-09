import { ZodError } from "zod";
import type { LocalControlEvent, LocalControlPort } from "../../core/contracts/ports.js";
import { sanitizeDiagnostic } from "../../core/application/safe-diagnostics.js";
import { parseLocalControlEvent } from "../protocol.js";

type NativeFunction = {
  (...args: any[]): any;
  async(...args: any[]): void;
};

interface NativePipeApi {
  readonly createNamedPipe: NativeFunction;
  readonly convertSecurityDescriptor: NativeFunction;
  readonly localFree: NativeFunction;
  readonly connectNamedPipe: NativeFunction;
  readonly cancelIoEx: NativeFunction;
  readonly waitNamedPipe: NativeFunction;
  readonly readFile: NativeFunction;
  readonly writeFile: NativeFunction;
  readonly flushFileBuffers: NativeFunction;
  readonly disconnectNamedPipe: NativeFunction;
  readonly closeHandle: NativeFunction;
}

const PIPE_ACCESS_DUPLEX = 0x00000003;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const PIPE_TYPE_BYTE = 0x00000000;
const PIPE_READMODE_BYTE = 0x00000000;
const PIPE_WAIT = 0x00000000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
const PIPE_UNLIMITED_INSTANCES = 255;
const SECURITY_DESCRIPTOR_REVISION = 1;
const MAX_PIPE_BUFFER = 64 * 1024;

export interface WindowsControlServerOptions {
  readonly maxLineBytes?: number;
  readonly maxPublishedBytes?: number;
  readonly maxRequestsPerMinute?: number;
  readonly allowedEndpointIds?: ReadonlySet<string>;
}

/**
 * Windows local-control server backed by CreateNamedPipeW.
 *
 * The pipe DACL grants full access only to the creating user's owner SID
 * (`OW`) and rejects remote clients. Node's net.createServer() cannot supply
 * this descriptor, so it is intentionally not used for the server side.
 */
export class WindowsControlServer implements LocalControlPort {
  readonly #connections = new Set<WindowsPipeConnection>();
  readonly #pendingHandles = new Set<unknown>();
  readonly #acceptOperations = new Set<Promise<void>>();
  #requestTimes: number[] = [];
  readonly #maxLineBytes: number;
  readonly #maxPublishedBytes: number;
  readonly #maxRequestsPerMinute: number;
  readonly #allowedEndpointIds: ReadonlySet<string>;
  #api: NativePipeApi | undefined;
  #stopping = false;
  #started = false;
  #handler: ((event: LocalControlEvent) => Promise<unknown>) | undefined;

  public constructor(
    private readonly pipeName: string,
    options: WindowsControlServerOptions = {}
  ) {
    this.#maxLineBytes = options.maxLineBytes ?? 64 * 1024;
    this.#maxPublishedBytes = options.maxPublishedBytes ?? 64 * 1024;
    this.#maxRequestsPerMinute = options.maxRequestsPerMinute ?? 120;
    this.#allowedEndpointIds = options.allowedEndpointIds ?? new Set(["local-cli"]);
  }

  public async start(onEvent: (event: LocalControlEvent) => Promise<unknown>): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("Windows Named Pipe control server is only available on Windows");
    }
    if (this.#started) throw new Error("Local control server is already started");
    if (!/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/u.test(this.pipeName)) {
      throw new Error("AgentLink Windows control pipe name is invalid");
    }
    if (process.arch !== "x64") {
      throw new Error("AgentLink Windows control server currently requires x64");
    }
    this.#handler = onEvent;
    const api = await loadNativePipeApi();
    if (api.waitNamedPipe(this.pipeName, 0)) {
      throw new Error("Another AgentLink Gateway is already running on the local control pipe");
    }
    this.#api = api;
    this.#stopping = false;
    this.#started = true;
    // Create the first pipe instance eagerly so a duplicate Gateway or an
    // unavailable pipe fails start() instead of silently running without a
    // local control endpoint.
    const firstHandle = createSecurePipe(api, this.pipeName, true);
    this.#pendingHandles.add(firstHandle);
    this.beginAcceptFromHandle(firstHandle);
    this.beginAccept(false);
  }

  public async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopping = true;
    const api = this.#api;
    if (api !== undefined) {
      for (const handle of this.#pendingHandles) {
        api.cancelIoEx(handle, null);
        api.closeHandle(handle);
      }
    }
    for (const connection of this.#connections) connection.close();
    await Promise.allSettled([...this.#acceptOperations]);
    this.#pendingHandles.clear();
    this.#connections.clear();
    this.#api = undefined;
    this.#handler = undefined;
    this.#started = false;
  }

  public publish(sessionId: string, payload: Readonly<Record<string, unknown>>): void {
    const line = `${JSON.stringify({ sessionId, payload })}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maxPublishedBytes) {
      throw new Error("Local control publication exceeds size limit");
    }
    for (const connection of this.#connections) void connection.write(line);
  }

  private beginAccept(firstInstance: boolean): void {
    if (this.#stopping) return;
    const operation = this.acceptOne(firstInstance);
    this.#acceptOperations.add(operation);
    void operation.finally(() => this.#acceptOperations.delete(operation));
  }

  private beginAcceptFromHandle(handle: unknown): void {
    const operation = this.connectAndRun(handle);
    this.#acceptOperations.add(operation);
    void operation.finally(() => this.#acceptOperations.delete(operation));
  }

  private async acceptOne(firstInstance: boolean): Promise<void> {
    const api = this.#api;
    if (api === undefined) return;
    let handle: unknown;
    try {
      handle = createSecurePipe(api, this.pipeName, firstInstance);
    } catch {
      // A transient failure on a later instance must not crash the Gateway;
      // the first instance was already established by start().
      return;
    }
    this.#pendingHandles.add(handle);
    await this.connectAndRun(handle);
  }

  private async connectAndRun(handle: unknown): Promise<void> {
    const api = this.#api;
    if (api === undefined) return;
    try {
      const connected = await nativeAsync(api.connectNamedPipe, handle, null);
      this.#pendingHandles.delete(handle);
      if (!connected || this.#stopping) {
        api.closeHandle(handle);
        return;
      }
      this.beginAccept(false);
      const connection = new WindowsPipeConnection(api, handle, MAX_PIPE_BUFFER);
      this.#connections.add(connection);
      await connection.run((line) => this.handleLine(connection, line));
      this.#connections.delete(connection);
      connection.close();
    } catch (error) {
      this.#pendingHandles.delete(handle);
      api.disconnectNamedPipe(handle);
      api.closeHandle(handle);
    }
  }

  private async handleLine(connection: WindowsPipeConnection, line: string): Promise<void> {
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
      await connection.write(`${JSON.stringify({
        ok: true,
        ...(result === undefined ? {} : { result })
      })}\n`);
    } catch (error) {
      const message = error instanceof ZodError || error instanceof SyntaxError
        ? "Invalid local control request"
        : sanitizeDiagnostic(error instanceof Error ? error.message : "Invalid request");
      try {
        await connection.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      } catch {
        connection.close();
      }
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

class WindowsPipeConnection {
  #closed = false;
  #pending = "";
  #writeChain = Promise.resolve();

  public constructor(
    private readonly api: NativePipeApi,
    private readonly handle: unknown,
    private readonly readBufferBytes: number
  ) {}

  public async run(onLine: (line: string) => Promise<void>): Promise<void> {
    while (!this.#closed) {
      const buffer = Buffer.allocUnsafe(this.readBufferBytes);
      const bytesRead = Buffer.alloc(4);
      const ok = await nativeAsync(
        this.api.readFile,
        this.handle,
        buffer,
        this.readBufferBytes,
        bytesRead,
        null
      );
      if (!ok) return;
      const count = bytesRead.readUInt32LE(0);
      if (count === 0) return;
      this.#pending += buffer.subarray(0, count).toString("utf8");
      if (Buffer.byteLength(this.#pending, "utf8") > this.readBufferBytes * 4) {
        throw new Error("Local control request exceeds size limit");
      }
      let newline = this.#pending.indexOf("\n");
      while (newline >= 0) {
        const line = this.#pending.slice(0, newline).replace(/\r$/u, "");
        this.#pending = this.#pending.slice(newline + 1);
        await onLine(line);
        newline = this.#pending.indexOf("\n");
      }
    }
  }

  public write(data: string): Promise<void> {
    this.#writeChain = this.#writeChain.then(async () => {
      if (this.#closed) return;
      const buffer = Buffer.from(data, "utf8");
      const bytesWritten = Buffer.alloc(4);
      const ok = await nativeAsync(
        this.api.writeFile,
        this.handle,
        buffer,
        buffer.length,
        bytesWritten,
        null
      );
      if (!ok) throw new Error("Windows Named Pipe write failed");
      await nativeAsync(this.api.flushFileBuffers, this.handle);
    });
    return this.#writeChain;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.api.disconnectNamedPipe(this.handle);
    this.api.closeHandle(this.handle);
  }
}

function createSecurePipe(api: NativePipeApi, pipeName: string, firstInstance: boolean): unknown {
  const descriptorOut = Buffer.alloc(8);
  const descriptorLength = Buffer.alloc(4);
  const converted = api.convertSecurityDescriptor(
    "D:(A;;GA;;;OW)",
    SECURITY_DESCRIPTOR_REVISION,
    descriptorOut,
    descriptorLength
  );
  if (!converted) throw new Error("Cannot create Windows Named Pipe security descriptor");
  const descriptor = descriptorOut.readBigUInt64LE(0);
  const securityAttributes = Buffer.alloc(24);
  securityAttributes.writeUInt32LE(24, 0);
  securityAttributes.writeBigUInt64LE(descriptor, 8);
  securityAttributes.writeUInt32LE(0, 16);
  try {
    const flags = PIPE_ACCESS_DUPLEX |
      (firstInstance ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
    const handle = api.createNamedPipe(
      pipeName,
      flags,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      PIPE_UNLIMITED_INSTANCES,
      MAX_PIPE_BUFFER,
      MAX_PIPE_BUFFER,
      0,
      securityAttributes
    );
    if (
      handle === null || handle === undefined || handle === 0 ||
      handle === -1 || handle === BigInt(-1)
    ) {
      throw new Error("Cannot create secure Windows Named Pipe");
    }
    return handle;
  } finally {
    api.localFree(descriptor);
  }
}

function nativeAsync(functionRef: NativeFunction, ...args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    functionRef.async(...args, (error: unknown, result: any) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve(result);
    });
  });
}

async function loadNativePipeApi(): Promise<NativePipeApi> {
  let koffi: { load(path: string): { func(definition: string): NativeFunction } };
  try {
    koffi = (await import("koffi")).default;
  } catch (error) {
    throw new Error(
      "Windows Named Pipe binding is unavailable; reinstall AgentLink with optional dependencies",
      { cause: error }
    );
  }
  const kernel32 = koffi.load("kernel32.dll");
  const advapi32 = koffi.load("advapi32.dll");
  return {
    createNamedPipe: kernel32.func("void * __stdcall CreateNamedPipeW(str16, uint32, uint32, uint32, uint32, uint32, uint32, void *)"),
    convertSecurityDescriptor: advapi32.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, void **, uint32 *)"),
    localFree: kernel32.func("void * __stdcall LocalFree(void *)"),
    connectNamedPipe: kernel32.func("int __stdcall ConnectNamedPipe(void *, void *)"),
    cancelIoEx: kernel32.func("int __stdcall CancelIoEx(void *, void *)"),
    waitNamedPipe: kernel32.func("int __stdcall WaitNamedPipeW(str16, uint32)"),
    readFile: kernel32.func("int __stdcall ReadFile(void *, void *, uint32, uint32 *, void *)"),
    writeFile: kernel32.func("int __stdcall WriteFile(void *, void *, uint32, uint32 *, void *)"),
    flushFileBuffers: kernel32.func("int __stdcall FlushFileBuffers(void *)"),
    disconnectNamedPipe: kernel32.func("int __stdcall DisconnectNamedPipe(void *)"),
    closeHandle: kernel32.func("int __stdcall CloseHandle(void *)")
  };
}
