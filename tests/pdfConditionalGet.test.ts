import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * レビュー指摘対応: handlePdfFetch(core.ts)はキャッシュTTL失効後、常にフルDL+全ページ
 * 再パースを行っていた(HTML経路のresolvePageは既にETag/Last-Modifiedで条件付きGETし、
 * 304なら再パースを省略している)。ここではPDF経路にも条件付きGETが効くことを、
 * httpGetBinaryをモックして検証する(実ネットワーク・実PDFファイルは使わない。
 * 200時の全文抽出のみfixtureのPDFバイト列を使う)。
 */

const httpGetBinaryMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGetBinary: (...args: Parameters<typeof actual.httpGetBinary>) => httpGetBinaryMock(...args),
  };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-pdf-conditional-get-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;
// PageCacheのnowはシングルトン生成時にDate.now自体を捕捉するため、vi.useFakeTimers()での
// 時刻偽装は効かない(捕捉済み関数参照は差し替わらない)。実時間の経過でTTL失効を
// 再現するため、TTLを極小値にしてsleepする(cache.test.tsのようなnow注入はsrc/core.tsの
// シングルトン経由では行えないため)。
process.env.AMENBO_CACHE_TTL_MS = "50";

const { cache, handleFetchTool, politeness } = await import("../src/core.js");

afterAll(() => {
  // Windows CI対応: 開いたままのSQLiteファイルハンドルを解放してから削除する
  // (詳細はtests/helpers/tempCache.tsのコメント参照)。
  cleanupCacheDir(cacheDir, () => cache.close());
  delete process.env.AMENBO_CACHE_TTL_MS;
});

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(content: Awaited<ReturnType<typeof handleFetchTool>>): string {
  const first = content[0];
  if (!first || first.type !== "text") throw new Error("先頭要素がtextブロックではありません");
  return first.text;
}

describe("handlePdfFetch - 条件付きGET(ETag/Last-Modified)によるPDF再検証", () => {
  let guardSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    guardSpy = vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
    httpGetBinaryMock.mockReset();
  });

  afterEach(() => {
    guardSpy.mockRestore();
  });

  it("TTL失効後304が返れば再パースせずキャッシュ内容をfresh扱いで返す", async () => {
    const url = "https://example.com/report-conditional.pdf";
    cache.set({
      url,
      etag: '"v1"',
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
      markdown: "## ページ 1\n\nキャッシュ済み本文",
      metadata: { title: "既存タイトル", finalUrl: url, pdfPageCount: 1 },
    });
    await sleep(60); // TTL(50ms)失効を待つ

    httpGetBinaryMock.mockResolvedValue({
      finalUrl: url,
      status: 304,
      headers: new Headers(),
      bytes: new Uint8Array(0),
      contentType: null,
    });

    const content = await handleFetchTool({ url });
    const text = textOf(content);
    expect(text).toContain("キャッシュ済み本文");
    expect(text).toContain("cache: fresh");

    // 条件付きヘッダ(If-None-Match/If-Modified-Since)がキャッシュのetag/lastModifiedから
    // 組み立てられ、httpGetBinaryへ渡されていることを確認する。
    const [, options] = httpGetBinaryMock.mock.calls[0] as [string, { headers?: Record<string, string> }];
    expect(options.headers).toMatchObject({
      "If-None-Match": '"v1"',
      "If-Modified-Since": "Wed, 01 Jul 2026 00:00:00 GMT",
    });
  });

  it("TTL失効後200が返れば従来通りフル抽出しキャッシュを更新する", async () => {
    const url = "https://example.com/report-changed.pdf";
    cache.set({
      url,
      etag: '"v1"',
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
      markdown: "## ページ 1\n\n旧本文",
      metadata: { title: "旧タイトル", finalUrl: url, pdfPageCount: 1 },
    });
    await sleep(60); // TTL(50ms)失効を待つ

    httpGetBinaryMock.mockResolvedValue({
      finalUrl: url,
      status: 200,
      headers: new Headers({ etag: '"v2"' }),
      bytes: fixture("sample-text.pdf"),
      contentType: "application/pdf",
    });

    const content = await handleFetchTool({ url });
    const text = textOf(content);
    expect(text).toContain("cache: miss");
    expect(text).toContain("統計"); // sample-text.pdf由来の本文(旧本文ではない)

    const updated = cache.get(url);
    expect(updated?.etag).toBe('"v2"');
  });
});
