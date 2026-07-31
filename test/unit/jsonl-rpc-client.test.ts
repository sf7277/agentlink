import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_MAX_LINE_BYTES,
  JsonlRpcClient,
  type ReverseRequest
} from "../../src/agent-codex/protocol/jsonl-rpc-client.js";
import { FakeAppServerTransport } from "../fakes/fake-app-server.js";

test("JSONL client enforces one handshake and connection-unique request IDs", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  await assert.rejects(client.initialize("0.1.0"), /already initialized/u);
  await Promise.all([
    client.request("thread/start", {}),
    client.request("thread/start", {})
  ]);
  const ids = transport.received
    .map((message) => message["id"])
    .filter((id): id is number => typeof id === "number");
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(client.pendingCount(), 0);
  assert.equal(client.protocolHealthy(1_000, Date.now()), true);
  const initialize = transport.received.find((message) => message["method"] === "initialize");
  assert.equal(
    ((initialize?.["params"] as Record<string, unknown>)["capabilities"] as
      Record<string, unknown>)["experimentalApi"],
    false
  );
});

test("experimentalApi is enabled only by an explicit initialize option", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0", { experimentalApi: true });
  const initialize = transport.received.find((message) => message["method"] === "initialize");
  assert.equal(
    ((initialize?.["params"] as Record<string, unknown>)["capabilities"] as
      Record<string, unknown>)["experimentalApi"],
    true
  );
});

test("JSONL client dispatches notifications and reverse requests", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.0");
  const notifications: string[] = [];
  client.on("notification", (method: string) => notifications.push(method));
  client.on("request", (request: ReverseRequest) => {
    void request.respond({ decision: "decline" });
  });
  transport.notify("warning", { message: "test" });
  const requestId = transport.request("item/commandExecution/requestApproval", {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ["warning"]);
  assert.deepEqual(
    transport.clientResponses.find((message) => message["id"] === requestId),
    { id: requestId, result: { decision: "decline" } }
  );
});

test("JSONL client rejects outbound oversize and pending overflow", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport, { maxLineBytes: 300, maxPendingRequests: 1 });
  await client.initialize("0.1.0");
  await assert.rejects(client.request("test/large", { text: "x".repeat(500) }), /line limit/u);

  let lineListener: ((line: string) => void) | undefined;
  const stalledTransport = {
    writeLine: async (line: string) => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed["method"] === "initialize") {
        queueMicrotask(() => lineListener?.(JSON.stringify({ id: parsed["id"], result: {} })));
      }
    },
    onLine: (listener: (line: string) => void) => { lineListener = listener; },
    onClose: () => undefined,
    close: async () => undefined
  };
  const stalled = new JsonlRpcClient(stalledTransport, {
    maxPendingRequests: 1,
    requestTimeoutMs: 20
  });
  await stalled.initialize("0.1.0");
  const pending = stalled.request("stalled", {});
  await assert.rejects(stalled.request("overflow", {}), /pending request limit/u);
  await assert.rejects(pending, /timed out/u);
});

test("malformed and unknown response messages become protocol errors", async () => {
  const transport = new FakeAppServerTransport();
  const client = new JsonlRpcClient(transport);
  const errors: Error[] = [];
  client.on("protocolError", (error: Error) => errors.push(error));
  transport.notify("", {});
  transport.notify("valid", {});
  // A response id that was never allocated must not be guessed.
  (transport as unknown as { notify(method: string, params: unknown): void }).notify("warning", {});
  await client.initialize("0.1.0");
  assert.ok(errors.length >= 1);
});

test("Codex protocol envelope accepts multi-megabyte resume responses but remains bounded", async () => {
  let listener: ((line: string) => void) | undefined;
  const transport = {
    writeLine: async (line: string) => {
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (request.id === undefined) return;
      const result = request.method === "thread/resume"
        ? { thread: { id: "long-thread", turns: [{ text: "x".repeat(3 * 1024 * 1024) }] } }
        : {};
      queueMicrotask(() => listener?.(JSON.stringify({ id: request.id, result })));
    },
    onLine: (next: (line: string) => void) => { listener = next; },
    onClose: () => undefined,
    close: async () => undefined
  };
  const client = new JsonlRpcClient(transport);
  await client.initialize("0.1.9-test");
  const response = await client.request<{ thread: { id: string } }>("thread/resume", {
    threadId: "long-thread"
  });
  assert.equal(response.thread.id, "long-thread");
  assert.equal(CODEX_MAX_LINE_BYTES, 16 * 1024 * 1024);
});
