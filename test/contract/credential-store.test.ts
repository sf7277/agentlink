import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialStore } from "../../src/core/contracts/ports.js";
import { FakeCredentialStore } from "../fakes/core-fakes.js";

function credentialContract(name: string, create: () => CredentialStore): void {
  test(`${name}: put, replace, get and delete`, async () => {
    const store = create();
    assert.equal(await store.get("wechat-owner"), undefined);
    await store.put("wechat-owner", "test-placeholder");
    assert.equal(await store.get("wechat-owner"), "test-placeholder");
    await store.put("wechat-owner", "replacement-placeholder");
    assert.equal(await store.get("wechat-owner"), "replacement-placeholder");
    await store.delete("wechat-owner");
    assert.equal(await store.get("wechat-owner"), undefined);
  });
}

credentialContract("FakeCredentialStore", () => new FakeCredentialStore());
