import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PairingPageStatus = "waiting" | "paired" | "expired" | "cancelled" | "failed";

export interface BrowserQrPresenterOptions {
  readonly render: (content: string, outputPath: string) => Promise<void>;
  readonly open?: (url: string) => Promise<void>;
  readonly onOpenFailure?: (url: string, error: Error) => void;
  readonly retainTerminalStatusMs?: number;
}

export class BrowserQrPresenter {
  #server: Server | undefined;
  #directory: string | undefined;
  #pathToken: string | undefined;
  #qrPath: string | undefined;
  #status: PairingPageStatus = "waiting";

  public constructor(private readonly options: BrowserQrPresenterOptions) {}

  public async show(content: string): Promise<string> {
    if (this.#server !== undefined) throw new Error("Pairing browser page is already active");
    this.#directory = await mkdtemp(join(tmpdir(), "agentlink-pair-"));
    await chmod(this.#directory, 0o700);
    this.#qrPath = join(this.#directory, "wechat-login.png");
    await this.options.render(content, this.#qrPath);
    await chmod(this.#qrPath, 0o600);
    this.#pathToken = randomBytes(24).toString("hex");
    this.#server = createServer((request, response) => {
      void this.respond(request.url ?? "", response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.#server?.once("error", reject);
        this.#server?.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      await this.close();
      throw error;
    }
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Pairing browser page did not receive a TCP port");
    }
    const url = `http://127.0.0.1:${address.port}/pair/${this.#pathToken}`;
    try {
      await (this.options.open ?? openDefaultBrowser)(url);
    } catch (error) {
      this.options.onOpenFailure?.(
        url,
        error instanceof Error ? error : new Error("Could not open pairing browser")
      );
    }
    return url;
  }

  public async finish(status: Exclude<PairingPageStatus, "waiting">): Promise<void> {
    this.#status = status;
    const delay = this.options.retainTerminalStatusMs ?? 750;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await this.close();
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
    const directory = this.#directory;
    this.#directory = undefined;
    this.#qrPath = undefined;
    this.#pathToken = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }

  private async respond(
    url: string,
    response: import("node:http").ServerResponse
  ): Promise<void> {
    const base = `/pair/${this.#pathToken ?? ""}`;
    const headers = {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    };
    try {
      if (url === base) {
        response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        response.end(pageHtml(base));
        return;
      }
      if (url === `${base}/client.js`) {
        response.writeHead(200, { ...headers, "Content-Type": "text/javascript; charset=utf-8" });
        response.end(clientScript(base));
        return;
      }
      if (url === `${base}/status`) {
        response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ status: this.#status }));
        return;
      }
      if (url === `${base}/qr.png` && this.#qrPath !== undefined) {
        response.writeHead(200, { ...headers, "Content-Type": "image/png" });
        response.end(await readFile(this.#qrPath));
        return;
      }
      response.writeHead(404, headers);
      response.end("Not found");
    } catch {
      response.writeHead(500, headers);
      response.end("Pairing page failed");
    }
  }
}

function pageHtml(base: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentLink 微信配对</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;background:#f5f5f7;color:#1d1d1f;display:grid;min-height:100vh;place-items:center}.card{background:#fff;border-radius:20px;padding:32px;text-align:center;box-shadow:0 12px 36px #0002;max-width:420px}img{width:280px;height:280px}p{color:#666}</style></head><body><main class="card"><h1>AgentLink 微信配对</h1><img src="${base}/qr.png" alt="微信登录二维码"><p id="status">请使用微信扫码确认</p></main><script src="${base}/client.js"></script></body></html>`;
}

function clientScript(base: string): string {
  return `const labels={waiting:'请使用微信扫码确认',paired:'配对成功，可以关闭此页面',expired:'二维码已过期，请重新运行配对命令',cancelled:'配对已取消',failed:'配对失败，请返回终端查看'};async function poll(){try{const r=await fetch('${base}/status',{cache:'no-store'});const s=(await r.json()).status;document.getElementById('status').textContent=labels[s]||labels.failed;if(s==='waiting')setTimeout(poll,500)}catch{document.getElementById('status').textContent='本地配对服务已关闭'}}poll();`;
}

function openDefaultBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin" }
    });
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic = `${diagnostic}${String(chunk)}`.slice(0, 512);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === null && code === 0) resolve();
      else reject(new Error(
        `Could not open the pairing browser: code=${String(code)} signal=${String(signal)} ${diagnostic}`
      ));
    });
  });
}
