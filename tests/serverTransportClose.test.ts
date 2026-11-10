import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * クライアントが stdin を閉じたら(シグナルを送らないクライアント・親の異常終了)ブラウザを閉じる。
 * ブラウザと SSRF 検証プロキシが開いたままだと、プロセスが終われず Chrome も残る。
 * 実際の serveStdio と StdioServerTransport を通し、SDK が設定する後始末を上書きしていないことも見る。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-transport-close-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

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

describe("stdio の接続が閉じたとき", () => {
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

    // 接続を開いて(サーバーのインスタンスを作らせて)から、stdin を閉じる。
    const initialized = new Promise<void>((resolve) => stdout.once("data", () => resolve()));
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      })}\n`,
    );
    await initialized;
    stdin.end();
    await vi.waitFor(() => expect(closeBrowserMock).toHaveBeenCalledTimes(1));
    expect(serverClosed).toBe(true);
  });
});
