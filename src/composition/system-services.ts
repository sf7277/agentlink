import { randomBytes, randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../core/contracts/ports.js";

export class SystemClock implements Clock {
  public now(): string {
    return new Date().toISOString();
  }
}

export class RandomIdGenerator implements IdGenerator {
  public next(prefix: string): string {
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(prefix)) {
      throw new Error("ID prefix is invalid");
    }
    if (prefix === "approval-short") {
      return `P-${randomBytes(6).toString("hex").toUpperCase()}`;
    }
    return `${prefix}-${randomUUID()}`;
  }
}
