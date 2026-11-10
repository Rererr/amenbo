import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * クライアントが stdin を閉じたら(シグナルを送らないクライアント・親の異常終了)サーバーが終わること。
 * ブラウザと SSRF 検証プロキシが開いたままだとプロセスが終われず Chrome も残るため、runServer は
 * 接続が閉じたら closeBrowser を呼ぶ。実際の runServer を子プロセスで起動し、その配線を確かめる。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-transport-close-"));
const entry = fileURLToPath(new URL("./helpers/serveWithOpenProxy.ts", import.meta.url));

afterAll(() => {
  cleanupCacheDir(cacheDir);
});

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
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        })}\n`,
      );
      await initialized;
      child.stdin.end();

      const result = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000))]);
      expect(result).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
