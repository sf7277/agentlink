import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { IlinkMonitor, type IlinkBatchAcceptor } from "../../src/channel-wechat/adapter/monitor.js";
import { IlinkChannelAdapter } from "../../src/channel-wechat/adapter/ilink-channel-adapter.js";
import { IlinkQrLogin } from "../../src/channel-wechat/adapter/qr-login.js";
import { IlinkError } from "../../src/channel-wechat/protocol/errors.js";
import {
  ILINK_ADAPTER_IDENTITY,
  IlinkHttpClient
} from "../../src/channel-wechat/protocol/http-client.js";
import { FakeCredentialStore, FakeIdGenerator } from "../fakes/core-fakes.js";

const fixtureRoot = join(process.cwd(), "protocol-fixtures/ilink");

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtureRoot, name), "utf8");
}

function queuedFetch(responses: readonly { status?: number; body: string }[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: { url: string; init?: RequestInit }[];
} {
  const queue = [...responses];
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(input),
      ...(init === undefined ? {} : { init })
    });
    const response = queue.shift();
    if (response === undefined) throw new Error("No fake response queued");
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

test("iLink text fixture normalizes input and advances cursor only after atomic accept", async () => {
  const fake = queuedFetch([{ body: await fixture("getupdates-text.json") }]);
  const client = new IlinkHttpClient({
    baseUrl: "https://fixture.invalid",
    token: async () => "credential-from-store",
    fetch: fake.fetch
  });
  const accepted: Parameters<IlinkBatchAcceptor["accept"]>[0][] = [];
  const monitor = new IlinkMonitor(
    client,
    "account-1",
    new Set(["fixture-owner"]),
    { accept: async (batch) => { accepted.push(batch); } },
    "fixture-cursor-old"
  );
  assert.equal(await monitor.pollOnce(), 1);
  assert.equal(monitor.cursor(), "fixture-cursor-next");
  assert.equal(accepted[0]?.messages[0]?.disposition, "deliver");
  assert.equal(accepted[0]?.messages[0]?.message.text, "/status");
  const body = JSON.parse(String(fake.requests[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(body["get_updates_buf"], "fixture-cursor-old");
  assert.deepEqual(body["base_info"], {
    channel_version: ILINK_ADAPTER_IDENTITY.channelVersion,
    bot_agent: ILINK_ADAPTER_IDENTITY.botAgent
  });
  assert.equal(fake.requests[0]?.init?.headers instanceof Headers, false);
  const headers = fake.requests[0]?.init?.headers;
  assert.equal(
    (headers as Record<string, string> | undefined)?.["iLink-App-Id"],
    ILINK_ADAPTER_IDENTITY.appId
  );
  assert.equal(
    (headers as Record<string, string> | undefined)?.["iLink-App-ClientVersion"],
    ILINK_ADAPTER_IDENTITY.appClientVersion
  );
  assert.equal(
    headers instanceof Headers
      ? headers.get("Authorization")
      : (headers as Record<string, string> | undefined)?.Authorization,
    "Bearer credential-from-store",
  );
});

test("real response shape preserves 64-bit message ID and derives private Conversation", async () => {
  const fake = queuedFetch([{ body: await fixture("getupdates-real-shape.json") }]);
  const accepted: Parameters<IlinkBatchAcceptor["accept"]>[0][] = [];
  const monitor = new IlinkMonitor(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch }),
    "account-1",
    new Set(["fixture-owner"]),
    { accept: async (batch) => { accepted.push(batch); } }
  );
  await monitor.pollOnce();
  const message = accepted[0]?.messages[0]?.message;
  assert.equal(message?.messageId, "9223372036854775807");
  assert.equal(message?.eventId, "account-1:9223372036854775807");
  assert.equal(message?.conversationId, "direct:fixture-owner");
});

test("failed accept keeps old cursor for safe replay", async () => {
  const fake = queuedFetch([{ body: await fixture("getupdates-text.json") }]);
  const monitor = new IlinkMonitor(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch }),
    "account-1",
    new Set(["fixture-owner"]),
    { accept: async () => { throw new Error("transaction failed"); } },
    "fixture-cursor-old"
  );
  await assert.rejects(monitor.pollOnce(), /transaction failed/u);
  assert.equal(monitor.cursor(), "fixture-cursor-old");
});

test("attachments and unauthorized senders are accepted with non-delivery disposition", async () => {
  const fake = queuedFetch([
    { body: await fixture("getupdates-attachment.json") },
    { body: await fixture("getupdates-text.json") }
  ]);
  const dispositions: string[] = [];
  const acceptor: IlinkBatchAcceptor = {
    accept: async (batch) => { dispositions.push(...batch.messages.map((item) => item.disposition)); }
  };
  const client = new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch });
  await new IlinkMonitor(client, "account-1", new Set(["fixture-owner"]), acceptor).pollOnce();
  await new IlinkMonitor(client, "account-1", new Set(["someone-else"]), acceptor).pollOnce();
  assert.deepEqual(dispositions, ["attachment_unsupported", "unauthorized"]);
});

test("iLink errors distinguish authentication, rate limit, invalid JSON and compatibility signals", async () => {
  const cases = [
    { response: { status: 401, body: "{}" }, kind: "authentication" },
    { response: { status: 429, body: "{}" }, kind: "rate_limit" },
    { response: { body: "not-json" }, kind: "invalid_json" },
    { response: { body: "{}" }, kind: "compatibility_signal" },
    { response: { body: await fixture("auth-expired.json") }, kind: "authentication" }
  ] as const;
  for (const item of cases) {
    const fake = queuedFetch([item.response]);
    const client = new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch });
    await assert.rejects(
      client.getUpdates(""),
      (error) => error instanceof IlinkError && error.kind === item.kind
    );
  }
});

test("known iLink error fixture stays aligned with runtime classification", async () => {
  const document = JSON.parse(await fixture("known-errors.json")) as {
    cases: {
      http_status: number;
      body?: unknown;
      expected_kind: string;
    }[];
  };
  for (const item of document.cases) {
    const fake = queuedFetch([{
      status: item.http_status,
      body: JSON.stringify(item.body ?? {})
    }]);
    await assert.rejects(
      new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch }).getUpdates(""),
      (error) => error instanceof IlinkError && error.kind === item.expected_kind
    );
  }
});

test("iLink client bounds request, response and binary protocol content", async () => {
  const oversizedResponse = queuedFetch([{ body: "x".repeat(65) }]);
  await assert.rejects(
    new IlinkHttpClient({
      baseUrl: "https://fixture.invalid",
      fetch: oversizedResponse.fetch,
      maxResponseBytes: 64
    }).getUpdates(""),
    (error) => error instanceof IlinkError &&
      error.kind === "protocol" &&
      !error.message.includes("xxx")
  );

  const requestClient = new IlinkHttpClient({
    baseUrl: "https://fixture.invalid",
    fetch: queuedFetch([]).fetch,
    maxRequestBytes: 64
  });
  await assert.rejects(
    requestClient.getUpdates("x".repeat(128)),
    (error) => error instanceof IlinkError && error.kind === "protocol"
  );

  const binary = queuedFetch([{ body: `{"get_updates_buf":"ok"}\u0000` }]);
  await assert.rejects(
    new IlinkHttpClient({
      baseUrl: "https://fixture.invalid",
      fetch: binary.fetch
    }).getUpdates(""),
    (error) => error instanceof IlinkError &&
      error.kind === "invalid_json" &&
      !error.message.includes("get_updates_buf")
  );
});

test("sendText preserves stable client_id and context_token", async () => {
  const fake = queuedFetch([{ body: await fixture("send-success.json") }]);
  const client = new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch });
  await client.sendText({
    toUserId: "fixture-owner",
    contextToken: "context-placeholder",
    clientId: "stable-reply-1",
    text: "status"
  });
  const body = JSON.parse(String(fake.requests[0]?.init?.body)) as {
    msg: Record<string, unknown>;
  };
  assert.equal(body.msg["client_id"], "stable-reply-1");
  assert.equal(body.msg["context_token"], "context-placeholder");
});

test("sendText accepts the real empty success response", async () => {
  const fake = queuedFetch([{ body: "{}" }]);
  const client = new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch });
  await client.sendText({
    toUserId: "fixture-owner",
    contextToken: "context-placeholder",
    clientId: "stable-empty-success",
    text: "status"
  });
  assert.equal(fake.requests.length, 1);
});

test("sendText retries only the reply with the same client_id", async () => {
  const fake = queuedFetch([
    { status: 503, body: "{}" },
    { body: await fixture("send-success.json") }
  ]);
  const delays: number[] = [];
  const client = new IlinkHttpClient({
    baseUrl: "https://fixture.invalid",
    fetch: fake.fetch,
    replyRetryDelaysMs: [7],
    sleep: async (milliseconds) => { delays.push(milliseconds); }
  });
  await client.sendText({
    toUserId: "fixture-owner",
    contextToken: "context-placeholder",
    clientId: "stable-reply-retry",
    text: "result"
  });
  assert.deepEqual(delays, [7]);
  const bodies = fake.requests.map((request) =>
    JSON.parse(String(request.init?.body)) as { msg: { client_id: string } }
  );
  assert.deepEqual(bodies.map((body) => body.msg.client_id), [
    "stable-reply-retry",
    "stable-reply-retry"
  ]);
});

test("send endpoint reaches INCOMPATIBLE independently with a stable client_id", async () => {
  const fake = queuedFetch([
    { status: 404, body: "{}" },
    { status: 404, body: "{}" },
    { status: 404, body: "{}" }
  ]);
  const client = new IlinkHttpClient({
    baseUrl: "https://fixture.invalid",
    fetch: fake.fetch,
    replyRetryDelaysMs: [0, 0],
    sleep: async () => undefined
  });
  await assert.rejects(
    client.sendText({
      toUserId: "fixture-owner",
      contextToken: "context-placeholder",
      clientId: "stable-incompatible-reply",
      text: "result"
    }),
    (error) => error instanceof IlinkError && error.kind === "incompatible"
  );
  assert.equal(fake.requests.length, 3);
  assert.deepEqual(fake.requests.map((request) => {
    const body = JSON.parse(String(request.init?.body)) as { msg: { client_id: string } };
    return body.msg.client_id;
  }), [
    "stable-incompatible-reply",
    "stable-incompatible-reply",
    "stable-incompatible-reply"
  ]);
});

test("monitor backs off retryable failures and stops on authentication", async () => {
  const fake = queuedFetch([
    { status: 503, body: "{}" },
    { body: await fixture("getupdates-text.json") },
    { status: 401, body: "{}" }
  ]);
  const statuses: string[] = [];
  const delays: number[] = [];
  const monitor = new IlinkMonitor(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch }),
    "account-1",
    new Set(["fixture-owner"]),
    { accept: async () => undefined }
  );
  await assert.rejects(
    monitor.run({
      signal: new AbortController().signal,
      retryDelaysMs: [11],
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      onStatus: (status) => { statuses.push(status); }
    }),
    (error) => error instanceof IlinkError && error.kind === "authentication"
  );
  assert.deepEqual(delays, [11]);
  assert.deepEqual(statuses, ["backing_off", "connected", "authentication_required"]);
});

test("monitor enters INCOMPATIBLE only after three identical consecutive signals", async () => {
  const fake = queuedFetch([
    { body: "{}" },
    { body: "{}" },
    { body: "{}" }
  ]);
  const statuses: { status: string; kind?: string }[] = [];
  const monitor = new IlinkMonitor(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch }),
    "account-1",
    new Set(["fixture-owner"]),
    { accept: async () => undefined }
  );
  await assert.rejects(
    monitor.run({
      signal: new AbortController().signal,
      retryDelaysMs: [0],
      sleep: async () => undefined,
      onStatus: (status, error) => {
        statuses.push({ status, ...(error === undefined ? {} : { kind: error.kind }) });
      }
    }),
    (error) => error instanceof IlinkError && error.kind === "incompatible"
  );
  assert.deepEqual(statuses, [
    { status: "backing_off", kind: "compatibility_signal" },
    { status: "backing_off", kind: "compatibility_signal" },
    { status: "incompatible", kind: "incompatible" }
  ]);
});

test("successful poll resets the consecutive incompatibility threshold", async () => {
  const fake = queuedFetch([
    { body: "{}" },
    { body: await fixture("getupdates-text.json") },
    { body: "{}" },
    { body: "{}" },
    { status: 401, body: "{}" }
  ]);
  const statuses: string[] = [];
  const monitor = new IlinkMonitor(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch }),
    "account-1",
    new Set(["fixture-owner"]),
    { accept: async () => undefined }
  );
  await assert.rejects(
    monitor.run({
      signal: new AbortController().signal,
      retryDelaysMs: [0],
      sleep: async () => undefined,
      onStatus: (status, error) => { statuses.push(`${status}:${error?.kind ?? "ok"}`); }
    }),
    (error) => error instanceof IlinkError && error.kind === "authentication"
  );
  assert.deepEqual(statuses, [
    "backing_off:compatibility_signal",
    "connected:ok",
    "backing_off:compatibility_signal",
    "backing_off:compatibility_signal",
    "authentication_required:authentication"
  ]);
});

test("rate limit is reported independently from network backoff", async () => {
  const fake = queuedFetch([
    { status: 429, body: "{}" },
    { status: 401, body: "{}" }
  ]);
  const statuses: string[] = [];
  const monitor = new IlinkMonitor(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch: fake.fetch }),
    "account-1",
    new Set(["fixture-owner"]),
    { accept: async () => undefined }
  );
  await assert.rejects(monitor.run({
    signal: new AbortController().signal,
    retryDelaysMs: [0],
    sleep: async () => undefined,
    onStatus: (status) => { statuses.push(status); }
  }));
  assert.deepEqual(statuses, ["rate_limited", "authentication_required"]);
});

test("QR login displays non-secret QR URL and stores confirmed token through CredentialStore", async () => {
  const fake = queuedFetch([
    { body: await fixture("qr-start.json") },
    { body: await fixture("qr-confirmed.json") }
  ]);
  const credentials = new FakeCredentialStore();
  const displayed: string[] = [];
  const login = new IlinkQrLogin(
    new IlinkHttpClient({ baseUrl: "https://ilinkai.weixin.qq.com", fetch: fake.fetch }),
    credentials
  );
  const result = await login.login({
    credentialReference: "wechat-account",
    display: async (value) => { displayed.push(value); }
  });
  assert.deepEqual(displayed, ["https://fixture.invalid/qr"]);
  assert.equal(await credentials.get("wechat-account"), "fixture-token-placeholder");
  assert.equal(result.accountId, "fixture-bot");
});

test("iLink ChannelPort delivers accepted text and sends chunked replies on the captured route", async () => {
  const updates = await fixture("getupdates-text.json");
  const sendSuccess = await fixture("send-success.json");
  const sentBodies: unknown[] = [];
  let updateCalls = 0;
  const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("sendmessage")) {
      sentBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(sendSuccess, { status: 200 });
    }
    updateCalls += 1;
    if (updateCalls === 1) return new Response(updates, { status: 200 });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof globalThis.fetch;
  const adapter = new IlinkChannelAdapter(
    new IlinkHttpClient({ baseUrl: "https://fixture.invalid", fetch }),
    new FakeIdGenerator(),
    { accountId: "account-1", allowedSenders: new Set(["fixture-owner"]) }
  );
  const received = new Promise<void>((resolve) => {
    void adapter.start(async (message) => {
      assert.equal(message.text, "/status");
      resolve();
    });
  });
  await received;
  await adapter.send({
    conversationId: "fixture-conversation",
    text: "result",
    replyTo: "1001"
  });
  await adapter.stop();
  assert.equal(sentBodies.length, 1);
  const body = sentBodies[0] as { msg: Record<string, unknown> };
  assert.equal(body.msg["to_user_id"], "fixture-owner");
  assert.equal(body.msg["context_token"], "fixture-context-placeholder");
  assert.equal(body.msg["client_id"], "wechat-reply-1-1");
});
