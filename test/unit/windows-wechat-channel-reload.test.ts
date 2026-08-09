import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldReloadWechatChannel } from "../../src/platform-windows/wechat-channel-reload.js";

test("Windows reloads a newly configured or authentication-required WeChat channel", () => {
  assert.equal(shouldReloadWechatChannel({
    stopping: false,
    applicationReady: true,
    channelPresent: false,
    channelStatus: "DISABLED",
    reloadInProgress: false
  }), true);
  assert.equal(shouldReloadWechatChannel({
    stopping: false,
    applicationReady: true,
    channelPresent: true,
    channelStatus: "AUTHENTICATION_REQUIRED",
    reloadInProgress: false
  }), true);
});

test("Windows preserves a healthy channel and serializes reload attempts", () => {
  assert.equal(shouldReloadWechatChannel({
    stopping: false,
    applicationReady: true,
    channelPresent: true,
    channelStatus: "HEALTHY",
    reloadInProgress: false
  }), false);
  assert.equal(shouldReloadWechatChannel({
    stopping: false,
    applicationReady: true,
    channelPresent: true,
    channelStatus: "AUTHENTICATION_REQUIRED",
    reloadInProgress: true
  }), false);
  assert.equal(shouldReloadWechatChannel({
    stopping: true,
    applicationReady: true,
    channelPresent: true,
    channelStatus: "AUTHENTICATION_REQUIRED",
    reloadInProgress: false
  }), false);
});
