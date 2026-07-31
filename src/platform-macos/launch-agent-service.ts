import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gatewayConfigSchema } from "../composition/config-schema.js";
import { SqliteBackupManager } from "../storage-sqlite/backup-manager.js";
import { verifyReleaseDirectory } from "../update/release-directory-verifier.js";
import {
  assertPrivateOwnedDirectory,
  ensureMacosApplicationPaths,
  type MacosApplicationPaths
} from "./application-paths.js";
import { AtomicConfigStore } from "./atomic-config-store.js";
import { migrateProjectDefaults } from "./project-default-migration.js";

const execFileAsync = promisify(execFile);
const serviceLabel = "com.agentlink.gateway";
export interface ServiceCommandRunner {
  run(args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }>;
}

export interface ServiceStatus {
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly detail: string;
}

export class LaunchAgentService {
  public constructor(private readonly options: {
    readonly paths: MacosApplicationPaths;
    readonly runner?: ServiceCommandRunner;
    readonly hostArch?: "arm64" | "x64";
    readonly uid?: number;
    readonly backups?: SqliteBackupManager;
  }) {}

  public async install(input: {
    readonly releaseDirectory: string;
    readonly confirmation: "INSTALL_AGENTLINK_LOCALLY";
  }): Promise<{
    readonly version: string;
    readonly databaseBackup?: string;
    readonly configBackup?: string;
  }> {
    if (input.confirmation !== "INSTALL_AGENTLINK_LOCALLY") {
      throw new Error("Local installation confirmation is required");
    }
    assertSupportedNode();
    const paths = this.options.paths;
    await ensureMacosApplicationPaths(paths);
    const verifiedRelease = await verifyReleaseDirectory(input.releaseDirectory);
    const canonicalRelease = verifiedRelease.canonicalRoot;
    const metadata = verifiedRelease.metadata;
    if (metadata.target.arch !== (this.options.hostArch ?? process.arch)) {
      throw new Error(`Release architecture ${metadata.target.arch} does not match this host`);
    }
    const destination = join(paths.releases, metadata.version);
    const existingRelease = await optionalLstat(destination);
    if (existingRelease !== undefined) {
      throw new Error(`Release ${metadata.version} is already installed`);
    }

    let databaseBackup: string | undefined;
    const backupSuffix = new Date().toISOString().replace(/[:.]/gu, "-");
    if (await optionalLstat(paths.database) !== undefined) {
      databaseBackup = join(
        paths.backups,
        `pre-update-${backupSuffix}.sqlite`
      );
      await (this.options.backups ?? new SqliteBackupManager()).backup(
        paths.database,
        databaseBackup
      );
    }
    const configExisted = await optionalLstat(paths.config) !== undefined;
    if (!configExisted) {
      await new AtomicConfigStore(paths.config).save(gatewayConfigSchema.parse({}));
    }
    const configBefore = await readPrivateFileIfPresent(paths.config);
    if (configBefore === undefined) throw new Error("AgentLink config backup source is missing");
    const configBackup = configExisted
      ? join(paths.backups, `pre-update-${backupSuffix}.config.json`)
      : undefined;
    if (configBackup !== undefined) await writePrivateAtomic(configBackup, configBefore);

    const staging = join(paths.releases, `.staging-${metadata.version}-${randomUUID()}`);
    let releaseInstalled = false;
    let oldPlist: Buffer | undefined;
    let migrationStarted = false;
    try {
      await cp(canonicalRelease, staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false
      });
      await privatizeTree(staging);
      await rename(staging, destination);
      releaseInstalled = true;
      await syncDirectory(paths.releases);

      oldPlist = await readPrivateFileIfPresent(paths.launchAgent);
      if (oldPlist !== undefined) await this.bootout();
      migrationStarted = true;
      await migrateProjectDefaults({
        configPath: paths.config,
        databasePath: paths.database,
        migrationsDirectory: join(destination, "dist", "migrations")
      });
      const runtimePath = join(destination, metadata.runtime.path);
      await assertRuntimeVersion(runtimePath, metadata.runtime.version);
      const plist = renderLaunchAgentPlist({
        nodePath: await trustedNodePath(runtimePath),
        entrypoint: join(destination, metadata.entrypoint),
        configPath: paths.config,
        stdoutPath: "/dev/null",
        stderrPath: "/dev/null",
        home: dirname(dirname(dirname(paths.applicationSupport)))
      });
      await ensurePrivateLogFile(join(paths.logs, "gateway.stdout.log"));
      await ensurePrivateLogFile(join(paths.logs, "gateway.stderr.log"));
      await writePrivateAtomic(paths.launchAgent, plist);
      const bootstrap = await this.bootstrapWithRetry();
      if (bootstrap.code !== 0) {
        throw new Error(`launchctl bootstrap failed (${bootstrap.code})`);
      }
      const kickstart = await this.runner().run([
        "kickstart",
        "-k",
        `${this.domain()}/${serviceLabel}`
      ]);
      if (kickstart.code !== 0) {
        throw new Error(`launchctl kickstart failed (${kickstart.code})`);
      }
      if (this.options.runner === undefined) {
        await waitForPrivateSocket(paths.socket, 45_000);
      }
      return {
        version: metadata.version,
        ...(databaseBackup === undefined ? {} : { databaseBackup }),
        ...(configBackup === undefined ? {} : { configBackup })
      };
    } catch (error) {
      await this.bootout().catch(() => undefined);
      let rollbackFailure: Error | undefined;
      if (migrationStarted) {
        try {
          if (configExisted) await writePrivateAtomic(paths.config, configBefore);
          else await safeUnlink(paths.config);
        } catch (restoreError) {
          rollbackFailure = new Error("Upgrade failed and config rollback failed", {
            cause: restoreError
          });
        }
        if (databaseBackup !== undefined) {
          try {
            await (this.options.backups ?? new SqliteBackupManager()).restore(
              databaseBackup,
              paths.database
            );
          } catch (restoreError) {
            rollbackFailure ??= new Error("Upgrade failed and database rollback failed", {
              cause: restoreError
            });
          }
        }
      }
      if (oldPlist === undefined) {
        await safeUnlink(paths.launchAgent);
      } else {
        await writePrivateAtomic(paths.launchAgent, oldPlist);
        const restored = await this.bootstrapWithRetry().catch(() => undefined);
        if (restored?.code === 0) {
          await this.runner().run([
            "kickstart",
            "-k",
            `${this.domain()}/${serviceLabel}`
          ]).catch(() => undefined);
        }
      }
      if (releaseInstalled) await safeRemovePrivateTree(destination, paths.releases);
      await safeRemovePrivateTree(staging, paths.releases);
      if (rollbackFailure !== undefined) throw rollbackFailure;
      throw error;
    }
  }

  private async bootstrapWithRetry(): Promise<{ readonly code: number; readonly stdout: string }> {
    const delays = [0, 50, 200] as const;
    let result = { code: 1, stdout: "" };
    for (const delay of delays) {
      if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      result = await this.runner().run([
        "bootstrap",
        this.domain(),
        this.options.paths.launchAgent
      ]);
      if (result.code === 0) return result;
    }
    return result;
  }

  public async uninstall(confirmation: "UNINSTALL_AGENTLINK_LOCALLY"): Promise<void> {
    if (confirmation !== "UNINSTALL_AGENTLINK_LOCALLY") {
      throw new Error("Local uninstall confirmation is required");
    }
    await this.bootout().catch(() => undefined);
    await safeUnlink(this.options.paths.launchAgent);
    await safeUnlink(this.options.paths.socket);
  }

  public async purge(input: {
    readonly uninstallConfirmation: "UNINSTALL_AGENTLINK_LOCALLY";
    readonly destructiveConfirmation: "DELETE_AGENTLINK_DATA";
    readonly credentialReferences?: readonly string[];
    readonly deleteCredential?: (reference: string) => Promise<void>;
  }): Promise<void> {
    if (
      input.uninstallConfirmation !== "UNINSTALL_AGENTLINK_LOCALLY" ||
      input.destructiveConfirmation !== "DELETE_AGENTLINK_DATA"
    ) {
      throw new Error("A separate destructive local confirmation is required");
    }
    const references = [...new Set(input.credentialReferences ?? [])];
    if (references.length > 0 && input.deleteCredential === undefined) {
      throw new Error("Credential deletion callback is required for explicit Keychain references");
    }
    for (const reference of references) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(reference)) {
        throw new Error("Credential reference contains unsupported characters");
      }
    }
    await this.uninstall("UNINSTALL_AGENTLINK_LOCALLY");
    for (const reference of references) await input.deleteCredential?.(reference);
    for (const path of [
      this.options.paths.applicationSupport,
      this.options.paths.caches,
      this.options.paths.logs
    ]) {
      await safeRemoveManagedRoot(path);
    }
  }

  public async status(): Promise<ServiceStatus> {
    const installed = await optionalLstat(this.options.paths.launchAgent) !== undefined;
    if (!installed) return { installed: false, loaded: false, detail: "not_installed" };
    const result = await this.runner().run(["print", `${this.domain()}/${serviceLabel}`]);
    return {
      installed: true,
      loaded: result.code === 0,
      detail: result.code === 0 ? "loaded" : "installed_not_loaded"
    };
  }

  public async start(): Promise<ServiceStatus> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentLink LaunchAgent is not installed");
    if (!status.loaded) {
      const bootstrap = await this.bootstrapWithRetry();
      if (bootstrap.code !== 0) {
        throw new Error(`launchctl bootstrap failed (${bootstrap.code})`);
      }
    }
    const result = await this.runner().run([
      "kickstart",
      `${this.domain()}/${serviceLabel}`
    ]);
    if (result.code !== 0) throw new Error(`launchctl kickstart failed (${result.code})`);
    if (this.options.runner === undefined) {
      await waitForPrivateSocket(this.options.paths.socket, 45_000);
    }
    return this.status();
  }

  public async stop(): Promise<ServiceStatus> {
    const status = await this.status();
    if (!status.installed || !status.loaded) return status;
    await this.bootout();
    return this.status();
  }

  public async restart(): Promise<ServiceStatus> {
    const status = await this.status();
    if (!status.installed) throw new Error("AgentLink LaunchAgent is not installed");
    if (!status.loaded) return this.start();
    const result = await this.runner().run([
      "kickstart",
      "-k",
      `${this.domain()}/${serviceLabel}`
    ]);
    if (result.code !== 0) throw new Error(`launchctl restart failed (${result.code})`);
    if (this.options.runner === undefined) {
      await waitForPrivateSocket(this.options.paths.socket, 45_000);
    }
    return this.status();
  }

  private runner(): ServiceCommandRunner {
    return this.options.runner ?? new LaunchctlCommandRunner();
  }

  private domain(): string {
    return `gui/${this.options.uid ?? process.getuid?.() ?? (() => {
      throw new Error("Cannot determine local uid");
    })()}`;
  }

  private async bootout(): Promise<void> {
    const result = await this.runner().run(["bootout", `${this.domain()}/${serviceLabel}`]);
    if (result.code !== 0 && result.code !== 3 && result.code !== 113) {
      throw new Error(`launchctl bootout failed (${result.code})`);
    }
  }
}

export class LaunchctlCommandRunner implements ServiceCommandRunner {
  public async run(args: readonly string[]): Promise<{ code: number; stdout: string }> {
    try {
      const result = await execFileAsync("/bin/launchctl", [...args], {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: process.env["HOME"] ?? "",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
        }
      });
      return { code: 0, stdout: result.stdout };
    } catch (error) {
      const value = error as NodeJS.ErrnoException & { code?: number; stdout?: string };
      return {
        code: typeof value.code === "number" ? value.code : 1,
        stdout: typeof value.stdout === "string" ? value.stdout : ""
      };
    }
  }
}

export function renderLaunchAgentPlist(input: {
  readonly nodePath: string;
  readonly entrypoint: string;
  readonly configPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly home: string;
}): string {
  const argumentsXml = [input.nodePath, input.entrypoint, "--config", input.configPath]
    .map((value) => `      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(input.home)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`;
}

async function privatizeTree(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) pending.push(path);
      else await chmod(path, (metadata.mode & 0o100) === 0 ? 0o600 : 0o700);
    }
  }
  await assertPrivateOwnedDirectory(root);
}

async function trustedNodePath(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error("Node executable is not a trusted executable file");
  }
  return canonical;
}

async function assertRuntimeVersion(path: string, expected: string): Promise<void> {
  try {
    const result = await execFileAsync(path, ["--version"], {
      timeout: 10_000,
      maxBuffer: 1024,
      env: {}
    });
    if (result.stdout.trim() !== `v${expected}`) {
      throw new Error("version mismatch");
    }
  } catch (error) {
    throw new Error(`Bundled Node runtime failed version validation (${expected})`, {
      cause: error
    });
  }
}

async function writePrivateAtomic(path: string, content: string | Buffer): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  try {
    await chmod(temporary, 0o600);
    const handle = await open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await safeUnlink(temporary);
    throw error;
  }
}

async function ensurePrivateLogFile(path: string): Promise<void> {
  const metadata = await optionalLstat(path);
  const uid = process.getuid?.();
  if (metadata === undefined) {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    return;
  }
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new Error("AgentLink log path is not a trusted owned regular file");
  }
  await chmod(path, 0o600);
}

async function readPrivateFileIfPresent(path: string): Promise<Buffer | undefined> {
  const metadata = await optionalLstat(path);
  if (metadata === undefined) return undefined;
  const uid = process.getuid?.();
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid) ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > 1024 * 1024
  ) {
    throw new Error("Existing LaunchAgent plist is not trusted");
  }
  return readFile(path);
}

async function safeRemovePrivateTree(path: string, expectedParent: string): Promise<void> {
  const metadata = await optionalLstat(path);
  if (metadata === undefined) return;
  if (metadata.isSymbolicLink() || dirname(resolve(path)) !== resolve(expectedParent)) {
    throw new Error(`Refusing to remove unsafe release path: ${basename(path)}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error("Refusing to remove release owned by another user");
  }
  await rm(path, { recursive: true });
}

async function safeRemoveManagedRoot(path: string): Promise<void> {
  const metadata = await optionalLstat(path);
  if (metadata === undefined) return;
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && metadata.uid !== uid)
  ) {
    throw new Error(`Refusing to remove unsafe managed directory: ${basename(path)}`);
  }
  await rm(path, { recursive: true });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForPrivateSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await optionalLstat(path);
    if (metadata !== undefined) {
      const uid = process.getuid?.();
      if (
        metadata.isSocket() &&
        !metadata.isSymbolicLink() &&
        (uid === undefined || metadata.uid === uid) &&
        (metadata.mode & 0o077) === 0
      ) {
        return;
      }
      throw new Error("Gateway readiness path is not a trusted private Unix Socket");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Gateway did not create its private Unix Socket before the readiness deadline");
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertSupportedNode(): void {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error("AgentLink service installation requires Node 22 or later");
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
