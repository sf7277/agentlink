import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureCommandOutput } from "../../platform-windows/process-control.js";

const REQUIRED_CLIENT_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
  "thread/list",
  "thread/read",
  "thread/inject_items",
  "turn/start",
  "turn/steer",
  "turn/interrupt"
] as const;

const REQUIRED_SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval"
] as const;

const REQUIRED_SERVER_NOTIFICATIONS = [
  "turn/started",
  "turn/completed",
  "item/completed",
  "serverRequest/resolved"
] as const;

export async function assertCodexProtocolCompatible(command: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agentlink-codex-schema-"));
  try {
    await captureCommandOutput(command, ["app-server", "generate-ts", "--out", directory], {
      timeoutMs: 30_000,
      maxBytes: 64 * 1024,
      env: { PATH: process.env["PATH"] ?? process.env["Path"] ?? "" }
    });
    await verifyGeneratedProtocolSurface(directory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex App Server protocol is incompatible with AgentLink: ${detail}`);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function verifyGeneratedProtocolSurface(directory: string): Promise<void> {
  const [clientRequests, serverRequests, serverNotifications] = await Promise.all([
    readFile(join(directory, "ClientRequest.ts"), "utf8"),
    readFile(join(directory, "ServerRequest.ts"), "utf8"),
    readFile(join(directory, "ServerNotification.ts"), "utf8")
  ]);
  assertMethods(clientRequests, REQUIRED_CLIENT_METHODS, "client method");
  assertMethods(serverRequests, REQUIRED_SERVER_REQUESTS, "server request");
  assertMethods(serverNotifications, REQUIRED_SERVER_NOTIFICATIONS, "server notification");
}

function assertMethods(
  schema: string,
  methods: readonly string[],
  kind: string
): void {
  const missing = methods.filter((method) => !schema.includes(`"method": "${method}"`));
  if (missing.length > 0) {
    throw new Error(`missing required ${kind}${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
}
