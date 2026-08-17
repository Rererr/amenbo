import type { Browser } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserUnavailableError } from "../src/errors.js";
import { closeBrowser, getBrowser, hideConsentBanners } from "../src/fetcher/browser.js";

// page.evaluateのシリアライズ境界を検証するため、実Chromiumを使う。
let browser: Browser | null = null;
try {
  browser = await getBrowser();
} catch (error) {
  if (!(error instanceof BrowserUnavailableError)) throw error;
}

afterAll(async () => {
  await closeBrowser();
});

const itWithBrowser = browser ? it : it.skip;

describe("hideConsentBanners(実Chromium)", () => {
  itWithBrowser("共有した判定定義がpage.evaluateの境界を越え、固定表示バナーだけを隠す", async () => {
    const context = await browser!.newContext();
    try {
      const page = await context.newPage();
      await page.setContent(
        `<html><body>
           <div class="smart-banner" style="position:fixed;top:0;left:0;">App Storeから開く</div>
           <div class="cookie-notice">このサイトはCookieを使用しています</div>
           <p>本文はここにあります。</p>
         </body></html>`,
      );

      await expect(hideConsentBanners(page)).resolves.toBe(1);
      await expect(page.locator(".smart-banner").isVisible()).resolves.toBe(false);
      await expect(page.locator(".cookie-notice").isVisible()).resolves.toBe(true);
      await expect(page.locator("p").isVisible()).resolves.toBe(true);
    } finally {
      await context.close();
    }
  });
});
