import assert from "node:assert/strict";
import { test } from "node:test";
import { Sha256DigestService } from "../../src/core/application/sha256-digest-service.js";

test("SHA-256 digest length-prefixes parts and is deterministic", () => {
  const service = new Sha256DigestService();
  assert.equal(service.digest(["action", "value"]), service.digest(["action", "value"]));
  assert.notEqual(service.digest(["ab", "c"]), service.digest(["a", "bc"]));
  assert.match(service.digest(["action"]), /^sha256:[a-f0-9]{64}$/u);
});
