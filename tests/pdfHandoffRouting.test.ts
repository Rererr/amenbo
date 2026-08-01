import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * レビュー指摘対応: URL拡張子で判定できないPDF(content-typeのみで判明するケース。
 * 官公庁の`/download?id=123`型ダウンロードエンドポイント等で頻出)は、resolvePageの
 * handoff分岐からhandlePdfFetchへルーティングされ、行き止まりのハンドオフ応答ではなく
 * PDFテキスト/画像応答になることを検証する。実ネットワークを避けるため、
 * resolvePage経由のhttpGetRoutedと、handlePdfFetch経由のhttpGetBinaryをそれぞれモックする
 * (pdfFetchProgress.test.tsと同様の流儀)。
 */

const httpGetRoutedMock = vi.fn();
const httpGetBinaryMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGetRouted: (...args: Parameters<typeof actual.httpGetRouted>) => httpGetRoutedMock(...args),
    httpGetBinary: (...args: Parameters<typeof actual.httpGetBinary>) => httpGetBinaryMock(...args),
  };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-pdf-handoff-routing-test-"));
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

function textOf(content: Awaited<ReturnType<typeof handleFetchTool>>): string {
  const first = content[0];
  if (!first || first.type !== "text") throw new Error("先頭要素がtextブロックではありません");
  return first.text;
}

describe("拡張子なしPDF(content-typeのみで判明)のハンドオフ→PDF経路ルーティング", () => {
  let guardSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    guardSpy = vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
    httpGetRoutedMock.mockReset();
    httpGetBinaryMock.mockReset();
  });

  afterEach(() => {
    guardSpy.mockRestore();
  });

  it("URL拡張子で判定できないPDFはmarkdown応答(fetch_tier: pdf)になり、取得は1回で済む", async () => {
    const url = "https://example.com/download?id=123";
    httpGetRoutedMock.mockResolvedValue({
      kind: "handoff",
      status: 200,
      finalUrl: url,
      headers: new Headers({ etag: '"pdf-v1"' }),
      contentType: "application/pdf",
      bytes: fixture("sample-text.pdf"),
      declaredSize: null,
      truncated: false,
    });

    const content = await handleFetchTool({ url });
    const text = textOf(content);
    expect(text).toContain("mode_used: markdown");
    expect(text).toContain("fetch_tier: pdf");
    // content-typeで判明した時点で本体を読み切っているため、PDF経路が取得し直さない
    expect(httpGetBinaryMock).not.toHaveBeenCalled();
  });

  it("2回目以降もPDF応答のまま返る(HTMLページの応答形式に変わらない)", async () => {
    const url = "https://example.com/download?id=456";
    httpGetRoutedMock.mockResolvedValue({
      kind: "handoff",
      status: 200,
      finalUrl: url,
      headers: new Headers(),
      contentType: "application/pdf",
      bytes: fixture("sample-text.pdf"),
      declaredSize: null,
      truncated: false,
    });

    await handleFetchTool({ url });
    httpGetRoutedMock.mockClear();
    const text = textOf(await handleFetchTool({ url }));

    expect(text).toContain("fetch_tier: pdf");
    // キャッシュがPDFと記録しているため、HTML経路(httpGetRouted)へ行かない
    expect(httpGetRoutedMock).not.toHaveBeenCalled();
  });

  it("PDF以外の非HTMLコンテンツ(application/zip)は従来通りhandoff応答のままになる(デグレ防止)", async () => {
    httpGetRoutedMock.mockResolvedValue({
      kind: "handoff",
      status: 200,
      finalUrl: "https://example.com/archive.zip",
      headers: new Headers(),
      contentType: "application/zip",
      bytes: new TextEncoder().encode("PK\x03\x04"),
      declaredSize: 4,
      truncated: false,
    });

    const content = await handleFetchTool({ url: "https://example.com/archive.zip" });
    const text = textOf(content);
    expect(text).toContain("mode_used: handoff");
    expect(httpGetBinaryMock).not.toHaveBeenCalled();
  });
});
