import type { JsonlTransport } from "../../src/agent-codex/protocol/jsonl-rpc-client.js";

type Message = Record<string, unknown>;
interface ThreadMetadata {
  cwd: string;
  preview: string;
  ephemeral: boolean;
  source: "cli" | "vscode" | "exec" | "appServer" | "unknown" | { subAgent: unknown };
  createdAt: number;
  updatedAt: number;
}

export class FakeAppServerTransport implements JsonlTransport {
  readonly received: Message[] = [];
  readonly clientResponses: Message[] = [];
  readonly methodCalls: { method: string; params: unknown }[] = [];
  #lineListeners: ((line: string) => void)[] = [];
  #closeListeners: ((error?: Error) => void)[] = [];
  #nextThread = 1;
  #nextTurn = 1;
  #nextServerRequest = 10_000;
  readonly #turnsByThread = new Map<string, Map<string, string>>();
  readonly #namesByThread = new Map<string, string>();
  readonly #metadataByThread = new Map<string, ThreadMetadata>();
  readonly #archivedThreads = new Set<string>();
  readonly #threadsHiddenFromList = new Set<string>();
  readonly #methodFailures = new Map<string, { code: number; message: string }[]>();
  #initialized = false;
  #closed = false;

  public async writeLine(line: string): Promise<void> {
    if (this.#closed) throw new Error("Fake App Server is closed");
    const message = JSON.parse(line) as Message;
    this.received.push(message);
    const id = message["id"];
    const method = message["method"];
    if (typeof method !== "string") {
      this.clientResponses.push(message);
      return;
    }
    this.methodCalls.push({ method, params: message["params"] });
    if (method === "initialize") {
      if (this.#initialized) return this.respond(id, undefined, { code: -32000, message: "Already initialized" });
      this.#initialized = true;
      return this.respond(id, { userAgent: "fake", platformFamily: "unix", platformOs: "macos" });
    }
    if (method === "initialized") return;
    if (!this.#initialized) return this.respond(id, undefined, { code: -32000, message: "Not initialized" });
    const params = message["params"] as Record<string, unknown>;
    const failures = this.#methodFailures.get(method);
    const failure = failures?.shift();
    if (failure !== undefined) return this.respond(id, undefined, failure);
    if (method === "thread/start") {
      const threadId = `thread-${this.#nextThread++}`;
      this.#turnsByThread.set(threadId, new Map());
      this.#metadataByThread.set(threadId, {
        cwd: String(params["cwd"] ?? "/workspace"),
        preview: "",
        ephemeral: false,
        source: "appServer",
        createdAt: 1_752_796_800,
        updatedAt: 1_752_796_800
      });
      return this.respond(id, { thread: { id: threadId } });
    }
    if (method === "thread/list") {
      const cwd = params["cwd"];
      const archived = params["archived"] === true;
      const data = [...this.#turnsByThread.keys()]
        .filter((threadId) => !this.#threadsHiddenFromList.has(threadId))
        .filter((threadId) => this.#archivedThreads.has(threadId) === archived)
        .map((threadId) => this.thread(threadId, false))
        .filter((thread) =>
          cwd === undefined ||
          (Array.isArray(cwd) ? cwd.includes(thread["cwd"]) : thread["cwd"] === cwd)
        )
        .sort((left, right) => Number(right["updatedAt"]) - Number(left["updatedAt"]));
      return this.respond(id, {
        data,
        nextCursor: null,
        backwardsCursor: data.length === 0 ? null : "backwards"
      });
    }
    if (method === "thread/resume") {
      const threadId = String(params["threadId"]);
      if (this.#archivedThreads.has(threadId)) {
        return this.respond(id, undefined, { code: -32000, message: "Thread is archived" });
      }
      return this.respond(id, { thread: { id: threadId } });
    }
    if (method === "thread/archive") {
      this.#archivedThreads.add(String(params["threadId"]));
      return this.respond(id, {});
    }
    if (method === "thread/unarchive") {
      this.#archivedThreads.delete(String(params["threadId"]));
      return this.respond(id, {});
    }
    if (method === "thread/delete") {
      const threadId = String(params["threadId"]);
      this.#turnsByThread.delete(threadId);
      this.#metadataByThread.delete(threadId);
      this.#namesByThread.delete(threadId);
      this.#archivedThreads.delete(threadId);
      return this.respond(id, {});
    }
    if (method === "turn/start") {
      const turnId = `native-turn-${this.#nextTurn++}`;
      const threadId = String(params["threadId"]);
      this.#turnsByThread.get(threadId)?.set(turnId, "inProgress");
      this.notify("turn/started", { threadId: params["threadId"], turn: { id: turnId } });
      return this.respond(id, { turn: { id: turnId } });
    }
    if (method === "thread/read") {
      const threadId = String(params["threadId"]);
      if (!this.#metadataByThread.has(threadId)) {
        return this.respond(id, undefined, {
          code: -32600,
          message: `thread not loaded: ${threadId}`
        });
      }
      return this.respond(id, { thread: this.thread(threadId, true) });
    }
    return this.respond(id, {});
  }

  public onLine(listener: (line: string) => void): void { this.#lineListeners.push(listener); }
  public onClose(listener: (error?: Error) => void): void { this.#closeListeners.push(listener); }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener(new Error("Fake App Server exited"));
  }

  public notify(method: string, params: unknown): void {
    this.emit({ method, params });
  }

  public request(method: string, params: unknown): number {
    const id = this.#nextServerRequest++;
    this.emit({ method, id, params });
    return id;
  }

  public seedThread(
    threadId: string,
    turns: Readonly<Record<string, "completed" | "interrupted" | "failed" | "inProgress">>
  ): void {
    this.#turnsByThread.set(threadId, new Map(Object.entries(turns)));
    this.#metadataByThread.set(threadId, {
      cwd: "/workspace",
      preview: "",
      ephemeral: false,
      source: "cli",
      createdAt: 1_752_796_800,
      updatedAt: 1_752_796_800
    });
  }

  public seedExternalThread(input: {
    threadId: string;
    cwd: string;
    name?: string;
    preview?: string;
    archived?: boolean;
    ephemeral?: boolean;
    source?: ThreadMetadata["source"];
    createdAt?: number;
    updatedAt?: number;
    turns?: Readonly<Record<string, "completed" | "interrupted" | "failed" | "inProgress">>;
  }): void {
    this.#turnsByThread.set(input.threadId, new Map(Object.entries(input.turns ?? {})));
    this.#metadataByThread.set(input.threadId, {
      cwd: input.cwd,
      preview: input.preview ?? "",
      ephemeral: input.ephemeral ?? false,
      source: input.source ?? "cli",
      createdAt: input.createdAt ?? 1_752_796_800,
      updatedAt: input.updatedAt ?? 1_752_796_800
    });
    if (input.name !== undefined) this.#namesByThread.set(input.threadId, input.name);
    if (input.archived === true) this.#archivedThreads.add(input.threadId);
  }

  public failNext(method: string, message = "Injected App Server failure", code = -32000): void {
    const failures = this.#methodFailures.get(method) ?? [];
    failures.push({ code, message });
    this.#methodFailures.set(method, failures);
  }

  public hideThreadFromList(threadId: string): void {
    this.#threadsHiddenFromList.add(threadId);
  }

  public renameThread(threadId: string, name: string): void {
    this.#namesByThread.set(threadId, name);
    this.notify("thread/name/updated", { threadId, threadName: name });
  }

  public completeTurn(
    threadId: string,
    nativeTurnId: string,
    text: string,
    status: "completed" | "interrupted" | "failed" = "completed"
  ): void {
    this.#turnsByThread.get(threadId)?.set(nativeTurnId, status);
    this.notify("item/completed", {
      threadId,
      turnId: nativeTurnId,
      item: { id: `item-${nativeTurnId}`, type: "agentMessage", text }
    });
    this.notify("turn/completed", {
      threadId,
      turn: { id: nativeTurnId, status }
    });
  }

  private respond(id: unknown, result?: unknown, error?: unknown): void {
    if (id === undefined) return;
    queueMicrotask(() => this.emit({
      id,
      ...(error === undefined ? { result } : { error })
    }));
  }

  private thread(threadId: string, includeTurns: boolean): Message {
    const turns = [...(this.#turnsByThread.get(threadId) ?? new Map()).entries()]
      .map(([turnId, status]) => ({ id: turnId, status }));
    const metadata = this.#metadataByThread.get(threadId) ?? {
      cwd: "/workspace",
      preview: "",
      ephemeral: false,
      source: "cli" as const,
      createdAt: 1_752_796_800,
      updatedAt: 1_752_796_800
    };
    return {
      id: threadId,
      name: this.#namesByThread.get(threadId) ?? null,
      preview: metadata.preview,
      cwd: metadata.cwd,
      ephemeral: metadata.ephemeral,
      source: metadata.source,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      status: turns.some((turn) => turn.status === "inProgress")
        ? { type: "active", activeFlags: ["waitingOnApproval"] }
        : { type: "idle" },
      turns: includeTurns ? turns : []
    };
  }

  private emit(message: Message): void {
    const line = JSON.stringify(message);
    for (const listener of this.#lineListeners) listener(line);
  }
}
