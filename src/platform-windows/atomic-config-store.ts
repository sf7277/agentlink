import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
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
import { assertWindowsPrivatePath } from "./security.js";

/**
 * Windows counterpart of the macOS atomic config store.
 *
 * Windows ACL verification is intentionally kept at the platform boundary;
 * Unix UID/mode checks must not be reused here. The ACL/reparse-point
 * verification is completed by the Windows acceptance implementation.
 */
export class WindowsAtomicConfigStore {
  public constructor(
    private readonly path: string,
    private readonly maxBytes = 1024 * 1024
  ) {}

  public async load(): Promise<GatewayConfig> {
    return gatewayConfigSchema.parse(await this.loadDocument());
  }

  public async loadDocument(): Promise<unknown> {
    await assertWindowsPrivatePath(this.path, "file");
    const metadata = await lstat(this.path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > this.maxBytes
    ) {
      throw new Error("AgentLink config file is not a trusted private regular file");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(this.path));
    } catch (error) {
      if (error instanceof TypeError) throw new Error("AgentLink config is not valid UTF-8");
      throw error;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("AgentLink config is not valid JSON");
    }
  }

  public async save(config: GatewayConfigInput): Promise<void> {
    const validated = gatewayConfigSchema.parse(config);
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.maxBytes) {
      throw new Error("AgentLink config exceeds size limit");
    }
    const parent = dirname(this.path);
    const parentMetadata = await lstat(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new Error("AgentLink config parent is not a trusted directory");
    }
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await assertWindowsPrivatePath(temporary, "file");
      await rename(temporary, this.path);
      await assertWindowsPrivatePath(this.path, "file");
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
