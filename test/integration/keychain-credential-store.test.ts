import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  KeychainCredentialStore
} from "../../src/platform-macos/keychain-credential-store.js";

test("macOS Keychain CredentialStore writes, replaces, reads and deletes", {
  skip: process.platform !== "darwin"
}, async () => {
  const store = new KeychainCredentialStore({
    service: "com.agentlink.integration-test"
  });
  const reference = `credential-${randomUUID()}`;
  const pendingReference = `${reference}.pending.test`;
  try {
    assert.equal(await store.get(reference), undefined);
    await store.put(reference, "first-integration-secret");
    assert.equal(await store.get(reference), "first-integration-secret");
    await store.put(reference, "replacement-integration-secret");
    assert.equal(await store.get(reference), "replacement-integration-secret");
    await store.put(pendingReference, "temporary-integration-secret");
    assert.equal((await store.listReferences()).includes(pendingReference), true);
    assert.equal(await store.cleanupPendingReferences(), 1);
    assert.equal(await store.get(pendingReference), undefined);
  } finally {
    await store.delete(reference);
    await store.delete(pendingReference);
  }
  assert.equal(await store.get(reference), undefined);
});
