import type {
  ChannelMessage,
  ChannelOutput,
  ChannelPort,
  IdGenerator
} from "../../core/contracts/ports.js";
import { WechatTextRenderer } from "../rendering/text-renderer.js";
import type { IlinkError } from "../protocol/errors.js";
import { IlinkHttpClient } from "../protocol/http-client.js";
import {
  IlinkMonitor,
  type IlinkChannelStatus,
  type IlinkInbound
} from "./monitor.js";

export interface IlinkChannelAdapterOptions {
  readonly accountId: string;
  readonly allowedSenders: ReadonlySet<string>;
  readonly initialCursor?: string;
  readonly onRejected?: (input: IlinkInbound) => Promise<void>;
  readonly onStatus?: (
    status: IlinkChannelStatus,
    error?: IlinkError
  ) => void;
  readonly onFatal?: (error: Error) => void;
  readonly onCursorAccepted?: (cursor: string) => Promise<void> | void;
}

interface ReplyRoute {
  readonly toUserId: string;
  readonly contextToken: string;
}

export class IlinkChannelAdapter implements ChannelPort {
  readonly #routes = new Map<string, ReplyRoute>();
  readonly #renderer: WechatTextRenderer;
  #controller: AbortController | undefined;
  #run: Promise<void> | undefined;

  public constructor(
    private readonly client: IlinkHttpClient,
    private readonly ids: IdGenerator,
    private readonly options: IlinkChannelAdapterOptions,
    renderer = new WechatTextRenderer()
  ) {
    this.#renderer = renderer;
  }

  public async start(onMessage: (message: ChannelMessage) => Promise<void>): Promise<void> {
    if (this.#controller !== undefined) throw new Error("iLink Channel is already started");
    const controller = new AbortController();
    this.#controller = controller;
    const monitor = new IlinkMonitor(
      this.client,
      this.options.accountId,
      this.options.allowedSenders,
      {
        accept: async (batch) => {
          for (const input of batch.messages) {
            if (input.disposition !== "deliver") {
              await this.options.onRejected?.(input);
              continue;
            }
            this.#routes.set(input.message.conversationId, {
              toUserId: input.message.senderId,
              contextToken: input.contextToken
            });
            // Core's callback owns receipt + Turn transaction. Cursor advances
            // only after every callback in this batch returns successfully.
            await onMessage(input.message);
          }
          await this.options.onCursorAccepted?.(batch.nextCursor);
        }
      },
      this.options.initialCursor
    );
    this.#run = monitor.run({
      signal: controller.signal,
      ...(this.options.onStatus === undefined ? {} : { onStatus: this.options.onStatus })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        this.options.onFatal?.(
          error instanceof Error ? error : new Error("iLink monitor stopped")
        );
      }
    });
  }

  public async stop(): Promise<void> {
    const controller = this.#controller;
    if (controller === undefined) return;
    controller.abort(new Error("iLink Channel stopped"));
    await this.#run;
    this.#controller = undefined;
    this.#run = undefined;
    this.#routes.clear();
  }

  public async send(output: ChannelOutput): Promise<void> {
    const route = this.#routes.get(output.conversationId);
    if (route === undefined) throw new Error("No iLink reply route for Conversation");
    const chunks = this.#renderer.chunks(output.text);
    for (const [index, text] of chunks.entries()) {
      await this.client.sendText({
        toUserId: route.toUserId,
        contextToken: route.contextToken,
        clientId: this.ids.next(`wechat-reply-${index + 1}`),
        text
      });
    }
  }

  public async notifyDisconnect(text: string): Promise<{ attempted: number; delivered: number }> {
    const routes = [...new Map(
      [...this.#routes.values()].map((route) => [`${route.toUserId}:${route.contextToken}`, route])
    ).values()];
    let delivered = 0;
    for (const [index, route] of routes.entries()) {
      try {
        await this.client.sendText({
          toUserId: route.toUserId,
          contextToken: route.contextToken,
          clientId: this.ids.next(`wechat-disconnect-${index + 1}`),
          text
        });
        delivered += 1;
      } catch {
        // Disconnect must continue even when the final mobile notice cannot be delivered.
      }
    }
    return { attempted: routes.length, delivered };
  }
}
