import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/migrations", { recursive: true });
await cp("migrations", "dist/migrations", { recursive: true, force: true });
await mkdir("dist/protocol-fixtures", { recursive: true });
await cp("protocol-fixtures", "dist/protocol-fixtures", { recursive: true, force: true });
await mkdir("dist/src/platform-macos", { recursive: true });
if (process.platform === "darwin") {
  const targetArch = process.env["AGENTLINK_TARGET_ARCH"] ?? process.arch;
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error(`Unsupported macOS target architecture: ${targetArch}`);
  }
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/clang", [
      "-arch", targetArch === "x64" ? "x86_64" : "arm64",
      "-fobjc-arc",
      "-fmodules-cache-path=/tmp/agentlink-clang-module-cache",
      "-framework", "Foundation",
      "-framework", "Security",
      "src/platform-macos/keychain-helper.m",
      "-o", "dist/src/platform-macos/agentlink-keychain-helper"
    ], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) {
        reject(new Error(`Keychain helper compilation failed: code=${code} signal=${signal}`));
      } else {
        resolve();
      }
    });
  });
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/clang", [
      "-arch", targetArch === "x64" ? "x86_64" : "arm64",
      "-fobjc-arc",
      "-fmodules-cache-path=/tmp/agentlink-clang-module-cache",
      "-framework", "AppKit",
      "-framework", "CoreImage",
      "src/platform-macos/qr-code-renderer.m",
      "-o", "dist/src/platform-macos/agentlink-qr-code-renderer"
    ], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0) {
        reject(new Error(`QR renderer compilation failed: code=${code} signal=${signal}`));
      } else {
        resolve();
      }
    });
  });
}
