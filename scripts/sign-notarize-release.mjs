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
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyReleaseDirectory } from "../dist/src/update/release-directory-verifier.js";

const { values } = parseArgs({
  options: {
    release: { type: "string" },
    output: { type: "string" },
    identity: { type: "string" },
    "notary-profile": { type: "string" }
  },
  strict: true
});

if (process.platform !== "darwin") throw new Error("AgentLink signing requires macOS");
const release = required(values.release, "--release");
const output = resolve(required(values.output, "--output"));
const identity = required(values.identity, "--identity");
const notaryProfile = required(values["notary-profile"], "--notary-profile");
if (!output.endsWith(".dmg")) throw new Error("--output must end in .dmg");
if (await exists(output)) throw new Error(`Output already exists: ${output}`);

const source = resolve(release);
await verifyReleaseDirectory(source);
await assertSigningIdentity(identity);
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(dirname(output), ".agentlink-signed-release-"));
const signedRelease = join(staging, "AgentLink");
const notarizationRecord = `${output}.notarization.json`;

try {
  await cp(source, signedRelease, { recursive: true, force: false, errorOnExist: true });
  await privatize(signedRelease);
  const machOs = await findMachOs(signedRelease);
  if (machOs.length === 0) throw new Error("Release contains no Mach-O files to sign");
  for (const path of machOs) {
    await run("/usr/bin/codesign", [
      "--force",
      "--sign", identity,
      "--options", "runtime",
      "--timestamp",
      "--strict",
      path
    ]);
    await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", path]);
  }
  await writeManifest(signedRelease);
  await verifyReleaseDirectory(signedRelease);
  await run("/usr/bin/hdiutil", [
    "create",
    "-volname", "AgentLink",
    "-srcfolder", signedRelease,
    "-format", "UDZO",
    "-ov",
    output
  ]);
  await run("/usr/bin/codesign", [
    "--force",
    "--sign", identity,
    "--timestamp",
    "--strict",
    output
  ]);
  await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", output]);
  const notarization = await capture("/usr/bin/xcrun", [
    "notarytool",
    "submit",
    output,
    "--keychain-profile", notaryProfile,
    "--wait",
    "--output-format", "json"
  ]);
  await writeFile(notarizationRecord, notarization, { mode: 0o600 });
  await run("/usr/bin/xcrun", ["stapler", "staple", output]);
  await run("/usr/bin/xcrun", ["stapler", "validate", output]);
  await run("/usr/sbin/spctl", ["--assess", "--type", "open", "--verbose=4", output]);
  process.stdout.write(`${JSON.stringify({ output, notarizationRecord, signedMachOs: machOs.length })}\n`);
} catch (error) {
  await rm(output, { force: true });
  await rm(notarizationRecord, { force: true });
  throw error;
} finally {
  await rm(staging, { recursive: true, force: true });
}

function required(value, name) {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

async function assertSigningIdentity(identity) {
  const identities = await capture("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  if (!identities.toString("utf8").includes(identity)) {
    throw new Error(`Developer ID signing identity is unavailable: ${identity}`);
  }
}

async function findMachOs(root) {
  const paths = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Release contains symlink: ${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
        const description = (await capture("/usr/bin/file", ["-b", path])).toString("utf8");
        if (description.includes("Mach-O")) paths.push(path);
      }
    }
  }
  return paths.sort();
}

async function writeManifest(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split("\\").join("/");
      if (relativePath === "release-files.json") continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error(`Release contains symlink: ${relativePath}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
        files.push({
          path: relativePath,
          size: metadata.size,
          sha256: await sha256(path, metadata.size)
        });
      } else {
        throw new Error(`Release contains unsupported entry: ${relativePath}`);
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  await writeFile(join(root, "release-files.json"), `${JSON.stringify({
    schemaVersion: 1,
    algorithm: "sha256",
    files
  }, null, 2)}\n`, { mode: 0o600 });
}

async function sha256(path, size) {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error(`Release file changed during hashing: ${path}`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
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

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else reject(new Error(`${command} failed: code=${code} signal=${signal}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise(Buffer.concat(stdout));
      else reject(new Error(`${command} failed: code=${code} signal=${signal}\n${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
