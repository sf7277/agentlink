import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { CredentialStore } from "../core/contracts/ports.js";
import {
  gatewayConfigSchema,
  type GatewayConfig
} from "../composition/config-schema.js";
import type { QrLoginResult } from "../channel-wechat/adapter/qr-login.js";
import { AtomicConfigStore, type ConfigDocumentStore } from "./atomic-config-store.js";
import { assertTrustedIlinkBaseUrl } from "../channel-wechat/protocol/url-policy.js";

export interface WechatQrLogin {
  login(input: {
    readonly credentialReference: string;
    readonly display: (qrUrl: string) => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<QrLoginResult>;
}

export class WechatPairingService {
  public constructor(
    private readonly configPath: string,
    private readonly login: WechatQrLogin,
    private readonly credentials: CredentialStore,
    private readonly store: ConfigDocumentStore = new AtomicConfigStore(configPath)
  ) {}

  public async pair(input: {
    readonly baseUrl: string;
    readonly credentialReference: string;
    readonly gatewayUserId: string;
    readonly display: (qrUrl: string) => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly accountId: string; readonly controllerId: string }> {
    const suffix = `.pending.${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const temporaryReference =
      `${input.credentialReference.slice(0, 128 - suffix.length)}${suffix}`;
    const previous = await this.credentials.get(input.credentialReference);
    try {
      const result = await this.login.login({
        credentialReference: temporaryReference,
        display: input.display,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      if (result.userId === undefined || result.userId.trim() === "") {
        throw new Error("Confirmed iLink login omitted the controller user ID");
      }
      const token = await this.credentials.get(temporaryReference);
      if (token === undefined) throw new Error("Confirmed iLink login did not persist its token");
      const config = await this.load();
      await this.credentials.put(input.credentialReference, token);
      try {
        await this.store.save({
          ...config,
          wechat: {
            accountId: result.accountId,
            baseUrl: assertTrustedIlinkBaseUrl(result.baseUrl ?? input.baseUrl),
            credentialReference: input.credentialReference,
            controllers: [{
              senderId: result.userId,
              gatewayUserId: input.gatewayUserId
            }]
          }
        });
      } catch (error) {
        if (previous === undefined) await this.credentials.delete(input.credentialReference);
        else await this.credentials.put(input.credentialReference, previous);
        throw error;
      }
      return { accountId: result.accountId, controllerId: result.userId };
    } finally {
      await this.credentials.delete(temporaryReference).catch(() => undefined);
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
