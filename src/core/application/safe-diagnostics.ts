const allowedFields = new Set([
  "event", "category", "code", "state", "method", "status", "retryable", "message"
]);

export function safeDiagnosticRecord(
  input: Readonly<Record<string, unknown>>,
  maxMessageBytes = 512
): Readonly<Record<string, string | number | boolean | null>> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowedFields.has(key)) continue;
    if (typeof value === "string") {
      result[key] = sanitizeDiagnostic(value, maxMessageBytes);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      result[key] = value;
    }
  }
  return result;
}

export function sanitizeDiagnostic(value: string | Buffer, maxBytes = 512): string {
  const source = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const home = process.env["HOME"];
  const redacted = source
    .replace(/-----BEGIN [^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END [^-]{0,40}PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Authorization\s*[:=]\s*)(?:(?:Bearer|Basic)\s+\S+|[^\s,;]+)/giu, "$1[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/giu, "$1[REDACTED]")
    .replace(/\b(Set-Cookie|Cookie)\s*[:=]\s*[^\r\n]+/giu, "$1: [REDACTED]")
    .replace(/(["']?(?:(?:x[-_])?[a-z0-9_-]*(?:token|secret|api[_-]?key)|cookie|authorization|password)["']?\s*[:=]\s*)["']?[^"',\s}]+["']?/giu, "$1[REDACTED]")
    .replace(home === undefined || home === "" ? /$^/u : new RegExp(escapeRegExp(home), "gu"), "~")
    .replace(/\/Users\/[^/\s]+/gu, "/Users/<user>")
    .replace(/\/home\/[^/\s]+/gu, "/home/<user>")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf8(redacted, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16) {
    throw new Error("Diagnostic byte limit must be at least 16");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes - Buffer.byteLength("…", "utf8");
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
