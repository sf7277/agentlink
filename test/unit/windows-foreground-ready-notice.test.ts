import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WINDOWS_FOREGROUND_READY_NOTICE,
  writeWindowsForegroundReadyNotice
} from "../../src/platform-windows/foreground-ready-notice.js";

test("Windows foreground Gateway prints a keep-window-open notice", () => {
  let output = "";
  writeWindowsForegroundReadyNotice({
    write(chunk) {
      output += chunk;
    }
  });

  assert.equal(
    output,
    "AgentLink服务已启动，请保持本窗口开启状态，退出请按 Ctrl+C。\n"
  );
  assert.equal(output, WINDOWS_FOREGROUND_READY_NOTICE);
});
