import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getBrowser()の起動経路: システムのGoogle Chromeを優先し、使えない環境に限り同梱Chromiumへ
 * 切り替える。どの経路でもOSのサンドボックスを有効にして起動する。
 * 実ブラウザは起動せず、"playwright"のchromium.launchをモックする(呼び出し引数のchannel有無で
 * 「システムChrome」と「同梱Chromium」を区別する)。
 */
const { launchMock, proxyUrlMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
  proxyUrlMock: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: { launch: launchMock },
}));

vi.mock("../src/fetcher/ssrfProxy.js", () => ({
  closeSharedSsrfProxy: vi.fn(),
  getSharedSsrfProxyUrl: proxyUrlMock,
}));

const CHROME_NOT_FOUND_MESSAGE =
  "browserType.launch: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome\n" +
  'Run "npx playwright install chrome"';
const CHROME_NOT_SUPPORTED_MESSAGE = "browserType.launch: Chromium distribution 'chrome' is not supported on freebsd";
const SANDBOX_FAILED_MESSAGE =
  "browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\nChromium sandboxing failed!\n================================";
const BUNDLED_MISSING_MESSAGE =
  "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium-1187/chrome-linux/headless_shell\n" +
  "Looks like Playwright was just installed or updated.\n" +
  "Please run the following command to download new browsers:\n\n    npx playwright install\n";

type LaunchOptions = { channel?: string; chromiumSandbox?: boolean; args?: string[] };
type FakeBrowser = { name: string; close(): Promise<void>; on(event: string, listener: () => void): void; emit(event: string): void };
function fakeBrowser(name: string): FakeBrowser {
  const listeners = new Map<string, Array<() => void>>();
  return {
    name,
    close: async () => {},
    on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
    emit: (event) => listeners.get(event)?.forEach((listener) => listener()),
  };
}

/** channel: "chrome"の起動とそれ以外(同梱Chromium)の起動に、それぞれの結果を割り当てる。 */
function arrangeLaunch(chrome: () => Promise<unknown>, bundled: () => Promise<unknown>): void {
  launchMock.mockImplementation(async (options: LaunchOptions) => (options.channel === "chrome" ? chrome() : bundled()));
}

const reject = (message: string) => async () => {
  throw new Error(message);
};

describe("getBrowser() - システムChrome優先・同梱Chromiumへの切り替え・サンドボックス", () => {
  beforeEach(() => {
    vi.resetModules();
    launchMock.mockReset();
    proxyUrlMock.mockReset().mockResolvedValue("http://127.0.0.1:1");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Chromeが使える環境ではChromeだけを起動し、同梱Chromiumは起動しない", async () => {
    arrangeLaunch(async () => fakeBrowser("chrome"), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");

    await expect(getBrowser()).resolves.toMatchObject({ name: "chrome" });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "chrome" }));
  });

  it.each([
    ["未インストール", CHROME_NOT_FOUND_MESSAGE],
    ["配布先の定義が無いOS", CHROME_NOT_SUPPORTED_MESSAGE],
  ])("Chromeが%sの場合は同梱Chromiumを起動する", async (_label, message) => {
    arrangeLaunch(reject(message), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");

    await expect(getBrowser()).resolves.toMatchObject({ name: "bundled" });
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(launchMock).toHaveBeenLastCalledWith(expect.not.objectContaining({ channel: expect.anything() }));
  });

  it("Chromeはあるが起動に失敗した場合は同梱Chromiumへ切り替えず、BrowserLaunchErrorにする", async () => {
    arrangeLaunch(reject(SANDBOX_FAILED_MESSAGE), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");
    const { BrowserLaunchError } = await import("../src/errors.js");

    await expect(getBrowser()).rejects.toBeInstanceOf(BrowserLaunchError);
    expect(launchMock).not.toHaveBeenCalledWith(expect.not.objectContaining({ channel: "chrome" }));
  });

  it("ChromeもChromiumも無い場合はBrowserUnavailableErrorにし、Chromeのインストールとinstall-browserを案内する", async () => {
    arrangeLaunch(reject(CHROME_NOT_FOUND_MESSAGE), reject(BUNDLED_MISSING_MESSAGE));
    const { getBrowser } = await import("../src/fetcher/browser.js");
    const { BrowserUnavailableError } = await import("../src/errors.js");

    const error = await getBrowser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserUnavailableError);
    expect((error as Error).message).toMatch(/Google Chromeをインストール/);
    expect((error as Error).message).toMatch(/npx -y amenbo install-browser/);
  });

  it("Chromeが無く同梱Chromiumが未インストール以外の理由で失敗した場合はBrowserLaunchErrorのままにする", async () => {
    arrangeLaunch(reject(CHROME_NOT_FOUND_MESSAGE), reject(SANDBOX_FAILED_MESSAGE));
    const { getBrowser } = await import("../src/fetcher/browser.js");
    const { BrowserLaunchError, BrowserUnavailableError } = await import("../src/errors.js");

    const error = await getBrowser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect(error).not.toBeInstanceOf(BrowserUnavailableError);
  });

  it("起動に失敗した後の呼び出しでは起動をやり直す(失敗をキャッシュしない)", async () => {
    arrangeLaunch(reject("transient"), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");

    await expect(getBrowser()).rejects.toThrow();
    arrangeLaunch(async () => fakeBrowser("chrome"), async () => fakeBrowser("bundled"));
    await expect(getBrowser()).resolves.toMatchObject({ name: "chrome" });
  });

  it("Chrome・同梱Chromiumのどちらの起動でもサンドボックスを有効にし、--no-sandboxを渡さない", async () => {
    arrangeLaunch(reject(CHROME_NOT_FOUND_MESSAGE), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");

    await getBrowser();
    expect(launchMock).toHaveBeenCalledTimes(2);
    for (const [options] of launchMock.mock.calls as [LaunchOptions][]) {
      expect(options.chromiumSandbox).toBe(true);
      expect(options.args ?? []).not.toContain("--no-sandbox");
    }
  });

  it("Chrome不在と同じ語(is not found)を含んでも、Chrome配布の不在でない失敗では同梱Chromiumへ切り替えない", async () => {
    arrangeLaunch(reject("browserType.launch: libnss3.so is not found"), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");

    await expect(getBrowser()).rejects.toThrow(/libnss3\.so is not found/);
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Chrome", SANDBOX_FAILED_MESSAGE, async () => fakeBrowser("bundled")],
    ["同梱Chromium", CHROME_NOT_FOUND_MESSAGE, reject(SANDBOX_FAILED_MESSAGE)],
  ] as const)("%sをサンドボックス付きで起動できない場合は、理由と対処(root以外で実行・名前空間の許可)を文言に含める", async (_label, chromeMessage, bundled) => {
    arrangeLaunch(reject(chromeMessage), bundled);
    const { getBrowser } = await import("../src/fetcher/browser.js");

    const error = (await getBrowser().catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/サンドボックス付きで起動できませんでした/);
    expect(error.message).toMatch(/一般ユーザーで実行/);
    expect(error.message).toMatch(/ユーザー名前空間/);
  });

  it("それ以外の起動失敗では、原因の先頭行を文言に含める", async () => {
    arrangeLaunch(reject("browserType.launch: Protocol error (Browser.getVersion): unknown method\nstack..."), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");

    await expect(getBrowser()).rejects.toThrow("システムのGoogle Chromeの起動に失敗しました(browserType.launch: Protocol error (Browser.getVersion): unknown method)");
  });

  it("SSRF検証プロキシを起動できない場合はブラウザを起動せず、BrowserLaunchErrorにする", async () => {
    proxyUrlMock.mockRejectedValue(new Error("listen EMFILE: too many open files"));
    arrangeLaunch(async () => fakeBrowser("chrome"), async () => fakeBrowser("bundled"));
    const { getBrowser } = await import("../src/fetcher/browser.js");
    const { BrowserLaunchError } = await import("../src/errors.js");

    const error = (await getBrowser().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect(error.message).toMatch(/SSRF検証プロキシを起動できませんでした\(listen EMFILE/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("起動済みのブラウザが切断されたら、次の呼び出しで起動し直す", async () => {
    const first = fakeBrowser("chrome-1");
    launchMock.mockResolvedValueOnce(first).mockResolvedValueOnce(fakeBrowser("chrome-2"));
    const { getBrowser } = await import("../src/fetcher/browser.js");

    await expect(getBrowser()).resolves.toBe(first);
    await expect(getBrowser()).resolves.toBe(first);
    first.emit("disconnected");
    await expect(getBrowser()).resolves.toMatchObject({ name: "chrome-2" });
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it("起動中にcloseBrowserされ別の起動が始まった後で古い起動が失敗しても、新しい起動を消さない", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    launchMock
      .mockImplementationOnce(() => new Promise((_resolve, rejectLaunch) => (rejectFirst = rejectLaunch)))
      .mockResolvedValueOnce(fakeBrowser("second"));
    const { getBrowser, closeBrowser } = await import("../src/fetcher/browser.js");

    const firstLaunch = getBrowser().catch(() => undefined);
    await vi.waitFor(() => expect(launchMock).toHaveBeenCalledTimes(1));
    const closing = closeBrowser();
    const secondLaunch = getBrowser();
    rejectFirst(new Error("transient"));
    await firstLaunch;
    await closing;

    await expect(secondLaunch).resolves.toMatchObject({ name: "second" });
    await expect(getBrowser()).resolves.toMatchObject({ name: "second" });
    expect(launchMock).toHaveBeenCalledTimes(2);
  });
});
