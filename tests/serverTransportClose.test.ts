import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * クライアントが stdin を閉じたら(シグナルを送らないクライアント・親の異常終了)サーバーが終わること。
 * ブラウザと SSRF 検証プロキシが開いたままだとプロセスが終われず Chrome も残るため、runServer は
 * 接続が閉じたら closeBrowser を呼ぶ。2つの面から確かめる:
 *   - 実際の runServer を子プロセスで起動し、配線があること(無ければ終われない)
 *   - 同じプロセスで実際の serveStdio を通し、SDK が設定した接続の後始末(サーバーの close)を上書きしていないこと
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-transport-close-"));
process.env.AMENBO_CACHE_DIR = cacheDir;
const entry = fileURLToPath(new URL("./helpers/serveWithOpenProxy.ts", import.meta.url));

const { closeBrowserMock } = vi.hoisted(() => ({ closeBrowserMock: vi.fn(async () => {}) }));
vi.mock("../src/fetcher/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/browser.js")>();
  return { ...actual, closeBrowser: closeBrowserMock };
});

const { serveStdio, StdioServerTransport } = await import("@modelcontextprotocol/server/stdio");
const { closeBrowserWhenTransportCloses, createServer } = await import("../src/server.js");
const { cache } = await import("../src/core.js");

afterAll(() => {
  cleanupCacheDir(cacheDir, () => cache.close());
});

const INITIALIZE = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
})}\n`;

describe("runServer の終了処理", () => {
  it("stdin を閉じると、開いていた SSRF 検証プロキシを閉じて終了する", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      env: { ...process.env, AMENBO_CACHE_DIR: cacheDir },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      // 接続を開いて(サーバーのインスタンスを作らせて)から stdin を閉じる。
      const initialized = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
      child.stdin.write(INITIALIZE);
      await initialized;
      child.stdin.end();

      const result = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
      expect(result).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("closeBrowserWhenTransportCloses", () => {
  it("stdin の終わりでブラウザを閉じ、SDK の接続の後始末(サーバーの close)も行う", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    let serverClosed = false;
    serveStdio(
      (context) => {
        const server = createServer(context.era);
        const close = server.close.bind(server);
        server.close = async () => {
          serverClosed = true;
          await close();
        };
        return server;
      },
      { transport },
    );
    closeBrowserWhenTransportCloses(transport);

    const initialized = new Promise<void>((resolve) => stdout.once("data", () => resolve()));
    stdin.write(INITIALIZE);
    await initialized;
    stdin.end();

    await vi.waitFor(() => expect(closeBrowserMock).toHaveBeenCalledTimes(1));
    expect(serverClosed).toBe(true);
  });
});
