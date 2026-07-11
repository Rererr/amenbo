import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chromium遅延化(§4)対応: postinstall廃止によりChromium未インストールのままgetBrowser()が
 * 呼ばれた場合、playwright-coreが投げる"Executable doesn't exist"系のエラーを
 * BrowserUnavailableError(install-browserへの誘導メッセージ付き)へ変換することを検証する。
 * 実ブラウザは起動せず、"playwright"のchromium.launchをモックする(openPageAndNavigate.test.tsと同系統)。
 */
const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));

vi.mock("playwright", () => ({
  chromium: { launch: launchMock },
}));

const MISSING_EXECUTABLE_MESSAGE =
  "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium-1187/chrome-linux/headless_shell\n" +
  "Looks like Playwright was just installed or updated.\n" +
  "Please run the following command to download new browsers:\n\n    npx playwright install\n";

describe("getBrowser() - Chromium未インストール時のエラー変換", () => {
  beforeEach(() => {
    vi.resetModules();
    launchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Executable doesn't exist系のエラーはBrowserUnavailableErrorに変換され、install-browserを案内する", async () => {
    launchMock.mockRejectedValue(new Error(MISSING_EXECUTABLE_MESSAGE));

    const { getBrowser } = await import("../src/fetcher/browser.js");
    const { BrowserUnavailableError } = await import("../src/errors.js");

    await expect(getBrowser()).rejects.toBeInstanceOf(BrowserUnavailableError);
    await expect(getBrowser()).rejects.toThrow(/npx -y amenbo install-browser/);
  });

  it("それ以外の起動失敗は従来通りBrowserLaunchErrorのままにする", async () => {
    launchMock.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));

    const { getBrowser } = await import("../src/fetcher/browser.js");
    const { BrowserLaunchError, BrowserUnavailableError } = await import("../src/errors.js");

    await expect(getBrowser()).rejects.toBeInstanceOf(BrowserLaunchError);
    await expect(getBrowser()).rejects.not.toBeInstanceOf(BrowserUnavailableError);
  });
});
