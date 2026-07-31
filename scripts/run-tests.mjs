import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const requested = process.argv.slice(2);
const groups = requested.length === 0
  ? ["unit", "contract", "integration", "fault", "acceptance"]
  : requested;
const files = [];

for (const group of groups) {
  const directory = join("dist", "test", group);
  try {
    const entries = await readdir(directory, { recursive: true });
    files.push(...entries
      .filter((entry) => entry.endsWith(".test.js"))
      .map((entry) => join(directory, entry)));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

if (files.length === 0) {
  console.error(`No compiled tests found for: ${groups.join(", ")}`);
  process.exitCode = 1;
} else {
  // A test can leave an event-loop handle open after all assertions have completed.
  // Keep CI bounded without changing production-process lifecycle behavior.
  const child = spawn(process.execPath, ["--test", "--test-force-exit", ...files.sort()], {
    stdio: "inherit",
    shell: false
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal === null ? (code ?? 1) : 1;
  });
}
