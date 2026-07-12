/**
 * screenshot.ts — 品質スコア自動切替(mode: auto)/screenshotツール共通のタイル撮影。
 *
 * Playwright共有インスタンス(fetcher/browser.ts)を利用し、フルページのスクリーンショットを
 * 1回だけ撮影し、@napi-rs/canvasで幅1280px×高さ約1080px毎のタイルへクロップして分割する
 * (N2: 以前はタイル毎にfullPageスクリーンショットを撮り直しており無駄が大きかった)。
 * scaleはPlaywrightのdeviceScaleFactorとして働き、1未満にすると出力解像度(=画像バイト数
 * ≒ トークン消費量)を圧縮できるレバーになる。
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { hideConsentBanners, openPageAndNavigate } from "./fetcher/browser.js";
import { USER_AGENT } from "./fetcher/http.js";

export interface TileGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_TILE_WIDTH = 1280;
export const DEFAULT_TILE_HEIGHT = 1080;
/** 無限スクロール等で異常に長いページの撮影を打ち切る上限枚数(トークン予算保護)。 */
const MAX_TILES = 10;

/**
 * ページ寸法から、幅tileWidth・高さtileHeight毎のタイル矩形を計算する(純関数)。
 * 上から順に敷き詰め、最後のタイルは端数の高さになる。MAX_TILES枚を超える分は切り捨てる。
 */
export function computeTiles(
  pageWidth: number,
  pageHeight: number,
  tileWidth: number = DEFAULT_TILE_WIDTH,
  tileHeight: number = DEFAULT_TILE_HEIGHT,
): TileGeometry[] {
  const width = pageWidth > 0 ? Math.min(tileWidth, pageWidth) : tileWidth;
  const totalHeight = Math.max(pageHeight, 1);

  const tiles: TileGeometry[] = [];
  for (let y = 0; y < totalHeight && tiles.length < MAX_TILES; y += tileHeight) {
    const height = Math.min(tileHeight, totalHeight - y);
    tiles.push({ x: 0, y, width, height });
  }

  return tiles.length > 0 ? tiles : [{ x: 0, y: 0, width, height: Math.min(tileHeight, totalHeight) }];
}

/** N7: computeTilesがMAX_TILES枚で切り捨てを行ったかどうかを判定する(純関数)。 */
export function isTileCaptureTruncated(pageHeight: number, tileCount: number, tileHeight: number = DEFAULT_TILE_HEIGHT): boolean {
  const tilesNeeded = Math.ceil(Math.max(pageHeight, 1) / tileHeight);
  return tilesNeeded > tileCount;
}

export interface ScreenshotOptions {
  /** 既定true。falseの場合は最初のビューポート分(1タイル)のみ撮影する。 */
  fullPage?: boolean;
  /** タイル幅(px)。既定1280。 */
  width?: number;
  /** 解像度スケール(0.5〜1.0)。既定1.0。小さいほど画像サイズ(トークン)が減る。 */
  scale?: number;
  timeoutMs?: number;
}

export interface ScreenshotTile {
  geometry: TileGeometry;
  png: Buffer;
}

export interface CaptureResult {
  finalUrl: string;
  pageWidth: number;
  pageHeight: number;
  tiles: ScreenshotTile[];
  /** N7: MAX_TILES枚を超えるページで切り捨てが発生した場合true。 */
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// レビュー指摘対応(Low): CLI側(cli.ts parseScreenshotArgs)がMCPのzod .min(0.5).max(1.0)と
// 同じ範囲で検証できるよう、この定数をexportしてCLIと共有する(値の重複定義によるずれを防ぐ)。
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 1.0;

function clampScale(scale: number | undefined): number {
  if (scale === undefined) return MAX_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** URLをブラウザでレンダリングし、タイル分割したPNGスクリーンショット群を撮影する。 */
export async function captureTiledScreenshot(url: string, options: ScreenshotOptions = {}): Promise<CaptureResult> {
  const width = options.width ?? DEFAULT_TILE_WIDTH;
  const scale = clampScale(options.scale);
  const fullPage = options.fullPage ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // C1: SSRF/スキーム検証(guardPublicAddress)+リダイレクト再検証込みのナビゲーション。
  // 改善キュー対応: 同梱ChromiumがERR_HTTP2_PROTOCOL_ERROR系で失敗した場合、システムに
  // Chromeがあれば1回だけそちらへフォールバックする(openPageAndNavigate参照)。
  const { context, page } = await openPageAndNavigate(url, timeoutMs, {
    userAgent: USER_AGENT,
    viewport: { width, height: DEFAULT_TILE_HEIGHT },
    deviceScaleFactor: scale,
  });

  try {
    // J8: 撮影前にCookie同意バナー/アプリ誘導オーバーレイを隠す(視覚的な妨げを除く)
    await hideConsentBanners(page).catch(() => {
      // ベストエフォート。失敗しても撮影自体は続行する
    });

    const dimensions = await page.evaluate(() => ({
      width: Math.ceil(document.documentElement.scrollWidth),
      height: Math.ceil(document.documentElement.scrollHeight),
    }));

    const captureHeight = fullPage ? dimensions.height : Math.min(dimensions.height, DEFAULT_TILE_HEIGHT);
    const geometries = computeTiles(dimensions.width, captureHeight, width, DEFAULT_TILE_HEIGHT);
    const truncated = isTileCaptureTruncated(captureHeight, geometries.length);

    // N2: タイル毎にfullPageスクリーンショットを撮り直すのではなく、1回だけ撮影して
    // @napi-rs/canvasでタイル領域をクロップする(deviceScaleFactor分、座標をscale倍する)。
    //
    // レビュー指摘対応(High): 以前はここでfullPage:trueをハードコードしており、
    // 呼び出し元がfullPage:false(CLI --viewport-only / MCP fullPage:false)を指定しても
    // 実際には全ページ分レンダリングしてしまい、遅延読み込み画像・無限スクロールXHR等の
    // 追加リクエストを先方へ誘発していた(明示された低負荷指定を内部で裏切っていた)。
    // fullPage:false時はビューポート(viewport height=DEFAULT_TILE_HEIGHTで撮影済み)のみを
    // 実際に撮影する。captureHeight/geometries/crop座標は既にfullPageの値で分岐済みのため、
    // 1タイル(ビューポート分)のみでも整合する。
    const capturedPng = await page.screenshot({ type: "png", fullPage });
    const image = await loadImage(capturedPng);

    const tiles: ScreenshotTile[] = geometries.map((geometry) => {
      const sx = Math.min(Math.round(geometry.x * scale), Math.max(image.width - 1, 0));
      const sy = Math.min(Math.round(geometry.y * scale), Math.max(image.height - 1, 0));
      const sw = Math.max(1, Math.min(Math.round(geometry.width * scale), image.width - sx));
      const sh = Math.max(1, Math.min(Math.round(geometry.height * scale), image.height - sy));

      const canvas = createCanvas(sw, sh);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

      return { geometry, png: canvas.toBuffer("image/png") };
    });

    return { finalUrl: page.url(), pageWidth: dimensions.width, pageHeight: dimensions.height, tiles, truncated };
  } finally {
    await context.close();
  }
}
