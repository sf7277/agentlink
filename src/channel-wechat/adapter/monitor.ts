import type { ChannelMessage } from "../../core/contracts/ports.js";
import { IlinkHttpClient } from "../protocol/http-client.js";
import { IlinkError } from "../protocol/errors.js";
import type { WeixinMessage } from "../protocol/schemas.js";

export type IlinkDisposition = "deliver" | "unauthorized" | "attachment_unsupported";
export type IlinkChannelStatus =
  | "connected"
  | "backing_off"
  | "rate_limited"
  | "authentication_required"
  | "incompatible"
  | "stopped";

export interface IlinkInbound {
  readonly message: ChannelMessage;
  readonly contextToken: string;
  readonly disposition: IlinkDisposition;
}

export interface IlinkBatchAcceptor {
  accept(input: {
    readonly accountId: string;
    readonly previousCursor: string;
    readonly nextCursor: string;
    readonly messages: readonly IlinkInbound[];
  }): Promise<void>;
}

export class IlinkMonitor {
  #cursor: string;
  #nextTimeoutMs = 45_000;

  public constructor(
    private readonly client: IlinkHttpClient,
    private readonly accountId: string,
    private readonly allowedSenders: ReadonlySet<string>,
    private readonly acceptor: IlinkBatchAcceptor,
    initialCursor = ""
  ) {
    this.#cursor = initialCursor;
  }

  public async pollOnce(signal?: AbortSignal): Promise<number> {
    const response = await this.client.getUpdates(this.#cursor, this.#nextTimeoutMs, signal);
    const nextCursor = response.get_updates_buf ?? this.#cursor;
    const messages = response.msgs
      .filter((message) => message.message_type === 1)
      .map((message) => this.normalize(message));
    await this.acceptor.accept({
      accountId: this.accountId,
      previousCursor: this.#cursor,
      nextCursor,
      messages
    });
    this.#cursor = nextCursor;
    this.#nextTimeoutMs = Math.max(
      5_000,
      Math.min(120_000, (response.longpolling_timeout_ms ?? 35_000) + 10_000)
    );
    return messages.length;
  }

  public async run(input: {
    readonly signal: AbortSignal;
    readonly onStatus?: (
      status: IlinkChannelStatus,
      error?: IlinkError
    ) => void;
    readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    readonly retryDelaysMs?: readonly number[];
  }): Promise<void> {
    const delays = input.retryDelaysMs ?? [500, 1_000, 2_000, 5_000, 10_000];
    let failures = 0;
    while (!input.signal.aborted) {
      try {
        await this.pollOnce(input.signal);
        failures = 0;
        input.onStatus?.("connected");
      } catch (error) {
        if (input.signal.aborted) return;
        const classified = error;
        if (!(classified instanceof IlinkError) || !classified.retryable) {
          const status = classified instanceof IlinkError
            ? classified.kind === "authentication"
              ? "authentication_required"
              : classified.kind === "incompatible"
                ? "incompatible"
                : "stopped"
            : "stopped";
          input.onStatus?.(status, classified instanceof IlinkError ? classified : undefined);
          throw classified;
        }
        const delay = delays[Math.min(failures, delays.length - 1)] ?? 10_000;
        failures += 1;
        input.onStatus?.(classified.kind === "rate_limit" ? "rate_limited" : "backing_off", classified);
        await (input.sleep ?? abortableSleep)(delay, input.signal);
      }
    }
  }

  public cursor(): string {
    return this.#cursor;
  }

  private normalize(message: WeixinMessage): IlinkInbound {
    const attachments = message.item_list.filter((item) => item.type !== 1);
    const text = message.item_list
      .filter((item) => item.type === 1)
      .map((item) => item.text_item?.text ?? "")
      .join("\n")
      .trim();
    const disposition = !this.allowedSenders.has(message.from_user_id)
      ? "unauthorized"
      : attachments.length > 0
        ? "attachment_unsupported"
        : "deliver";
    const conversationId =
      message.session_id === "" ? `direct:${message.from_user_id}` : message.session_id;
    return {
      message: {
        eventId: `${this.accountId}:${message.message_id}`,
        accountId: this.accountId,
        senderId: message.from_user_id,
        conversationId,
        messageId: message.message_id,
        ...(text === "" ? {} : { text }),
        receivedAt: new Date(message.create_time_ms).toISOString()
      },
      contextToken: message.context_token,
      disposition
    };
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
