import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * cache.sqliteがSQLiteとして読めないとき、CLIはスタックトレースではなく、ファイルの場所と対処を書いた
 * 文言だけを標準エラーへ出して、0でない終了コードで終わる。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-cli-unreadable-cache-"));
const dbPath = join(cacheDir, "cache.sqlite");
writeFileSync(dbPath, "これはSQLiteのデータベースではありません。".repeat(20));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { run } = await import("../src/cli.js");

afterAll(() => {
  cleanupCacheDir(cacheDir);
});

describe("CLI - 読めないキャッシュ", () => {
  it("場所と対処の文言だけを出し、終了コード1で終わる", async () => {
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const exitCode = await run(["fetch", "https://example.com/"]);

      expect(exitCode).toBe(1);
      const output = stderr.join("");
      expect(output).toContain(dbPath);
      expect(output).toContain("削除");
      expect(output).not.toMatch(/^\s+at /m);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
