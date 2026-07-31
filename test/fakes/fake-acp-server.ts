import { EventEmitter } from "node:events";
import type { JsonlTransport } from "../../src/agent-grok/protocol/acp-rpc-client.js";

/**
 * Minimal in-memory ACP agent for unit tests of SharedGrokAdapter.
 */
export class FakeAcpTransport extends EventEmitter implements JsonlTransport {
  #closed = false;
  #lineHandlers: Array<(line: string) => void> = [];
  #closeHandlers: Array<(error?: Error) => void> = [];
  #nextId = 1000;
  sessions = new Map<string, { cwd: string }>();
  permissions: Array<{ id: number | string; params: unknown }> = [];
  prompts: Array<{ sessionId: string; text: string }> = [];
  cancels: string[] = [];
  closes: string[] = [];
  deletes: string[] = [];
  initializeParams: Record<string, unknown> | undefined;
  sessionCapabilities: { close?: Record<string, never>; delete?: Record<string, never> } = {
    close: {}
  };
  permissionMode: "allow" | "request" | "reject" = "allow";
  permissionTitle = "Write /tmp/fake.txt";
  permissionKind = "edit";
  permissionRawInput: unknown = { path: "/tmp/fake.txt", content: "x" };
  promptDelayMs = 0;
  sessionLifecycleError: { code: number; message: string } | undefined;

  public writeLine(line: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("closed"));
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    queueMicrotask(() => this.handleClient(msg));
    return Promise.resolve();
  }

  public onLine(listener: (line: string) => void): void {
    this.#lineHandlers.push(listener);
  }

  public onClose(listener: (error?: Error) => void): void {
    this.#closeHandlers.push(listener);
  }

  public async close(): Promise<void> {
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler(new Error("closed"));
  }

  public emitSessionInfo(sessionId: string, title: string): void {
    this.emitLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "session_info_update", title }
      }
    });
  }

  private emitLine(obj: unknown): void {
    const line = JSON.stringify(obj);
    for (const handler of this.#lineHandlers) handler(line);
  }

  private handleClient(msg: {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  }): void {
    if (msg.method === "initialize" && msg.id !== undefined) {
      this.initializeParams = msg.params;
      this.emitLine({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: this.sessionCapabilities
          }
        }
      });
      return;
    }
    if (msg.method === "initialized") return;
    if (msg.method === "session/new" && msg.id !== undefined) {
      if (this.sessionLifecycleError !== undefined) {
        this.emitLine({ jsonrpc: "2.0", id: msg.id, error: this.sessionLifecycleError });
        return;
      }
      const sessionId = `gs-${this.#nextId++}`;
      this.sessions.set(sessionId, { cwd: String(msg.params?.["cwd"] ?? "") });
      this.emitLine({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
      return;
    }
    if (msg.method === "session/load" && msg.id !== undefined) {
      if (this.sessionLifecycleError !== undefined) {
        this.emitLine({ jsonrpc: "2.0", id: msg.id, error: this.sessionLifecycleError });
        return;
      }
      const sessionId = String(msg.params?.["sessionId"] ?? "");
      this.sessions.set(sessionId, { cwd: String(msg.params?.["cwd"] ?? "") });
      this.emitLine({
        jsonrpc: "2.0",
        id: msg.id,
        result: { _meta: { sessionId } }
      });
      return;
    }
    if (msg.method === "session/prompt" && msg.id !== undefined) {
      const sessionId = String(msg.params?.["sessionId"] ?? "");
      const prompt = msg.params?.["prompt"] as Array<{ text?: string }> | undefined;
      const text = prompt?.[0]?.text ?? "";
      this.prompts.push({ sessionId, text });
      void this.handlePrompt(msg.id, sessionId, text);
      return;
    }
    if (msg.method === "session/cancel") {
      this.cancels.push(String(msg.params?.["sessionId"] ?? ""));
      return;
    }
    if (msg.method === "session/close" && msg.id !== undefined) {
      this.closes.push(String(msg.params?.["sessionId"] ?? ""));
      this.emitLine({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method === "session/delete" && msg.id !== undefined) {
      this.deletes.push(String(msg.params?.["sessionId"] ?? ""));
      this.emitLine({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }

  private async handlePrompt(id: number, sessionId: string, text: string): Promise<void> {
    if (this.promptDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.promptDelayMs));
    }
    if (this.permissionMode === "request" || this.permissionMode === "reject") {
      const permId = this.#nextId++;
      const params = {
        sessionId,
        options: [
          { optionId: "allow-once" },
          { optionId: "reject-once" }
        ],
        toolCall: {
          toolCallId: `tool-${permId}`,
          kind: this.permissionKind,
          title: this.permissionTitle,
          rawInput: this.permissionRawInput
        }
      };
      this.permissions.push({ id: permId, params });
      this.emitLine({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params
      });
      // Wait briefly for client response via writeLine — simplified: assume auto-handled in test
      await new Promise((r) => setTimeout(r, 20));
    }
    this.emitLine({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { text: `echo:${text}` }
        }
      }
    });
    this.emitLine({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: this.permissionMode === "reject" ? "cancelled" : "end_turn"
      }
    });
  }
}
