import { createCanvas } from "@napi-rs/canvas";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * レビュー指摘対応(High): captureTiledScreenshotがpage.screenshot()へ渡すfullPage引数が
 * options.fullPageと一致することを検証する(以前はfullPage:falseを指定しても常にtrueを
 * ハードコードで渡しており、遅延読み込み画像等の追加リクエストを先方へ誘発していた)。
 * 実ブラウザは使わず、fetcher/browser.tsのopenPageAndNavigate/hideConsentBannersを
 * 最小限のフェイクへ差し替える(openPageAndNavigate.test.ts等と同系統のモック流儀)。
 * loadImage()に実際に読めるPNGバイト列が必要なため、page.screenshot()の返り値には
 * @napi-rs/canvasで生成した本物のPNGバッファを使う。
 */
const { openPageAndNavigateMock, hideConsentBannersMock } = vi.hoisted(() => ({
  openPageAndNavigateMock: vi.fn(),
  hideConsentBannersMock: vi.fn(async () => 0),
}));

vi.mock("../src/fetcher/browser.js", () => ({
  openPageAndNavigate: openPageAndNavigateMock,
  hideConsentBanners: hideConsentBannersMock,
}));

const { captureTiledScreenshot, computeTiles, isTileCaptureTruncated } = await import("../src/screenshot.js");

/** page.evaluate/screenshot/urlのみを備えた最小フェイクページ。screenshotはvi.fnで呼び出し引数を検証する。 */
function createFakePage(width: number, height: number) {
  const screenshotMock = vi.fn(async (_options: { type: string; fullPage?: boolean }) => {
    const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
    return canvas.toBuffer("image/png");
  });
  return {
    page: {
      evaluate: async () => ({ width, height }),
      screenshot: screenshotMock,
      url: () => "https://example.com/",
    },
    screenshotMock,
  };
}

describe("computeTiles", () => {
  it("ページ高さがタイル高さ以下なら1タイルになる", () => {
    const tiles = computeTiles(1280, 800, 1280, 1080);
    expect(tiles).toEqual([{ x: 0, y: 0, width: 1280, height: 800 }]);
  });

  it("ページ高さがタイル高さの倍数ちょうどならその数だけタイルになる", () => {
    const tiles = computeTiles(1280, 2160, 1280, 1080);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 1280, height: 1080 });
    expect(tiles[1]).toEqual({ x: 0, y: 1080, width: 1280, height: 1080 });
  });

  it("端数がある場合、最後のタイルは端数の高さになる", () => {
    const tiles = computeTiles(1280, 2500, 1280, 1080);
    expect(tiles).toHaveLength(3);
    expect(tiles[2]).toEqual({ x: 0, y: 2160, width: 1280, height: 340 });
  });

  it("ページ幅がタイル幅より狭い場合はページ幅に合わせる", () => {
    const tiles = computeTiles(800, 500, 1280, 1080);
    expect(tiles[0]?.width).toBe(800);
  });

  it("全タイルのx座標は0で統一される(横方向には分割しない)", () => {
    const tiles = computeTiles(1280, 5000, 1280, 1080);
    expect(tiles.every((t) => t.x === 0)).toBe(true);
  });

  it("極端に長いページはMAX_TILES枚で打ち切られる(トークン予算保護)", () => {
    const tiles = computeTiles(1280, 1_000_000, 1280, 1080);
    expect(tiles.length).toBeLessThanOrEqual(10);
  });

  it("ページ高さが0でも最低1タイルは返す", () => {
    const tiles = computeTiles(1280, 0, 1280, 1080);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.height).toBeGreaterThan(0);
  });
});

describe("isTileCaptureTruncated(N7: MAX_TILES切り捨ての明示)", () => {
  it("ページが短くタイル枚数が十分な場合はfalse", () => {
    expect(isTileCaptureTruncated(800, computeTiles(1280, 800, 1280, 1080).length, 1080)).toBe(false);
  });

  it("MAX_TILES(10)で切り捨てられる長さのページではtrueになる", () => {
    const pageHeight = 1_000_000;
    const tiles = computeTiles(1280, pageHeight, 1280, 1080);
    expect(tiles.length).toBeLessThanOrEqual(10);
    expect(isTileCaptureTruncated(pageHeight, tiles.length, 1080)).toBe(true);
  });

  it("ちょうどタイル高さの倍数で切り捨てが発生しない場合はfalse", () => {
    const pageHeight = 1080 * 3;
    const tiles = computeTiles(1280, pageHeight, 1280, 1080);
    expect(isTileCaptureTruncated(pageHeight, tiles.length, 1080)).toBe(false);
  });
});

describe("captureTiledScreenshot(レビュー指摘対応: fullPageフラグの伝播)", () => {
  beforeEach(() => {
    openPageAndNavigateMock.mockReset();
    hideConsentBannersMock.mockClear();
  });

  it("options.fullPage: falseの場合、page.screenshotへfullPage:falseを渡す(全ページレンダリングを避ける)", async () => {
    const { page, screenshotMock } = createFakePage(800, 500);
    openPageAndNavigateMock.mockResolvedValue({ context: { close: async () => {} }, page, response: null });

    await captureTiledScreenshot("https://example.com/", { fullPage: false });

    expect(screenshotMock).toHaveBeenCalledWith({ type: "png", fullPage: false });
  });

  it("options.fullPage未指定(既定true)の場合、page.screenshotへfullPage:trueを渡す", async () => {
    const { page, screenshotMock } = createFakePage(800, 500);
    openPageAndNavigateMock.mockResolvedValue({ context: { close: async () => {} }, page, response: null });

    await captureTiledScreenshot("https://example.com/");

    expect(screenshotMock).toHaveBeenCalledWith({ type: "png", fullPage: true });
  });

  it("options.fullPage: trueを明示指定した場合もpage.screenshotへfullPage:trueを渡す", async () => {
    const { page, screenshotMock } = createFakePage(800, 500);
    openPageAndNavigateMock.mockResolvedValue({ context: { close: async () => {} }, page, response: null });

    await captureTiledScreenshot("https://example.com/", { fullPage: true });

    expect(screenshotMock).toHaveBeenCalledWith({ type: "png", fullPage: true });
  });
});
