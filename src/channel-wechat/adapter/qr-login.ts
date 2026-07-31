import type { CredentialStore } from "../../core/contracts/ports.js";
import { IlinkHttpClient } from "../protocol/http-client.js";

export interface QrLoginResult {
  readonly accountId: string;
  readonly userId?: string;
  readonly baseUrl?: string;
}

export class IlinkQrLogin {
  public constructor(
    private readonly client: IlinkHttpClient,
    private readonly credentials: CredentialStore
  ) {}

  public async login(input: {
    readonly credentialReference: string;
    readonly display: (qrUrl: string) => Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<QrLoginResult> {
    const started = await this.client.startQrLogin();
    await input.display(started.qrcode_img_content);
    while (!input.signal?.aborted) {
      const status = await this.client.pollQrStatus(started.qrcode);
      if (status.status === "confirmed") {
        if (status.bot_token === undefined || status.ilink_bot_id === undefined) {
          throw new Error("Confirmed iLink login omitted credentials");
        }
        await this.credentials.put(input.credentialReference, status.bot_token);
        return {
          accountId: status.ilink_bot_id,
          ...(status.ilink_user_id === undefined ? {} : { userId: status.ilink_user_id }),
          ...(status.baseurl === undefined ? {} : { baseUrl: status.baseurl })
        };
      }
      if (status.status === "expired") throw new Error("iLink QR code expired");
      if (status.status === "need_verifycode" || status.status === "verify_code_blocked") {
        throw new Error("iLink login requires local verification code handling");
      }
      if (status.status === "binded_redirect") {
        throw new Error("iLink account is already bound; use existing local credentials");
      }
    }
    throw new Error("iLink QR login aborted");
  }
}
