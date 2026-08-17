import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP progress notifications: fetcher/index.tsのfetchPageは、二段フェッチで
 * headlessブラウザへ昇格する直前にのみonProgressを呼ぶ(SPA判定でHTTP tierのまま
 * 完結する場合は呼ばない)。実ブラウザ・実ネットワークに依存せず検証するため、
 * httpGetRouted/fetchWithBrowserをモックする(links.test.tsと同様のモック手法)。
 */

const httpGetRoutedMock = vi.fn();
const fetchWithBrowserMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGetRouted: (...args: Parameters<typeof actual.httpGetRouted>) => httpGetRoutedMock(...args),
  };
});

vi.mock("../src/fetcher/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/browser.js")>();
  return {
    ...actual,
    fetchWithBrowser: (...args: Parameters<typeof actual.fetchWithBrowser>) => fetchWithBrowserMock(...args),
  };
});

const { fetchPage } = await import("../src/fetcher/index.js");

function htmlRouted(html: string) {
  return { kind: "html" as const, status: 200, finalUrl: "https://example.com/", headers: new Headers(), html, encoding: "UTF-8" };
}

beforeEach(() => {
  httpGetRoutedMock.mockReset();
  fetchWithBrowserMock.mockReset();
});

describe("fetchPage - onProgress(MCP progress notifications)", () => {
  it("SPA判定でブラウザへ昇格する場合のみonProgressが1回呼ばれる", async () => {
    httpGetRoutedMock.mockResolvedValue(htmlRouted('<html><body><div id="root"></div></body></html>'));
    fetchWithBrowserMock.mockResolvedValue({
      finalUrl: "https://example.com/",
      html: "<html><body>rendered</body></html>",
      status: 200,
      geometry: { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 },
    });

    const onProgress = vi.fn();
    const result = await fetchPage("https://example.com/", { onProgress });

    expect("tier" in result && result.tier).toBe("browser");
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith("ブラウザで再取得しています…");
  });

  it("SPA判定からのブラウザ昇格前にwaitTurnを呼ぶ", async () => {
    httpGetRoutedMock.mockResolvedValue(htmlRouted('<html><body><div id="root"></div></body></html>'));
    const events: string[] = [];
    const waitTurn = vi.fn(async () => {
      events.push("wait");
    });
    fetchWithBrowserMock.mockImplementation(async () => {
      events.push("browser");
      return {
        finalUrl: "https://example.com/",
        html: "<html><body>rendered</body></html>",
        status: 200,
        geometry: { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 },
      };
    });

    await fetchPage("https://example.com/", { waitTurn });

    expect(waitTurn).toHaveBeenCalledWith("https://example.com/");
    expect(events).toEqual(["wait", "browser"]);
  });

  it("HTTP tierのまま完結する(昇格しない)場合はonProgressが呼ばれない", async () => {
    httpGetRoutedMock.mockResolvedValue(htmlRouted("<html><body>hello world</body></html>"));

    const onProgress = vi.fn();
    const result = await fetchPage("https://example.com/", { onProgress });

    expect("tier" in result && result.tier).toBe("http");
    expect(onProgress).not.toHaveBeenCalled();
    expect(fetchWithBrowserMock).not.toHaveBeenCalled();
  });

  it("forceBrowser指定時はHTTP取得を行わずブラウザだけで取得する", async () => {
    fetchWithBrowserMock.mockResolvedValue({
      finalUrl: "https://example.com/",
      html: "<html><body>rendered</body></html>",
      status: 200,
      geometry: { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 },
    });

    const onProgress = vi.fn();
    const waitTurn = vi.fn().mockResolvedValue(undefined);
    const result = await fetchPage("https://example.com/", { forceBrowser: true, onProgress, waitTurn });

    expect("tier" in result && result.tier).toBe("browser");
    // 結果を捨てるだけのHTTP取得を先方へ送らない(低負荷の要点)
    expect(httpGetRoutedMock).not.toHaveBeenCalled();
    expect(waitTurn).toHaveBeenCalledWith("https://example.com/");
    expect(onProgress).toHaveBeenCalledWith("ブラウザで取得しています…");
  });

  it("ブラウザ層にもrobots.txt確認コールバックを渡す(別オリジンへの遷移用)", async () => {
    httpGetRoutedMock.mockResolvedValue(htmlRouted('<html><body><div id="root"></div></body></html>'));
    fetchWithBrowserMock.mockResolvedValue({
      finalUrl: "https://example.com/",
      html: "<html><body>rendered</body></html>",
      status: 200,
      geometry: { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 },
    });
    const checkRobots = vi.fn(async () => {});

    await fetchPage("https://example.com/", { checkRobots });

    expect(fetchWithBrowserMock).toHaveBeenCalledWith("https://example.com/", undefined, { checkRobots });
  });

  it("onProgress未指定でも後方互換で動作する", async () => {
    httpGetRoutedMock.mockResolvedValue(htmlRouted('<html><body><div id="root"></div></body></html>'));
    fetchWithBrowserMock.mockResolvedValue({
      finalUrl: "https://example.com/",
      html: "<html><body>rendered</body></html>",
      status: 200,
      geometry: { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 },
    });

    await expect(fetchPage("https://example.com/")).resolves.toMatchObject({ tier: "browser" });
  });
});
