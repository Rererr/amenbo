import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startFixtureServer } from "./helpers/fixtureServer.js";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * CLIの fetch は、別のプロセス(MCPサーバーや前回のCLI)が同じURLを取って失効したキャッシュがあっても、
 * 差分応答を出さずに本文を出す。CLIの各プロセスは前回の本文を見ていないため。
 * run()は最後にキャッシュを閉じる(1コマンド1プロセスの前提)ので、先の取得はハンドラを直接呼んで作る。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-cli-diff-"));
process.env.AMENBO_CACHE_DIR = cacheDir;
process.env.AMENBO_CACHE_TTL_MS = "1";

const { handleFetchTool, politeness, cache } = await import("../src/core.js");
const { run } = await import("../src/cli.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");

setAddressPolicyForTests(() => false);
const server = await startFixtureServer();

afterAll(async () => {
  setAddressPolicyForTests(null);
  await server.close();
  cleanupCacheDir(cacheDir, () => cache.close());
  delete process.env.AMENBO_CACHE_TTL_MS;
});

const FILLER =
  "この段落は本文抽出の対象として扱われる程度の分量を持たせるための文です。短すぎる本文は品質が低いと判定され、" +
  "描画を伴う取得へ切り替わるため、同じ程度の長さの説明を複数置いています。";

describe("CLI fetch と差分応答", () => {
  it("失効したキャッシュと内容が同じでも、unchangedではなく本文を出す", async () => {
    vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
    vi.spyOn(politeness, "waitTurn").mockResolvedValue(undefined);
    const url = `${server.origin}/v/cli`;
    server.pages.set(
      "/v/cli",
      `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>CLIで落とすページ</title></head>
<body><article><h1>CLIで落とすページ</h1><p>CLI-BODY ${FILLER}</p><h2>続き</h2><p>${FILLER}</p><p>${FILLER}</p></article></body></html>`,
    );
    await handleFetchTool({ url });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stdout: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    const exitCode = await run(["fetch", url]);
    writeSpy.mockRestore();

    expect(exitCode).toBe(0);
    const output = stdout.join("");
    expect(output).toContain("CLI-BODY");
    expect(output).not.toContain("cache: unchanged");
  }, 30_000);
});
