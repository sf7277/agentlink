import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { LocalControlEvent } from "../../core/contracts/ports.js";

export async function sendControlEvent(socketPath: string, event: LocalControlEvent): Promise<unknown> {
  const socket = createConnection(socketPath);
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`${JSON.stringify(event)}\n`);
  const response = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    socket.once("error", reject);
  });
  socket.end();
  return JSON.parse(response) as unknown;
}
