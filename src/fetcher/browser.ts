/**
 * fetcher/browser.ts — Playwright chromium共有インスタンス。
 *
 * 二段フェッチ(fetcher/index.ts)でSPAと判定された場合のみ起動する遅延初期化。
 * プロセス終了シグナルでクリーンアップする。
 */
import { chromium, type Browser, type Page } from "playwright";
import { BrowserLaunchError, FetchTimeoutError } from "../errors.js";
import { USER_AGENT } from "./http.js";

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
    const html = await page.content();
    return { finalUrl: page.url(), html, status: response?.status() ?? 200 };
  } finally {
    await context.close();
  }
}
