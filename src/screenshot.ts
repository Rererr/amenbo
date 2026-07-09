/**
 * screenshot.ts — 品質スコア自動切替(mode: auto)/screenshotツール共通のタイル撮影。
 *
 * Playwright共有インスタンス(fetcher/browser.ts)を利用し、フルページを
 * 幅1280px×高さ約1080px毎のタイルへclipで分割して撮影する(sharp等の画像処理ライブラリは使わない)。
 * scaleはPlaywrightのdeviceScaleFactorとして働き、1未満にすると出力解像度(=画像バイト数
 * ≒ トークン消費量)を圧縮できるレバーになる。
 */
import { FetchTimeoutError } from "./errors.js";
import { getBrowser, hideConsentBanners } from "./fetcher/browser.js";
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
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.0;

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

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width, height: DEFAULT_TILE_HEIGHT },
    deviceScaleFactor: scale,
  });

  try {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    } catch (cause) {
      if (cause instanceof Error && /timeout/i.test(cause.message)) {
        throw new FetchTimeoutError(url, timeoutMs);
      }
      throw cause;
    }

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

    const tiles: ScreenshotTile[] = [];
    for (const geometry of geometries) {
      // clipで現在のビューポート外(スクロール未表示領域)を切り出すには、Playwrightの仕様上
      // fullPage: true を併用してページ全体をキャプチャした上でclip領域を抜き出す必要がある
      // (fullPage無しのclipは現在のビューポート内にしか適用されず、範囲外だとエラーになる)。
      const png = await page.screenshot({ clip: geometry, fullPage: true, type: "png" });
      tiles.push({ geometry, png });
    }

    return { finalUrl: page.url(), pageWidth: dimensions.width, pageHeight: dimensions.height, tiles };
  } finally {
    await context.close();
  }
}
