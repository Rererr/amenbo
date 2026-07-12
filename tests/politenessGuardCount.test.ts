import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "../src/screenshot.js";

/**
 * レビュー指摘対応: politeness.guardは「実際にサイトへ取得しに行く」直前でのみ呼ばれるべきで、
 * キャッシュfresh応答(実ネットワークアクセスが発生しない)では一切呼ばれてはならない
 * (以前は全mode共通の無条件guardをhandleFetchTool冒頭で行っており、outline→sectionの
 * 推奨フロー等キャッシュヒットのたびに待機・robots再判定という自己ペナルティが発生していた)。
 *
 * 実ブラウザ・実ネットワークアクセスを避けるため、captureTiledScreenshot/httpGetRoutedを
 * モックし、politeness.guard自体もspyOnして呼び出し回数のみを検証する。
 */

const fakeCaptureResult: CaptureResult = {
  finalUrl: "https://example.com/",
  pageWidth: 1280,
  pageHeight: 1080,
  tiles: [{ geometry: { x: 0, y: 0, width: 1280, height: 1080 }, png: Buffer.from("fake-png") }],
  truncated: false,
};

const httpGetRoutedMock = vi.fn();
const evaluateQualityMock = vi.fn();

vi.mock("../src/screenshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screenshot.js")>();
  return {
    ...actual,
    captureTiledScreenshot: vi.fn(async () => fakeCaptureResult),
  };
});

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGetRouted: (...args: Parameters<typeof actual.httpGetRouted>) => httpGetRoutedMock(...args),
  };
});

// mode:autoでのlowQuality→screenshot切替を、Readabilityの抽出結果に依存せず決定的に
// 再現するため、品質判定(evaluateQuality)自体をモックする(既定は実実装のまま動作させ、
// 特定のテストでのみmockReturnValueOnceで低品質判定を差し込む)。
vi.mock("../src/extract/qualityScore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extract/qualityScore.js")>();
  evaluateQualityMock.mockImplementation(actual.evaluateQuality);
  return { ...actual, evaluateQuality: evaluateQualityMock };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-guard-count-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { handleFetchTool, handleScreenshotTool, politeness } = await import("../src/core.js");

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

function htmlRouted(url: string, html: string) {
  return { kind: "html" as const, status: 200, finalUrl: url, headers: new Headers(), html, encoding: "UTF-8" };
}

// extract.test.tsと同じfixture(header/nav/aside/footerのノイズ+実質的な本文を持つ記事)を使う。
// 単純な"<p>hello</p>"程度のHTMLだとReadabilityがarticleを見つけられず"body-fallback"判定になり、
// fetchAndExtract内のジオメトリ再エスカレーション(forceBrowser)が走って実ブラウザ起動を
// 試みてしまう(このテストの関心事であるguard呼び出し回数がぶれる)ため、これを避ける。
const articleHtml = readFileSync(fileURLToPath(new URL("./fixtures/article.html", import.meta.url)), "utf-8");

describe("politeness.guard呼び出し回数(実ネットワークfetch直前でのみguardする設計)", () => {
  let guardSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    guardSpy = vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
    httpGetRoutedMock.mockReset();
  });

  afterEach(() => {
    guardSpy.mockRestore();
  });

  // guardはキャッシュfresh返却時には呼ばれず、実撮影(cache miss)の直前でのみ呼ばれる設計のため、
  // 各テストはスクリーンショットキャッシュに衝突しない固有URLを使い確実にcache missにする。
  it("fetchツールのmode: screenshot早期return経路はguardを1回のみ呼ぶ(resolveScreenshot内)", async () => {
    const url = "https://example.com/shot-fetch-screenshot";
    await handleFetchTool({ url, mode: "screenshot" });
    expect(guardSpy).toHaveBeenCalledTimes(1);
    // 第2引数はMCP progress notifications用のonProgress(未指定時はundefined)
    expect(guardSpy).toHaveBeenCalledWith(url, undefined);
  });

  it("独立screenshotツール経路はguardを1回のみ呼ぶ(resolveScreenshot内)", async () => {
    const url = "https://example.com/shot-independent-tool";
    await handleScreenshotTool({ url });
    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy).toHaveBeenCalledWith(url, undefined);
  });

  it("キャッシュfreshな2回目のscreenshot撮影ではguardが呼ばれない(#4と同型の回帰テスト)", async () => {
    const url = "https://example.com/shot-fresh-cache";
    await handleScreenshotTool({ url });
    expect(guardSpy).toHaveBeenCalledTimes(1); // 1回目はcache missのためguardする

    guardSpy.mockClear();
    await handleScreenshotTool({ url });
    // 2回目はキャッシュ済みタイルを返すだけで実撮影に行かないためguardしない
    expect(guardSpy).not.toHaveBeenCalled();
  });

  it("キャッシュfreshな2回目のmarkdown取得ではguardが呼ばれない(自己ペナルティ解消の回帰テスト)", async () => {
    const url = "https://example.com/fresh-cache-guard-test";
    httpGetRoutedMock.mockResolvedValue(htmlRouted(url, articleHtml));

    await handleFetchTool({ url });
    expect(guardSpy).toHaveBeenCalledTimes(1); // 1回目は新規取得(cache miss)のためguardする
    expect(httpGetRoutedMock).toHaveBeenCalledTimes(1);

    guardSpy.mockClear();
    await handleFetchTool({ url });
    // 2回目はcache freshのため実ネットワークへ行かず、guard(robots再判定・レート制御待機)も行わない
    expect(guardSpy).not.toHaveBeenCalled();
    expect(httpGetRoutedMock).toHaveBeenCalledTimes(1);
  });

  it("mode:autoでlowQuality判定によりscreenshotへ切り替わる場合、markdown取得+screenshot撮影で計2回guardする", async () => {
    const url = "https://example.com/low-quality-guard-test";
    httpGetRoutedMock.mockResolvedValue(htmlRouted(url, articleHtml));
    evaluateQualityMock.mockReturnValueOnce({
      density: 0.1,
      visualOccupancyRatio: 0,
      imgMissingAltRatio: 0,
      lowQuality: true,
      reason: "テスト用の強制低品質判定",
    });

    await handleFetchTool({ url, mode: "auto" });

    // 1回目: resolvePage内のmarkdown取得直前、2回目: lowQuality判定によるscreenshotナビゲーション直前
    expect(guardSpy).toHaveBeenCalledTimes(2);
  });
});
