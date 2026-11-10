import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * CLI の例外取得の確認の後の取り直しも、同じ1回の呼び出しとして扱うこと(待ちの上限を最初の要求にだけ当てる)。
 * 確認(端末での答え)は「許可して取り直した」ことにする差し替えで模し、取り直しの中で転送元へ2回目の要求を出す。
 */
const handleFetchToolMock = vi.fn();
const httpGetMock = vi.fn();
let actualCache: { close: () => void } | null = null;

vi.mock("../src/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core.js")>();
  actualCache = actual.cache;
  return { ...actual, handleFetchTool: (...args: Parameters<typeof actual.handleFetchTool>) => handleFetchToolMock(...args) };
});

vi.mock("../src/terminalRobotsConsent.js", () => ({
  // 1回目が拒否で終わったら、利用者が許可したものとしてもう一度実行する
  runWithTerminalRobotsConsent: async <T>(_askOverride: boolean, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch {
      return run();
    }
  },
}));

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args) };
});

vi.mock("../src/fetcher/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/browser.js")>();
  return { ...actual, closeBrowser: async () => {} };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-cli-consent-scope-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { run } = await import("../src/cli.js");
const { PolitenessManager } = await import("../src/politeness.js");
const { RobotsDeniedError } = await import("../src/errors.js");

afterAll(() => {
  cleanupCacheDir(cacheDir, () => actualCache?.close());
});

describe("CLI - 例外取得の確認の後の取り直し", () => {
  it("転送元への2回目の要求は呼び出しの途中の待ちとして待ち、60秒の上限で断らない", async () => {
    httpGetMock.mockResolvedValue({ finalUrl: "http://example.com/robots.txt", status: 200, headers: new Headers(), html: "User-agent: *\nCrawl-delay: 90\n", encoding: "UTF-8" });
    let now = 1_000_000;
    const politeness = new PolitenessManager({ now: () => now, sleep: async (ms) => void (now += ms) });
    await politeness.getSitemaps("http://example.com/a"); // robots.txt を先に取得し、間隔が空いた状態にする
    now += 100_000;
    let attempts = 0;
    handleFetchToolMock.mockImplementation(async () => {
      attempts += 1;
      await politeness.guard("http://example.com/a");
      if (attempts === 1) throw new RobotsDeniedError("http://example.com/private/b"); // 転送先が拒否された
      return [{ type: "text" as const, text: "fetched" }];
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await run(["fetch", "http://example.com/a", "--ask-robots-override"]);

    stdout.mockRestore();
    stderr.mockRestore();
    expect(attempts).toBe(2);
    expect(code).toBe(0);
  });
});
