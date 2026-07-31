import { createHash } from "node:crypto";
import type { DigestService } from "../contracts/ports.js";

export class Sha256DigestService implements DigestService {
  public digest(parts: readonly string[]): string {
    const hash = createHash("sha256");
    for (const part of parts) {
      const bytes = Buffer.from(part, "utf8");
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(bytes.byteLength);
      hash.update(length);
      hash.update(bytes);
    }
    return `sha256:${hash.digest("hex")}`;
  }
}
