import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  unlink
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  gatewayConfigSchema,
  type GatewayConfig,
  type GatewayConfigInput
} from "../composition/config-schema.js";
import { assertPrivateOwnedDirectory } from "./application-paths.js";

export interface ConfigDocumentStore {
  load(): Promise<GatewayConfig>;
  loadDocument(): Promise<unknown>;
  save(config: GatewayConfigInput): Promise<void>;
}

export class AtomicConfigStore implements ConfigDocumentStore {
  public constructor(
    private readonly path: string,
    private readonly maxBytes = 1024 * 1024
  ) {}

  public async load(): Promise<GatewayConfig> {
    return gatewayConfigSchema.parse(await this.loadDocument());
  }

  public async loadDocument(): Promise<unknown> {
    const metadata = await lstat(this.path);
    const uid = process.getuid?.();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (uid !== undefined && metadata.uid !== uid) ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > this.maxBytes
    ) {
      throw new Error("AgentLink config file is not a trusted private regular file");
    }
    const bytes = await readFile(this.path);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("AgentLink config is not valid UTF-8");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new Error("AgentLink config is not valid JSON");
    }
    return value;
  }

  public async save(config: GatewayConfigInput): Promise<void> {
    const validated = gatewayConfigSchema.parse(config);
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.maxBytes) {
      throw new Error("AgentLink config exceeds size limit");
    }
    const parent = dirname(this.path);
    await assertPrivateOwnedDirectory(parent);
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await syncDirectory(parent);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export class ReloadableConfig {
  #current: GatewayConfig | undefined;

  public constructor(private readonly store: ConfigDocumentStore) {}

  public current(): GatewayConfig | undefined {
    return this.#current;
  }

  public async initialize(): Promise<GatewayConfig> {
    const config = await this.store.load();
    this.#current = config;
    return config;
  }

  public async reload(): Promise<
    { readonly ok: true; readonly config: GatewayConfig } |
    { readonly ok: false; readonly error: Error; readonly config: GatewayConfig }
  > {
    if (this.#current === undefined) throw new Error("Config has not been initialized");
    try {
      const config = await this.store.load();
      this.#current = config;
      return { ok: true, config };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error("Config reload failed"),
        config: this.#current
      };
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
