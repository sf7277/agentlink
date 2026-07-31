import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AcpRpcClient } from "../protocol/acp-rpc-client.js";
import {
  assertSupportedGrokVersion,
  readGrokVersion
} from "../protocol/version-gate.js";
import { prepareIsolatedGrokHome } from "../home/isolated-home.js";
import { ChildProcessTransport } from "./child-process-transport.js";

export interface GrokRuntimeOptions {
  readonly command?: string;
  readonly clientVersion: string;
  readonly isolatedHomeRoot: string;
  readonly rpc?: {
    readonly maxLineBytes?: number;
    readonly maxPendingRequests?: number;
    readonly requestTimeoutMs?: number;
  };
}

export interface GrokRuntime {
  readonly client: AcpRpcClient;
  readonly transport: ChildProcessTransport;
  readonly grokHome: string;
  readonly sessionCapabilities: {
    readonly close: boolean;
    readonly delete: boolean;
  };
  close(): Promise<void>;
}

export async function startGrokRuntime(options: GrokRuntimeOptions): Promise<GrokRuntime> {
  const command = options.command ?? "grok";
  const version = await readGrokVersion(command);
  assertSupportedGrokVersion(version);
  await mkdir(options.isolatedHomeRoot, { recursive: true, mode: 0o700 });
  const grokHome = await prepareIsolatedGrokHome(
    join(options.isolatedHomeRoot, "grok-home"),
    process.env["HOME"] === undefined ? undefined : join(process.env["HOME"], ".grok")
  );
  const transport = new ChildProcessTransport({
    command,
    args: ["--no-auto-update", "agent", "--no-leader", "stdio"],
    ...(options.rpc?.maxLineBytes === undefined
      ? {}
      : { maxLineBytes: options.rpc.maxLineBytes }),
    environment: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      TMPDIR: process.env["TMPDIR"] ?? "/tmp",
      GROK_HOME: grokHome
    }
  });
  const client = new AcpRpcClient(transport, {
    ...(options.rpc?.maxLineBytes === undefined
      ? {}
      : { maxLineBytes: options.rpc.maxLineBytes }),
    ...(options.rpc?.maxPendingRequests === undefined
      ? {}
      : { maxPendingRequests: options.rpc.maxPendingRequests }),
    ...(options.rpc?.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.rpc.requestTimeoutMs })
  });
  let sessionCapabilities = { close: false, delete: false };
  try {
    const initialize = await client.initialize(options.clientVersion) as {
      agentCapabilities?: {
        loadSession?: boolean;
        sessionCapabilities?: { close?: unknown; delete?: unknown };
      };
    };
    if (initialize.agentCapabilities?.loadSession !== true) {
      throw new Error("Grok ACP initialize missing loadSession capability");
    }
    sessionCapabilities = {
      close: initialize.agentCapabilities.sessionCapabilities?.close !== undefined,
      delete: initialize.agentCapabilities.sessionCapabilities?.delete !== undefined
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
  return {
    client,
    transport,
    grokHome,
    sessionCapabilities,
    close: async () => {
      await client.close();
    }
  };
}
