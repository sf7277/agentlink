import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTrustedIlinkBaseUrl } from "../../src/channel-wechat/protocol/url-policy.js";

test("iLink endpoints require the exact trusted HTTPS origin", () => {
  assert.equal(
    assertTrustedIlinkBaseUrl("https://ilinkai.weixin.qq.com/api/"),
    "https://ilinkai.weixin.qq.com/api/"
  );
  for (const value of [
    "http://ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com.evil.example",
    "https://user@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com:444"
  ]) assert.throws(() => assertTrustedIlinkBaseUrl(value), /approved HTTPS origin/u);
});
