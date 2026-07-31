export type IlinkErrorKind =
  | "network"
  | "authentication"
  | "rate_limit"
  | "invalid_json"
  | "protocol"
  | "compatibility_signal"
  | "incompatible";

export class IlinkError extends Error {
  public constructor(
    public readonly kind: IlinkErrorKind,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly compatibilitySignature?: string
  ) {
    super(message);
    this.name = "IlinkError";
  }
}

export class IlinkCompatibilityThreshold {
  #lastSignature: string | undefined;
  #consecutive = 0;

  public constructor(private readonly threshold = 3) {
    if (!Number.isInteger(threshold) || threshold < 2 || threshold > 20) {
      throw new Error("iLink incompatibility threshold must be between 2 and 20");
    }
  }

  public observe(error: IlinkError): IlinkError {
    if (error.kind !== "invalid_json" && error.kind !== "compatibility_signal") {
      this.reset();
      return error;
    }
    const signature = error.compatibilitySignature ?? error.kind;
    this.#consecutive = signature === this.#lastSignature ? this.#consecutive + 1 : 1;
    this.#lastSignature = signature;
    if (this.#consecutive < this.threshold) return error;
    return new IlinkError(
      "incompatible",
      `iLink compatibility check failed ${this.#consecutive} consecutive times`,
      false,
      error.status,
      signature
    );
  }

  public reset(): void {
    this.#lastSignature = undefined;
    this.#consecutive = 0;
  }
}
