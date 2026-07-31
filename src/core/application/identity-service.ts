import { DomainError } from "../domain/errors.js";

export interface IdentityRecord {
  readonly accountId: string;
  readonly senderId: string;
  readonly gatewayUserId: string;
}

export class IdentityService {
  readonly #records = new Map<string, IdentityRecord>();

  public constructor(records: readonly IdentityRecord[]) {
    for (const record of records) {
      this.#records.set(`${record.accountId}\u0000${record.senderId}`, record);
    }
  }

  public authorize(accountId: string, senderId: string): IdentityRecord {
    const record = this.#records.get(`${accountId}\u0000${senderId}`);
    if (record === undefined) {
      throw new DomainError("identity_unauthorized", "Sender is not authorized");
    }
    return record;
  }
}
