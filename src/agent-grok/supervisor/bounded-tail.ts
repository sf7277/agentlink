export class BoundedTail {
  #buffer = Buffer.alloc(0);

  public constructor(private readonly maxBytes: number) {}

  public capacity(): number {
    return this.maxBytes;
  }

  public append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.#buffer = Buffer.concat([this.#buffer, next]);
    if (this.#buffer.length > this.maxBytes) {
      this.#buffer = this.#buffer.subarray(this.#buffer.length - this.maxBytes);
    }
  }

  public read(): string {
    return this.#buffer.toString("utf8");
  }
}
