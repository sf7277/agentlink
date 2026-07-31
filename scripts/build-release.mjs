import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    arch: { type: "string" },
    output: { type: "string" }
  }
});
if (process.platform !== "darwin") throw new Error("AgentLink macOS releases must be built on macOS");
if (process.versions.node.split(".")[0] !== "22") {
  throw new Error("AgentLink releases must be built with Node 22");
}
if (values.arch !== "arm64" && values.arch !== "x64") {
  throw new Error("--arch must be arm64 or x64");
}
if (values.arch !== process.arch) {
  throw new Error(
    `Release target ${values.arch} must match the verified build runtime architecture ${process.arch}`
  );
}
if (values.output === undefined) throw new Error("--output is required");
const npmCli = process.env["npm_execpath"];
if (npmCli === undefined || npmCli === "") {
  throw new Error("AgentLink releases must be started through npm so the Node 22 npm CLI is pinned");
}
const output = resolve(values.output);
if (await exists(output)) throw new Error(`Release output already exists: ${output}`);
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(dirname(output), `.agentlink-release-${values.arch}-`));
await chmod(staging, 0o700);

try {
  const packageDocument = JSON.parse(await readFile("package.json", "utf8"));
  const release = {
    schemaVersion: 1,
    product: "agentlink",
    version: packageDocument.version,
    target: { os: "darwin", arch: values.arch },
    entrypoint: "dist/src/main.js",
    nodeMajor: 22,
    runtime: {
      path: "runtime/bin/node",
      version: process.versions.node
    }
  };
  await cp("package.json", join(staging, "package.json"));
  await cp("package-lock.json", join(staging, "package-lock.json"));
  await cp("LICENSE", join(staging, "LICENSE"));
  await cp("CONTRIBUTING.md", join(staging, "CONTRIBUTING.md"));
  await cp("THIRD_PARTY_NOTICES.md", join(staging, "THIRD_PARTY_NOTICES.md"));
  await cp("README.md", join(staging, "README.md"));
  await run(process.execPath, [npmCli,
    "ci",
    "--omit=dev",
    // Omit optional deps: the Claude Agent SDK's platform packages each bundle
    // a ~245MB claude CLI copy, and AgentLink runs the user's own CLI instead
    // (pathToClaudeCodeExecutable + version gate).
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--cpu=${values.arch === "x64" ? "x64" : "arm64"}`,
    "--os=darwin"
  ], {
    cwd: staging,
    env: process.env
  });
  await run(process.execPath, [
    join(staging, "node_modules/prebuild-install/bin.js"),
    "--arch", values.arch,
    "--platform", "darwin",
    "--runtime", "node",
    "--target", process.versions.node,
    "--force"
  ], {
    cwd: join(staging, "node_modules/better-sqlite3"),
    env: process.env
  });
  await rm(join(staging, "node_modules", ".bin"), { recursive: true, force: true });
  await mkdir(join(staging, "dist"), { recursive: true });
  await cp("dist/src", join(staging, "dist/src"), { recursive: true });
  await cp("dist/migrations", join(staging, "dist/migrations"), { recursive: true });
  await cp("dist/protocol-fixtures", join(staging, "dist/protocol-fixtures"), { recursive: true });
  await mkdir(join(staging, "runtime", "bin"), { recursive: true });
  await cp(process.execPath, join(staging, release.runtime.path));
  await chmod(join(staging, release.runtime.path), 0o700);
  await compileHelper({
    source: "src/platform-macos/keychain-helper.m",
    output: join(staging, "dist/src/platform-macos/agentlink-keychain-helper"),
    frameworks: ["Foundation", "Security"],
    arch: values.arch
  });
  await compileHelper({
    source: "src/platform-macos/qr-code-renderer.m",
    output: join(staging, "dist/src/platform-macos/agentlink-qr-code-renderer"),
    frameworks: ["AppKit", "CoreImage"],
    arch: values.arch
  });
  await assertMachOArchitecture(
    join(staging, "dist/src/platform-macos/agentlink-keychain-helper"),
    values.arch
  );
  await assertMachOArchitecture(
    join(staging, "dist/src/platform-macos/agentlink-qr-code-renderer"),
    values.arch
  );
  await assertMachOArchitecture(
    join(staging, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
    values.arch
  );
  await assertMachOArchitecture(join(staging, release.runtime.path), values.arch);
  await writeFile(join(staging, "release.json"), `${JSON.stringify(release, null, 2)}\n`, {
    mode: 0o600
  });
  const sbom = await capture(process.execPath, [npmCli, "sbom", "--omit=dev", "--sbom-format", "cyclonedx"], {
    cwd: process.cwd(),
    env: process.env
  });
  await writeFile(join(staging, "sbom.cdx.json"), sbom, { mode: 0o600 });
  await privatize(staging);
  const files = await fileManifest(staging, new Set(["release-files.json"]));
  await writeFile(join(staging, "release-files.json"), `${JSON.stringify({
    schemaVersion: 1,
    algorithm: "sha256",
    files
  }, null, 2)}\n`, { mode: 0o600 });
  await syncTree(staging);
  await rename(staging, output);
  process.stdout.write(`${JSON.stringify({
    output,
    version: release.version,
    target: release.target,
    files: files.length
  })}\n`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}

async function compileHelper(input) {
  const args = [
    "-arch", input.arch === "x64" ? "x86_64" : "arm64",
    "-fobjc-arc",
    `-fmodules-cache-path=${join(tmpdir(), "agentlink-clang-module-cache")}`,
    ...input.frameworks.flatMap((framework) => ["-framework", framework]),
    input.source,
    "-o", input.output
  ];
  await run("/usr/bin/clang", args, { cwd: process.cwd(), env: process.env });
}

async function assertMachOArchitecture(path, arch) {
  const description = (await capture("/usr/bin/file", ["-b", path], {
    cwd: process.cwd(),
    env: process.env
  })).toString("utf8");
  const expected = arch === "x64" ? "x86_64" : "arm64";
  if (!description.includes(expected)) {
    throw new Error(`Native artifact has wrong architecture: ${path} (${description.trim()})`);
  }
}

async function fileManifest(root, excluded) {
  const paths = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split("\\").join("/");
      if (excluded.has(relativePath)) continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Release contains symlink: ${relativePath}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
        const content = await readFile(path);
        paths.push({
          path: relativePath,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex")
        });
      } else {
        throw new Error(`Release contains unsupported entry: ${relativePath}`);
      }
    }
  }
  return paths.sort((left, right) => left.path.localeCompare(right.path));
}

async function privatize(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) pending.push(path);
      else await chmod(path, (metadata.mode & 0o100) === 0 ? 0o600 : 0o700);
    }
  }
}

async function syncTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) pending.push(path);
      else {
        const handle = await open(path, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function run(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: "inherit"
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (signal === null && code === 0) resolvePromise();
      else rejectPromise(new Error(
        `${basename(command)} failed: code=${String(code)} signal=${String(signal)}`
      ));
    });
  });
}

function capture(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"]
    });
    const chunks = [];
    let bytes = 0;
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        child.kill("SIGKILL");
        rejectPromise(new Error("SBOM output exceeded size limit"));
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (signal === null && code === 0) resolvePromise(Buffer.concat(chunks));
      else rejectPromise(new Error(
        `${basename(command)} failed: code=${String(code)} signal=${String(signal)}`
      ));
    });
  });
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
