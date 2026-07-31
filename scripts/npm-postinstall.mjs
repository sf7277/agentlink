import { spawn } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  throw new Error(
    `AgentLink npm installation requires Node.js 22 or later; found ${process.versions.node}`
  );
}
if (process.platform !== "darwin") {
  throw new Error(`AgentLink npm installation supports macOS only; found ${process.platform}`);
}
if (process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error(`AgentLink npm installation supports arm64 or x64; found ${process.arch}`);
}

const root = resolve(import.meta.dirname, "..");
const targetArch = process.arch === "x64" ? "x86_64" : "arm64";
const helpers = [
  {
    source: resolve(root, "src/platform-macos/keychain-helper.m"),
    output: resolve(root, "dist/src/platform-macos/agentlink-keychain-helper"),
    frameworks: ["Foundation", "Security"]
  },
  {
    source: resolve(root, "src/platform-macos/qr-code-renderer.m"),
    output: resolve(root, "dist/src/platform-macos/agentlink-qr-code-renderer"),
    frameworks: ["AppKit", "CoreImage"]
  }
];

for (const helper of helpers) {
  await mkdir(dirname(helper.output), { recursive: true });
  await run("/usr/bin/clang", [
    "-arch", targetArch,
    "-fobjc-arc",
    "-fmodules-cache-path=/tmp/agentlink-npm-clang-module-cache",
    ...helper.frameworks.flatMap((framework) => ["-framework", framework]),
    helper.source,
    "-o", helper.output
  ]);
  await chmod(helper.output, 0o700);
  const metadata = await stat(helper.output);
  if ((metadata.mode & 0o100) === 0) throw new Error(`Compiled helper is not executable: ${helper.output}`);
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else reject(new Error(`${command} failed: code=${code} signal=${signal}`));
    });
  });
}
