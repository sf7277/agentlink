export class BoundedTail {
  #value = "";

  public constructor(private readonly maxBytes: number) {}

  public append(chunk: string): void {
    this.#value += chunk;
    const bytes = Buffer.byteLength(this.#value, "utf8");
    if (bytes <= this.maxBytes) return;
    const buffer = Buffer.from(this.#value, "utf8");
    this.#value = buffer.subarray(buffer.length - this.maxBytes).toString("utf8");
  }

  public read(): string {
    return this.#value;
  }

  public capacity(): number {
    return this.maxBytes;
  }
}
