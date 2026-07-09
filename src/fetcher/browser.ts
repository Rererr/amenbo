/**
 * fetcher/browser.ts — Playwright chromium共有インスタンス。
 *
 * 二段フェッチ(fetcher/index.ts)でSPAと判定された場合のみ起動する遅延初期化。
 * プロセス終了シグナルでクリーンアップする。
 */
import { chromium, type Browser } from "playwright";
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
    const html = await page.content();
    return { finalUrl: page.url(), html, status: response?.status() ?? 200 };
  } finally {
    await context.close();
  }
}
