import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 使われなくなったブラウザを閉じる(常駐の MCP サーバーで、一度起動した Chrome が
 * プロセスの寿命いっぱい残っていた)。実ブラウザは起動せず、chromium.launch を差し替える。
 */

const { launchMock, closeProxyMock } = vi.hoisted(() => ({ launchMock: vi.fn(), closeProxyMock: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { launch: launchMock } }));
vi.mock("../src/fetcher/ssrfProxy.js", () => ({
  closeSharedSsrfProxy: closeProxyMock,
  getSharedSsrfProxyUrl: async () => "http://127.0.0.1:1",
  takeRecentProxyBlock: () => false,
}));
vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, guardPublicAddress: vi.fn(async () => {}) };
});

const IDLE_MS = 5 * 60_000;

function createFakeBrowser() {
  const openContexts = new Set<object>();
  const browser = {
    closed: 0,
    contexts: () => Array.from(openContexts),
    on: () => {},
    close: async () => {
      browser.closed++;
    },
    newContext: async () => {
      const context = {
        newPage: async () => ({
          mainFrame: () => ({}),
          // 転送の段を止めるCDPのFetchドメインの代わり(ここでは転送を起こさないので受けるだけ)
          context: () => ({
            newCDPSession: async () => ({
              on: () => {},
              send: async (method: string) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main-frame" } } } : {}),
              detach: async () => {},
            }),
          }),
          on: () => {},
          off: () => {},
          route: async () => {},
          unroute: async () => {},
          waitForLoadState: async () => {},
          goto: async () => ({ status: () => 200, statusText: () => "OK", headers: () => ({}) }),
          url: () => "https://example.com/",
        }),
        close: async () => {
          openContexts.delete(context);
        },
      };
      openContexts.add(context);
      return context;
    },
  };
  return browser;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  launchMock.mockReset();
  closeProxyMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("使われなくなったブラウザを閉じる", () => {
  it("最後にページを開いてから5分使わなければ、ブラウザと SSRF 検証プロキシを閉じる", async () => {
    const browser = createFakeBrowser();
    launchMock.mockResolvedValue(browser);
    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");

    const { context } = await openPageAndNavigate("https://example.com/", 5000);
    await context.close();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    expect(browser.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(browser.closed).toBe(1);
    expect(closeProxyMock).toHaveBeenCalled();
  });

  it("途中で使えば待ち直し、ページを開いたままなら閉じない", async () => {
    const browser = createFakeBrowser();
    launchMock.mockResolvedValue(browser);
    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");

    const first = await openPageAndNavigate("https://example.com/", 5000);
    await first.context.close();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    const second = await openPageAndNavigate("https://example.com/", 5000);

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(browser.closed).toBe(0); // second のページが開いたまま

    await second.context.close();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(browser.closed).toBe(1);
  });

  it("閉じた後に使えば起動し直す", async () => {
    launchMock.mockImplementation(async () => createFakeBrowser());
    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");

    const { context } = await openPageAndNavigate("https://example.com/", 5000);
    await context.close();
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    await openPageAndNavigate("https://example.com/", 5000);

    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it("閉じている間に次の取得がブラウザを起動したら、そのブラウザが使う SSRF 検証プロキシは止めない", async () => {
    let releaseClose: () => void = () => {};
    const closing = createFakeBrowser();
    closing.close = () =>
      new Promise<void>((resolve) => {
        releaseClose = () => {
          closing.closed++;
          resolve();
        };
      });
    launchMock.mockResolvedValueOnce(closing).mockImplementation(async () => createFakeBrowser());
    const { closeBrowser, getBrowser } = await import("../src/fetcher/browser.js");

    await getBrowser();
    const closed = closeBrowser();
    await getBrowser();
    releaseClose();
    await closed;

    expect(closeProxyMock).not.toHaveBeenCalled();
  });
});
