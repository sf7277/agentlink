export class WechatStatusAggregator {
  readonly #pending = new Map<string, string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();

  public constructor(
    private readonly send: (conversationId: string, text: string) => Promise<void>,
    private readonly delayMs = 2_000
  ) {}

  public update(conversationId: string, text: string): void {
    this.#pending.set(conversationId, text);
    if (this.#timers.has(conversationId)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(conversationId);
      const latest = this.#pending.get(conversationId);
      this.#pending.delete(conversationId);
      if (latest !== undefined) void this.send(conversationId, latest);
    }, this.delayMs);
    timer.unref();
    this.#timers.set(conversationId, timer);
  }

  public async flush(conversationId: string): Promise<void> {
    const timer = this.#timers.get(conversationId);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(conversationId);
    const latest = this.#pending.get(conversationId);
    this.#pending.delete(conversationId);
    if (latest !== undefined) await this.send(conversationId, latest);
  }

  public clear(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#pending.clear();
  }
}
