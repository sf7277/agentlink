import { randomBytes } from "node:crypto";
import { isInteger, isSafeNumber, parse as parseLosslessJson } from "lossless-json";
import { IlinkCompatibilityThreshold, IlinkError } from "./errors.js";
import {
  getUpdatesResponseSchema,
  qrStartSchema,
  qrStatusSchema,
  sendMessageResponseSchema,
  type GetUpdatesResponse
} from "./schemas.js";
import { AGENTLINK_VERSION } from "../../version.js";

export const ILINK_ADAPTER_IDENTITY = Object.freeze({
  adapterVersion: AGENTLINK_VERSION,
  channelVersion: `agentlink/${AGENTLINK_VERSION}`,
  botAgent: `AgentLink/${AGENTLINK_VERSION}`,
  appId: "bot",
  appClientVersion: AGENTLINK_VERSION
});

export const ILINK_KNOWN_ERROR_CODES = Object.freeze({
  authentication: Object.freeze([-14])
});

export interface IlinkHttpClientOptions {
  readonly baseUrl: string;
  readonly token?: () => Promise<string | undefined>;
  readonly fetch?: typeof globalThis.fetch;
  readonly replyRetryDelaysMs?: readonly number[];
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly incompatibilityThreshold?: number;
}

export class IlinkHttpClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #compatibility = new Map<string, IlinkCompatibilityThreshold>();

  public constructor(private readonly options: IlinkHttpClientOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public getUpdates(cursor: string, timeoutMs = 45_000, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    return this.request("ilink/bot/getupdates", {
      method: "POST",
      body: {
        get_updates_buf: cursor,
        base_info: this.baseInfo()
      },
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      schema: getUpdatesResponseSchema
    });
  }

  public async sendText(input: {
    readonly toUserId: string;
    readonly contextToken: string;
    readonly clientId: string;
    readonly text: string;
  }): Promise<void> {
    const delays = this.options.replyRetryDelaysMs ?? [250, 1_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.request("ilink/bot/sendmessage", {
          method: "POST",
          body: {
            msg: {
              to_user_id: input.toUserId,
              client_id: input.clientId,
              context_token: input.contextToken,
              message_type: 2,
              message_state: 2,
              item_list: [{ type: 1, text_item: { text: input.text } }]
            },
            base_info: this.baseInfo()
          },
          timeoutMs: 15_000,
          schema: sendMessageResponseSchema
        });
        return;
      } catch (error) {
        const delay = delays[attempt];
        if (!(error instanceof IlinkError) || !error.retryable || delay === undefined) throw error;
        await (this.options.sleep ?? sleep)(delay);
      }
    }
  }

  public startQrLogin(localTokens: readonly string[] = []): Promise<{
    qrcode: string;
    qrcode_img_content: string;
  }> {
    return this.request("ilink/bot/get_bot_qrcode?bot_type=3", {
      method: "POST",
      body: { local_token_list: [...localTokens] },
      timeoutMs: 15_000,
      schema: qrStartSchema,
      authenticated: false
    });
  }

  public pollQrStatus(qrcode: string, verifyCode?: string): Promise<ReturnType<typeof qrStatusSchema.parse>> {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode !== undefined) query.set("verify_code", verifyCode);
    return this.request(`ilink/bot/get_qrcode_status?${query.toString()}`, {
      method: "GET",
      timeoutMs: 35_000,
      schema: qrStatusSchema,
      authenticated: false
    });
  }

  private async request<T>(endpoint: string, input: {
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly schema: { parse(value: unknown): T };
    readonly authenticated?: boolean;
  }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    timer.unref();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const token = input.authenticated === false ? undefined : await this.options.token?.();
      const encodedBody = input.body === undefined ? undefined : JSON.stringify(input.body);
      if (
        encodedBody !== undefined &&
        Buffer.byteLength(encodedBody, "utf8") > (this.options.maxRequestBytes ?? 256 * 1024)
      ) {
        throw new IlinkError("protocol", "iLink request exceeds size limit", false);
      }
      const response = await this.#fetch(new URL(endpoint, ensureSlash(this.options.baseUrl)), {
        method: input.method,
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": randomWechatUin(),
          "iLink-App-Id": ILINK_ADAPTER_IDENTITY.appId,
          "iLink-App-ClientVersion": ILINK_ADAPTER_IDENTITY.appClientVersion,
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` })
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400) {
        throw new IlinkError(
          "protocol",
          "iLink redirects are not accepted for credential-bearing requests",
          false,
          response.status
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new IlinkError("authentication", `iLink authentication failed (${response.status})`, false, response.status);
      }
      if (response.status === 429) {
        throw new IlinkError("rate_limit", "iLink rate limit exceeded", true, response.status);
      }
      if (response.status === 404 || response.status === 405 || response.status === 410) {
        throw new IlinkError(
          "compatibility_signal",
          `iLink endpoint is unavailable (${response.status})`,
          true,
          response.status,
          `endpoint:${endpoint}:${response.status}`
        );
      }
      if (!response.ok) {
        throw new IlinkError(
          "network",
          `iLink HTTP ${response.status}`,
          response.status >= 500 || response.status === 408,
          response.status
        );
      }
      const maxResponseBytes = this.options.maxResponseBytes ?? 2 * 1024 * 1024;
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        throw new IlinkError("protocol", "iLink response exceeds size limit", false);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxResponseBytes) {
        throw new IlinkError("protocol", "iLink response exceeds size limit", false);
      }
      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        value = parseLosslessJson(text, undefined, {
          parseNumber: (raw) =>
            isInteger(raw) && !isSafeNumber(raw) ? raw : Number(raw)
        });
      } catch {
        throw new IlinkError(
          "invalid_json",
          "iLink returned invalid JSON",
          true,
          response.status,
          `json:${endpoint}`
        );
      }
      let parsed: T;
      try {
        parsed = input.schema.parse(value);
      } catch {
        throw new IlinkError(
          "compatibility_signal",
          "iLink response is missing required protocol fields",
          true,
          response.status,
          `schema:${endpoint}`
        );
      }
      this.assertApiSuccess(parsed);
      this.compatibilityThreshold(endpoint).reset();
      return parsed;
    } catch (error) {
      if (error instanceof IlinkError) {
        throw this.compatibilityThreshold(endpoint).observe(error);
      }
      const networkError = controller.signal.aborted
        ? new IlinkError("network", "iLink request timed out or was aborted", true)
        : new IlinkError(
            "network",
            error instanceof Error ? error.message : "iLink network error",
            true
          );
      throw this.compatibilityThreshold(endpoint).observe(networkError);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  private assertApiSuccess(value: unknown): void {
    const response = value as { ret?: number; errcode?: number; errmsg?: string };
    if (
      response.errcode !== undefined &&
      ILINK_KNOWN_ERROR_CODES.authentication.includes(response.errcode)
    ) {
      throw new IlinkError("authentication", "iLink token expired", false);
    }
    if (response.ret !== undefined && response.ret !== 0) {
      const code = response.errcode ?? response.ret;
      throw new IlinkError(
        "compatibility_signal",
        `iLink returned an unknown protocol error (${code})`,
        true,
        undefined,
        `api-code:${code}`
      );
    }
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return {
      channel_version: ILINK_ADAPTER_IDENTITY.channelVersion,
      bot_agent: ILINK_ADAPTER_IDENTITY.botAgent
    };
  }

  private compatibilityThreshold(endpoint: string): IlinkCompatibilityThreshold {
    const existing = this.#compatibility.get(endpoint);
    if (existing !== undefined) return existing;
    const created = new IlinkCompatibilityThreshold(this.options.incompatibilityThreshold ?? 3);
    this.#compatibility.set(endpoint, created);
    return created;
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}
