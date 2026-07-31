import { JsonlRpcClient, type JsonlRpcClientOptions } from "../protocol/jsonl-rpc-client.js";
import {
  assertSupportedVersion,
  readCodexVersion,
  type VersionSupport
} from "../protocol/version-gate.js";
import {
  ChildProcessTransport,
  type ChildTransportOptions
} from "./child-process-transport.js";

export interface CodexRuntime {
  readonly client: JsonlRpcClient;
  readonly transport: ChildProcessTransport;
  healthy(maxProtocolIdleMs: number, now?: number): boolean;
  close(): Promise<void>;
}

export async function startCodexRuntime(options: {
  readonly command?: string;
  readonly clientVersion: string;
  readonly versionSupport?: VersionSupport;
  readonly experimentalApi?: boolean;
  readonly requestPermissionsTool?: boolean;
  readonly transport?: Omit<ChildTransportOptions, "command">;
  readonly rpc?: JsonlRpcClientOptions;
}): Promise<CodexRuntime> {
  const command = options.command ?? "codex";
  const support = options.versionSupport ?? {
    minimum: "0.144.4",
    verified: ["0.144.4", "0.144.5"]
  };
  const version = await readCodexVersion(command);
  assertSupportedVersion(version, support);
  const transport = new ChildProcessTransport({
    ...options.transport,
    command,
    args: [
      "app-server",
      ...(options.requestPermissionsTool === true
        ? ["-c", "features.request_permissions_tool=true"]
        : []),
      "--listen",
      "stdio://"
    ]
  });
  const client = new JsonlRpcClient(transport, options.rpc);
  try {
    await client.initialize(options.clientVersion, {
      experimentalApi: options.experimentalApi ?? false
    });
  } catch (error) {
    await transport.close();
    throw error;
  }
  return {
    client,
    transport,
    healthy: (maxProtocolIdleMs, now) =>
      transport.alive() && client.protocolHealthy(maxProtocolIdleMs, now),
    close: () => client.close()
  };
}
