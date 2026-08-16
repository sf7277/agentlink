import { lstat } from "node:fs/promises";
import type { CredentialStore } from "../core/contracts/ports.js";
import {
  gatewayConfigSchema,
  type GatewayConfig
} from "../composition/config-schema.js";
import { AtomicConfigStore, type ConfigDocumentStore } from "./atomic-config-store.js";

export class WechatDisconnectService {
  public constructor(
    private readonly configPath: string,
    private readonly credentials: CredentialStore,
    private readonly store: ConfigDocumentStore = new AtomicConfigStore(configPath)
  ) {}

  public async disconnect(): Promise<{
    readonly status: "disconnected" | "already_disconnected";
    readonly credentialReference?: string;
    readonly credentialDeleted: boolean;
  }> {
    const config = await this.load();
    const wechat = config.wechat;
    if (wechat === undefined) {
      return { status: "already_disconnected", credentialDeleted: true };
    }
    const { wechat: _wechat, ...withoutWechat } = config;
    await this.store.save(withoutWechat);
    try {
      await this.credentials.delete(wechat.credentialReference);
      return {
        status: "disconnected",
        credentialReference: wechat.credentialReference,
        credentialDeleted: true
      };
    } catch {
      return {
        status: "disconnected",
        credentialReference: wechat.credentialReference,
        credentialDeleted: false
      };
    }
  }

  private async load(): Promise<GatewayConfig> {
    const exists = await lstat(this.configPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    );
    return exists ? this.store.load() : gatewayConfigSchema.parse({});
  }
}
