import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = [
  "src", "test", "scripts", "migrations", "protocol-fixtures",
  "docs"
];
const textExtensions = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".json", ".sql", ".md", ".txt", ".yaml", ".yml"
]);
const suspicious = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:token|cookie|app_secret|authorization)\s*[:=]\s*["'][^"'${}]{20,}["']/i
];
const violations = [];

for (const root of roots) {
  let entries = [];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    if (!textExtensions.has(extname(path))) continue;
    const source = await readFile(path, "utf8");
    if (suspicious.some((pattern) => pattern.test(source))) violations.push(path);
  }
}

if (violations.length > 0) {
  console.error(`Potential secrets found:\n${violations.join("\n")}`);
  process.exitCode = 1;
}
