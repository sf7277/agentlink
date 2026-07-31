import { createHash } from "node:crypto";
import { chmod, cp, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    output: { type: "string" },
    version: { type: "string" }
  }
});
if (values.source === undefined || values.output === undefined || values.version === undefined) {
  throw new Error("--source, --output and --version are required");
}
if (!/^0\.\d+\.\d+$/u.test(values.version)) throw new Error("Fixture version must be pre-1.0");
const source = resolve(values.source);
const output = resolve(values.output);
if (!output.startsWith("/private/tmp/") && !output.startsWith("/tmp/")) {
  throw new Error("Failing release fixtures may only be created under /tmp");
}
await cp(source, output, { recursive: true, errorOnExist: true, force: false });
const releasePath = join(output, "release.json");
const release = JSON.parse(await readFile(releasePath, "utf8"));
release.version = values.version;
await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600 });
await writeFile(
  join(output, "dist/src/main.js"),
  '#!/usr/bin/env node\nthrow new Error("Injected acceptance startup failure");\n',
  { mode: 0o700 }
);
const files = [];
const pending = [output];
while (pending.length > 0) {
  const directory = pending.pop();
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const relativePath = relative(output, path);
    if (relativePath === "release-files.json") continue;
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      await chmod(path, 0o700);
      pending.push(path);
    } else if (metadata.isFile()) {
      const content = await readFile(path);
      await chmod(path, (metadata.mode & 0o100) === 0 ? 0o600 : 0o700);
      files.push({
        path: relativePath,
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex")
      });
    } else {
      throw new Error(`Unsupported fixture entry: ${relativePath}`);
    }
  }
}
files.sort((left, right) => left.path.localeCompare(right.path));
await writeFile(join(output, "release-files.json"), `${JSON.stringify({
  schemaVersion: 1,
  algorithm: "sha256",
  files
}, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output, files: files.length })}\n`);
