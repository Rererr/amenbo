import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * MCP progress notifications: PDF経路(handlePdfFetch)は、キャッシュmiss時に
 * テキスト抽出(extractPdfText)の直前でのみonProgressを呼ぶ(fresh cache時は呼ばない)。
 * 実ネットワークを避けるため、httpGetBinaryをモックしfixtureのPDFバイト列を返す
 * (politenessGuardCount.test.tsと同様、politeness.guardはspyOnでモックする)。
 */

const httpGetBinaryMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGetBinary: (...args: Parameters<typeof actual.httpGetBinary>) => httpGetBinaryMock(...args),
  };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-pdf-progress-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { cache, handleFetchTool, politeness } = await import("../src/core.js");

afterAll(() => {
  // Windows CI対応: 開いたままのSQLiteファイルハンドルを解放してから削除する
  // (詳細はtests/helpers/tempCache.tsのコメント参照)。
  cleanupCacheDir(cacheDir, () => cache.close());
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

describe("handlePdfFetch - onProgress(MCP progress notifications)", () => {
  let guardSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    guardSpy = vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
    httpGetBinaryMock.mockReset();
  });

  afterEach(() => {
    guardSpy.mockRestore();
  });

  it("キャッシュmiss時、テキスト抽出前にPDF解析の進捗通知が送られる", async () => {
    httpGetBinaryMock.mockResolvedValue({
      finalUrl: "https://example.com/report.pdf",
      status: 200,
      headers: new Headers(),
      bytes: fixture("sample-text.pdf"),
      contentType: "application/pdf",
    });

    const onProgress = vi.fn();
    const content = await handleFetchTool({ url: "https://example.com/report.pdf", onProgress });

    expect(onProgress).toHaveBeenCalledWith("PDFを解析しています…");
    expect(content[0]).toMatchObject({ type: "text" });
  });

  it("onProgress未指定でも後方互換で動作する", async () => {
    httpGetBinaryMock.mockResolvedValue({
      finalUrl: "https://example.com/report2.pdf",
      status: 200,
      headers: new Headers(),
      bytes: fixture("sample-text.pdf"),
      contentType: "application/pdf",
    });

    await expect(handleFetchTool({ url: "https://example.com/report2.pdf" })).resolves.toBeDefined();
  });
});
