import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const forbidden = [
  "channel-wechat",
  "agent-codex",
  "agent-grok",
  "agent-claude",
  "platform-macos",
  "storage-sqlite",
  "local-control",
  "local-artifacts",
  "composition",
  "update"
];
const root = join("src", "core");
const files = (await readdir(root, { recursive: true }))
  .filter((entry) => entry.endsWith(".ts"));
const violations = [];

for (const file of files) {
  const path = join(root, file);
  const source = await readFile(path, "utf8");
  const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)/gu)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier) => specifier !== undefined);
  for (const moduleName of forbidden) {
    if (imports.some((specifier) => specifier.split("/").includes(moduleName))) {
      violations.push(`${path}: references ${moduleName}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
