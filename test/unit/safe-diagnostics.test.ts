import assert from "node:assert/strict";
import { test } from "node:test";
import {
  safeDiagnosticRecord,
  sanitizeDiagnostic
} from "../../src/core/application/safe-diagnostics.js";

test("safe diagnostics redact credentials, normalize local paths, binary controls and length", () => {
  const value = [
    "Authorization: Bearer abcdefghijklmnop",
    "cookie=session-value",
    "token=secret-value",
    `${process.env["HOME"] ?? "/Users/private-user"}/project`,
    "binary:\u0000\u0001",
    "x".repeat(1_000)
  ].join(" ");
  const output = sanitizeDiagnostic(value, 256);
  const homePattern = (process.env["HOME"] ?? "/Users/private-user")
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.doesNotMatch(output, /abcdefghijklmnop|session-value|secret-value/u);
  assert.doesNotMatch(output, new RegExp(homePattern, "u"));
  assert.match(output, /\[REDACTED\]/u);
  assert.ok(Buffer.byteLength(output, "utf8") <= 256);
  assert.doesNotMatch(output, /[\u0000\u0001]/u);
});

test("diagnostic records drop prompts, bodies and binary fields", () => {
  assert.deepEqual(safeDiagnosticRecord({
    event: "request_failed",
    status: 500,
    message: "token=secret-value",
    prompt: "ignore previous instructions",
    body: "private body",
    binary: Buffer.from([0, 1, 2])
  }), {
    event: "request_failed",
    status: 500,
    message: "token=[REDACTED]"
  });
});

test("safe diagnostics redact authorization variants, cookies and custom token headers", () => {
  const output = sanitizeDiagnostic([
    "Authorization: opaque-secret-without-scheme",
    "Authorization=Basic secret-value",
    "Cookie: first=private; second=also-private",
    "X-Service-Token: custom-token-value",
    "X-Api-Key=api-key-value"
  ].join("\n"));
  assert.doesNotMatch(
    output,
    /opaque-secret-without-scheme|secret-value|first=private|also-private|custom-token-value|api-key-value/u
  );
  assert.match(output, /Authorization: \[REDACTED\]/u);
  assert.match(output, /Cookie: \[REDACTED\]/u);
  assert.match(output, /X-Service-Token: \[REDACTED\]/u);
  assert.match(output, /X-Api-Key=\[REDACTED\]/u);
});

test("safe diagnostics bounds work for a long non-secret token", () => {
  const output = sanitizeDiagnostic("x".repeat(400 * 1024), 256);
  assert.equal(Buffer.byteLength(output), 256);
});
