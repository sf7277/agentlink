import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { LocalControlEvent } from "../../core/contracts/ports.js";

/**
 * Node's IPC client supports both Unix domain sockets and Windows Named Pipes.
 * Keep the transport name platform-neutral so callers cannot accidentally
 * encode a Unix-only assumption into the control plane.
 */
export async function sendControlEvent(endpoint: string, event: LocalControlEvent): Promise<unknown> {
  const connection = createConnection(endpoint);
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      connection.once("connect", resolve);
      connection.once("error", reject);
    });
    const inputLines = createInterface({ input: connection, crlfDelay: Infinity });
    lines = inputLines;
    connection.write(`${JSON.stringify(event)}\n`);
    const response = await new Promise<string>((resolve, reject) => {
      inputLines.once("line", resolve);
      inputLines.once("error", reject);
      connection.once("error", reject);
      connection.once("close", () => reject(new Error("Local control connection closed before response")));
    });
    return JSON.parse(response) as unknown;
  } finally {
    lines?.close();
    connection.destroy();
  }
}
