import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedEnvironment,
  ChildProcessTransport
} from "../../src/agent-codex/supervisor/child-process-transport.js";

test("child transport rejects an oversized stdout line and bounds/redacts stderr", async () => {
  const script = [
    "process.stderr.write('prefix token=super-secret-value suffix\\n');",
    "process.stdout.write('x'.repeat(128));",
    "setTimeout(() => {}, 1000);"
  ].join("");
  const transport = new ChildProcessTransport({
    command: process.execPath,
    args: ["-e", script],
    maxLineBytes: 32,
    stderrTailBytes: 64
  });
  const error = await new Promise<Error | undefined>((resolve) => transport.onClose(resolve));
  assert.match(error?.message ?? "", /stdout line exceeds limit/u);
  assert.doesNotMatch(transport.stderrTail(), /super-secret-value/u);
  assert.match(transport.stderrTail(), /\[REDACTED\]/u);
  await transport.close();
});

test("child transport reports unexpected process exit with bounded diagnostics", async () => {
  const transport = new ChildProcessTransport({
    command: process.execPath,
    args: ["-e", "process.stderr.write('tail'); process.exit(7)"],
    stderrTailBytes: 4
  });
  const error = await new Promise<Error | undefined>((resolve) => transport.onClose(resolve));
  assert.match(error?.message ?? "", /code=7/u);
  assert.equal(transport.stderrTail(), "tail");
});

test("child environment is allowlisted even when caller supplies extra variables", () => {
  assert.deepEqual(allowedEnvironment({
    HOME: "/safe-home",
    PATH: "/safe-path",
    CODEX_HOME: "/safe-codex",
    AUTH_TOKEN: "must-not-pass",
    RUST_LOG: "trace"
  }), {
    HOME: "/safe-home",
    PATH: "/safe-path",
    CODEX_HOME: "/safe-codex"
  });
});
