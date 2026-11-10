import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * cache.sqliteがSQLiteとして読めないとき、server.tsを直接起動しても(READMEが載せる
 * `node dist/server.js`)スタックトレースではなく、ファイルの場所と対処を書いた文言だけを
 * 標準エラーへ出して、終了コード1で終わる。CLI経由は tests/cliUnreadableCache.test.ts が確かめる。
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverScript = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-server-unreadable-cache-"));
const dbPath = join(cacheDir, "cache.sqlite");
writeFileSync(dbPath, "これはSQLiteのデータベースではありません。".repeat(20));

afterAll(() => {
  cleanupCacheDir(cacheDir);
});

describe("MCPサーバーの直接起動 - 読めないキャッシュ", () => {
  it("場所と対処の文言だけを出し、終了コード1で終わる", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", serverScript], {
      cwd: repoRoot,
      env: { ...process.env, AMENBO_CACHE_DIR: cacheDir },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", resolve);
      // 直らずに起動できてしまった場合は、stdinを待ち続けるので閉じて終わらせる。
      child.stdin.end();
    });

    expect(code, stderr).toBe(1);
    expect(stderr).toContain(dbPath);
    expect(stderr).toContain("削除");
    expect(stderr).not.toMatch(/^\s+at /m);
  }, 30_000);
});
