/**
 * fetcher/browser.ts — Playwright chromium共有インスタンス。
 *
 * 二段フェッチ(fetcher/index.ts)でSPAと判定された場合のみ起動する遅延初期化。
 * プロセス終了シグナルでクリーンアップする。
 */
import { chromium, type Browser, type Page } from "playwright";
import { BrowserLaunchError, FetchTimeoutError } from "../errors.js";
import type { PageGeometrySnapshot } from "../extract/geometry.js";
import { USER_AGENT } from "./http.js";

export type { PageGeometrySnapshot } from "../extract/geometry.js";

const DEFAULT_TIMEOUT_MS = 15_000;

let browserPromise: Promise<Browser> | null = null;
let cleanupRegistered = false;

function registerCleanupHandlers(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    void closeBrowser();
  };
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

/** 共有chromiumインスタンスを取得する(未起動なら遅延起動)。 */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    registerCleanupHandlers();
    browserPromise = chromium.launch({ headless: true }).catch((cause: unknown) => {
      browserPromise = null;
      throw new BrowserLaunchError("chromiumの起動に失敗しました", { cause });
    });
  }
  return browserPromise;
}

/** 共有chromiumインスタンスを終了する(プロセス終了時・テストのクリーンアップ用)。 */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const promise = browserPromise;
  browserPromise = null;
  try {
    const browser = await promise;
    await browser.close();
  } catch {
    // 起動に失敗していた場合等は無視(既にクローズ済み/未起動)
  }
}

export interface BrowserFetchResult {
  finalUrl: string;
  html: string;
  status: number;
  geometry: PageGeometrySnapshot;
}

// ---- Phase 4: ジオメトリ抽出用のデータ採取(型はextract/geometry.tsを正とする) ----

const EMPTY_GEOMETRY: PageGeometrySnapshot = { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 };

/**
 * Phase 4 ジオメトリ抽出用に、テキストを直接持つリーフ要素の bounding box・フォントサイズ・
 * 可視性と、表/canvas/svgの bounding box を採取する。
 *
 * 対象要素には一時属性 `data-amenbo-gid` を付与する。これは page.content() 呼び出し前に
 * 実行することで、後段の抽出処理(extract/markdown.ts, linkedomでの再パース)が
 * 同じ要素をCSSセレクタで再選択できるようにするため(ブラウザとNode間でDOM参照を
 * 直接受け渡せないので、属性経由で紐付ける)。
 */
export async function collectPageGeometry(page: Page): Promise<PageGeometrySnapshot> {
  return page.evaluate(() => {
    const leafSelector = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption";
    const textBlocks: Array<{ id: number; x: number; y: number; width: number; height: number; textLength: number }> = [];
    let gid = 0;

    for (const el of Array.from(document.querySelectorAll(leafSelector))) {
      const text = (el.textContent ?? "").trim();
      if (text.length < 2) continue;

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      gid++;
      el.setAttribute("data-amenbo-gid", String(gid));
      textBlocks.push({
        id: gid,
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        textLength: text.length,
      });
    }

    const visualElements: Array<{ tag: string; x: number; y: number; width: number; height: number }> = [];
    for (const el of Array.from(document.querySelectorAll("table, canvas, svg"))) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      visualElements.push({
        tag: el.tagName.toLowerCase(),
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }

    return {
      textBlocks,
      visualElements,
      pageWidth: Math.ceil(document.documentElement.scrollWidth),
      pageHeight: Math.ceil(document.documentElement.scrollHeight),
    };
  });
}

/**
 * J8: 国内同意バナー・アプリ誘導インタースティシャルを実レンダリング結果から隠す。
 *
 * jp/consentBanner.tsの静的DOM版と同じ判定パターンだが、page.evaluate内は
 * ブラウザコンテキストで実行されNode側のクロージャを参照できないため、判定パターンを
 * self-containedな関数として定義し直している(多少の重複はやむを得ない設計判断)。
 * 実ブラウザではcomputed styleが取得できるため、position:fixed等の判定も加えている。
 * DOMから除去するのではなく非表示にする(スクリーンショット/SPA判定への影響を抑えつつ
 * 視覚的な妨げだけを取り除く)。
 */
export async function hideConsentBanners(page: Page): Promise<number> {
  return page.evaluate(() => {
    const textPatterns = [
      /同意して閉じる/,
      /同意する/,
      /Cookie.{0,10}(の使用に|に)?同意/i,
      /このサイトはCookieを使用/,
      /アプリで(開く|見る|読む)/,
      /アプリをダウンロード/,
      /アプリ内で開く/,
      /ストアで見る/,
    ];
    const idClassPattern = /cookie|consent|cmp[-_]|gdpr|app[-_]?banner|interstitial|smart-?banner/i;
    const maxTextLength = 400;

    let hidden = 0;
    const candidates = Array.from(document.querySelectorAll("div, section, aside, dialog"));
    for (const el of candidates) {
      const text = el.textContent ?? "";
      if (text.length === 0 || text.length > maxTextLength) continue;

      const idClassMatch = idClassPattern.test(`${el.id} ${el.className}`);
      const textMatch = textPatterns.some((pattern) => pattern.test(text));
      if (!(idClassMatch && textMatch)) continue;

      const style = window.getComputedStyle(el);
      const isOverlayish = style.position === "fixed" || style.position === "sticky" || Number(style.zIndex || "0") >= 100;

      if (isOverlayish) {
        (el as HTMLElement).style.setProperty("display", "none", "important");
        hidden++;
      }
    }
    return hidden;
  });
}

/** Playwrightでページをレンダリングし、レンダリング後のHTMLを取得する。 */
export async function fetchWithBrowser(url: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<BrowserFetchResult> {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  try {
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    } catch (cause) {
      if (cause instanceof Error && /timeout/i.test(cause.message)) {
        throw new FetchTimeoutError(url, timeoutMs);
      }
      throw cause;
    }
    await hideConsentBanners(page).catch(() => {
      // ページ評価に失敗しても取得自体は継続する(ベストエフォート)
    });
    // Phase 4: ジオメトリ抽出用のデータ採取(data-amenbo-gid付与)は、それがHTMLへ反映される
    // page.content()より必ず先に行う
    const geometry = await collectPageGeometry(page).catch(() => EMPTY_GEOMETRY);
    const html = await page.content();
    return { finalUrl: page.url(), html, status: response?.status() ?? 200, geometry };
  } finally {
    await context.close();
  }
}
