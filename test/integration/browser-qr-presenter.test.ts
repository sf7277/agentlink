import assert from "node:assert/strict";
import { chmod, lstat, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { BrowserQrPresenter } from "../../src/platform-macos/browser-qr-presenter.js";

test("browser pairing serves a private random page and removes the QR afterward", async () => {
  let opened = "";
  let qrPath = "";
  const presenter = new BrowserQrPresenter({
    render: async (_content, outputPath) => {
      qrPath = outputPath;
      await writeFile(outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await chmod(outputPath, 0o644);
    },
    open: async (url) => { opened = url; },
    retainTerminalStatusMs: 0
  });
  const url = await presenter.show("secret-ticket");
  assert.equal(opened, url);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/pair\/[a-f0-9]{48}$/u);
  assert.equal((await lstat(qrPath)).mode & 0o777, 0o600);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await page.text(), /secret-ticket/u);
  assert.equal((await fetch(`${url}/status`).then((response) => response.json()) as { status: string }).status, "waiting");
  await presenter.finish("paired");
  await assert.rejects(lstat(qrPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});
