import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  LaunchAgentService,
  type ServiceCommandRunner
} from "../../src/platform-macos/launch-agent-service.js";
import {
  ensureMacosApplicationPaths,
  macosApplicationPaths
} from "../../src/platform-macos/application-paths.js";

class FakeLaunchctl implements ServiceCommandRunner {
  readonly calls: readonly string[][] = [];
  loaded = false;
  failNextKickstart = false;
  bootstrapFailuresRemaining = 0;

  public async run(args: readonly string[]): Promise<{ code: number; stdout: string }> {
    (this.calls as string[][]).push([...args]);
    if (args[0] === "bootstrap") {
      if (this.bootstrapFailuresRemaining > 0) {
        this.bootstrapFailuresRemaining -= 1;
        return { code: 5, stdout: "" };
      }
      this.loaded = true;
      return { code: 0, stdout: "" };
    }
    if (args[0] === "kickstart") {
      if (this.failNextKickstart) {
        this.failNextKickstart = false;
        return { code: 5, stdout: "" };
      }
      return { code: 0, stdout: "" };
    }
    if (args[0] === "bootout") {
      const wasLoaded = this.loaded;
      this.loaded = false;
      return { code: wasLoaded ? 0 : 3, stdout: "" };
    }
    if (args[0] === "print") {
      return { code: this.loaded ? 0 : 3, stdout: this.loaded ? "state = running" : "" };
    }
    return { code: 1, stdout: "" };
  }
}

async function release(root: string, version: string, arch: "arm64" | "x64") {
  const directory = join(root, `release-${version}-${arch}`);
  const entrypoint = join(directory, "dist", "src");
  const migrationDirectory = join(directory, "dist", "migrations");
  await mkdir(entrypoint, { recursive: true, mode: 0o700 });
  await mkdir(migrationDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "runtime", "bin"), { recursive: true, mode: 0o700 });
  await copyFile(process.execPath, join(directory, "runtime", "bin", "node"));
  await chmod(join(directory, "runtime", "bin", "node"), 0o700);
  await writeFile(join(directory, "release.json"), JSON.stringify({
    schemaVersion: 1,
    product: "agentlink",
    version,
    target: { os: "darwin", arch },
    entrypoint: "dist/src/main.js",
    nodeMajor: 22,
    runtime: {
      path: "runtime/bin/node",
      version: process.versions.node
    }
  }), { mode: 0o600 });
  await writeFile(join(entrypoint, "main.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
  const migrationFiles = [
    "001_initial.sql",
    "002_product_lifecycle.sql",
    "003_bounded_import_provenance.sql",
    "004_project_default_agent.sql"
  ];
  for (const filename of migrationFiles) {
    const target = join(migrationDirectory, filename);
    await copyFile(join(process.cwd(), "migrations", filename), target);
    await chmod(target, 0o600);
  }
  const releasePaths = [
    "release.json",
    "runtime/bin/node",
    "dist/src/main.js",
    ...migrationFiles.map((filename) => `dist/migrations/${filename}`)
  ];
  const files = await Promise.all([
    ...releasePaths
  ].map(async (path) => {
    const content = await readFile(join(directory, path));
    return {
      path,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex")
    };
  }));
  await writeFile(join(directory, "release-files.json"), JSON.stringify({
    schemaVersion: 1,
    algorithm: "sha256",
    files
  }), { mode: 0o600 });
  return directory;
}

test("LaunchAgent install is private, locally confirmed and default uninstall preserves data", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-service-home-"));
  const paths = macosApplicationPaths(home);
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentlink-service-release-"));
  const source = await release(sourceRoot, "0.1.0", process.arch as "arm64" | "x64");
  const runner = new FakeLaunchctl();
  const service = new LaunchAgentService({ paths, runner, hostArch: process.arch as "arm64" | "x64" });
  await assert.rejects(
    service.install({ releaseDirectory: source, confirmation: "wrong" as never }),
    /confirmation/u
  );
  const installed = await service.install({
    releaseDirectory: source,
    confirmation: "INSTALL_AGENTLINK_LOCALLY"
  });
  assert.equal(installed.version, "0.1.0");
  assert.deepEqual(await service.status(), {
    installed: true,
    loaded: true,
    detail: "loaded"
  });
  assert.equal((await lstat(paths.launchAgent)).mode & 0o777, 0o600);
  const plist = await readFile(paths.launchAgent, "utf8");
  assert.match(plist, /com\.agentlink\.gateway/u);
  assert.match(plist, /0\.1\.0\/dist\/src\/main\.js/u);
  assert.match(plist, /0\.1\.0\/runtime\/bin\/node/u);
  assert.match(plist, /<string>\/dev\/null<\/string>/u);
  assert.doesNotMatch(plist, /token|cookie|Authorization/iu);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(paths.logs, "gateway.stdout.log"))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(paths.logs, "gateway.stderr.log"))).mode & 0o777, 0o600);

  await service.restart();
  assert.ok(runner.calls.some((call) =>
    call[0] === "kickstart" && call[1] === "-k"
  ));
  runner.loaded = false;
  assert.equal((await service.start()).loaded, true);
  assert.equal((await service.stop()).loaded, false);
  assert.equal((await lstat(paths.launchAgent)).isFile(), true);

  await service.uninstall("UNINSTALL_AGENTLINK_LOCALLY");
  assert.deepEqual(await service.status(), {
    installed: false,
    loaded: false,
    detail: "not_installed"
  });
  assert.equal((await lstat(paths.config)).isFile(), true);
  assert.equal((await lstat(join(paths.releases, "0.1.0"))).isDirectory(), true);
});

test("LaunchAgent install retries a transient bootstrap race", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-bootstrap-retry-home-"));
  const paths = macosApplicationPaths(home);
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentlink-bootstrap-retry-release-"));
  const source = await release(sourceRoot, "0.1.0", process.arch as "arm64" | "x64");
  const runner = new FakeLaunchctl();
  runner.bootstrapFailuresRemaining = 1;
  const service = new LaunchAgentService({
    paths,
    runner,
    hostArch: process.arch as "arm64" | "x64"
  });

  await service.install({
    releaseDirectory: source,
    confirmation: "INSTALL_AGENTLINK_LOCALLY"
  });
  assert.equal(runner.calls.filter((call) => call[0] === "bootstrap").length, 2);
  assert.equal(runner.loaded, true);
});

test("failed upgrade restores the old plist, keeps database backup and removes candidate release", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-upgrade-home-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentlink-upgrade-release-"));
  const first = await release(sourceRoot, "0.1.0", process.arch as "arm64" | "x64");
  const second = await release(sourceRoot, "0.2.0", process.arch as "arm64" | "x64");
  const runner = new FakeLaunchctl();
  const service = new LaunchAgentService({ paths, runner, hostArch: process.arch as "arm64" | "x64" });
  await service.install({
    releaseDirectory: first,
    confirmation: "INSTALL_AGENTLINK_LOCALLY"
  });
  const database = new Database(paths.database);
  database.exec("CREATE TABLE durable(id INTEGER PRIMARY KEY)");
  database.close();
  await chmod(paths.database, 0o600);
  runner.failNextKickstart = true;
  await assert.rejects(service.install({
    releaseDirectory: second,
    confirmation: "INSTALL_AGENTLINK_LOCALLY"
  }), /kickstart/u);
  const restored = await readFile(paths.launchAgent, "utf8");
  assert.match(restored, /0\.1\.0\/dist\/src\/main\.js/u);
  assert.doesNotMatch(restored, /0\.2\.0\/dist\/src\/main\.js/u);
  assert.deepEqual((await readdir(paths.releases)).sort(), ["0.1.0"]);
  assert.equal((await readdir(paths.backups)).length, 2);
  assert.equal(runner.loaded, true);
});

test("wrong architecture and symlinked release content are rejected before activation", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-service-reject-home-"));
  const paths = macosApplicationPaths(home);
  const sourceRoot = await mkdtemp(join(tmpdir(), "agentlink-service-reject-release-"));
  const wrongArch = process.arch === "arm64" ? "x64" : "arm64";
  const incompatible = await release(sourceRoot, "0.1.0", wrongArch);
  const runner = new FakeLaunchctl();
  const service = new LaunchAgentService({ paths, runner, hostArch: process.arch as "arm64" | "x64" });
  await assert.rejects(service.install({
    releaseDirectory: incompatible,
    confirmation: "INSTALL_AGENTLINK_LOCALLY"
  }), /does not match/u);

  const linked = await release(sourceRoot, "0.2.0", process.arch as "arm64" | "x64");
  await symlink("/tmp", join(linked, "unsafe-link"));
  await assert.rejects(service.install({
    releaseDirectory: linked,
    confirmation: "INSTALL_AGENTLINK_LOCALLY"
  }), /symlink/u);

  const tampered = await release(sourceRoot, "0.3.0", process.arch as "arm64" | "x64");
  await writeFile(join(tampered, "dist", "src", "main.js"), "tampered\n", { mode: 0o700 });
  await assert.rejects(service.install({
    releaseDirectory: tampered,
    confirmation: "INSTALL_AGENTLINK_LOCALLY"
  }), /verification failed/u);
  assert.equal(runner.calls.length, 0);
});

test("destructive purge requires a second confirmation and deletes only explicit credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "agentlink-service-purge-home-"));
  const paths = macosApplicationPaths(home);
  await ensureMacosApplicationPaths(paths);
  await writeFile(paths.config, "{}\n", { mode: 0o600 });
  const runner = new FakeLaunchctl();
  const service = new LaunchAgentService({ paths, runner, hostArch: process.arch as "arm64" | "x64" });
  await assert.rejects(service.purge({
    uninstallConfirmation: "UNINSTALL_AGENTLINK_LOCALLY",
    destructiveConfirmation: "wrong" as never
  }), /destructive local confirmation/u);
  assert.equal((await lstat(paths.applicationSupport)).isDirectory(), true);

  const deleted: string[] = [];
  await service.purge({
    uninstallConfirmation: "UNINSTALL_AGENTLINK_LOCALLY",
    destructiveConfirmation: "DELETE_AGENTLINK_DATA",
    credentialReferences: ["wechat-explicit-reference"],
    deleteCredential: async (reference) => { deleted.push(reference); }
  });
  assert.deepEqual(deleted, ["wechat-explicit-reference"]);
  await assert.rejects(lstat(paths.applicationSupport));
  await assert.rejects(lstat(paths.caches));
  await assert.rejects(lstat(paths.logs));
});
