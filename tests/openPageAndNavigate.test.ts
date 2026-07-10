import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 改善キュー対応: openPageAndNavigate(fetcher/browser.ts)のユニットテスト。
 * 実ブラウザを起動せず、"playwright"のchromium.launchをモックして以下3パターンを検証する:
 *   (a) HTTP2エラー → システムChromeフォールバック成功
 *   (b) HTTP2エラー → システムChrome起動失敗 → 元の分類済みエラーへフォールスルー
 *   (c) 非HTTP2エラー → 即rethrow(システムChrome起動を試みない)
 *
 * chromium.launchの呼び出し引数(channel指定有無)で「同梱chromium」と「システムChrome」を
 * 区別し、各シナリオでの呼び出し回数・フォールバック発火の有無を確認する。
 */

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));

vi.mock("playwright", () => ({
  chromium: { launch: launchMock },
}));

// navigateSafely内部のguardPublicAddress(fetcher/http.ts)は実SSRFガードのままだと
// DNS解決等の実ネットワーク依存が生じるため、常に許可するようモックする(このテストの
// 関心事はopenPageAndNavigateのフォールバック制御ロジックであり、SSRF検証自体は
// browserNavigate.test.ts側で別途検証済み)。
vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    guardPublicAddress: vi.fn(async () => {}),
  };
});

type GotoResult = { status(): number } | null;

/** page.route/unroute/mainFrame/goto/urlの最小フェイク(browserNavigate.test.tsのFakePageと同系統)。 */
function createFakePage(gotoImpl: (url: string) => Promise<GotoResult>) {
  const mainFrameSentinel = { id: "main-frame" };
  let finalUrl = "";
  return {
    mainFrame: () => mainFrameSentinel,
    route: async () => {},
    unroute: async () => {},
    goto: async (url: string) => {
      const result = await gotoImpl(url);
      finalUrl = url;
      return result;
    },
    url: () => finalUrl,
  };
}

function createFakeBrowser(gotoImpl: (url: string) => Promise<GotoResult>) {
  return {
    newContext: async () => ({
      newPage: async () => createFakePage(gotoImpl),
      close: async () => {},
    }),
    close: async () => {},
  };
}

async function success(): Promise<GotoResult> {
  return { status: () => 200 };
}

function failWith(message: string): () => Promise<GotoResult> {
  return async () => {
    throw new Error(message);
  };
}

const HTTP2_ERROR_MESSAGE = "page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://example.com/";
const CONNECTION_REFUSED_MESSAGE = "page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/";

describe("openPageAndNavigate(改善キュー対応: システムChromeフォールバック)", () => {
  beforeEach(() => {
    vi.resetModules();
    launchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("(a) HTTP2エラー→システムChromeフォールバックが成功する", async () => {
    launchMock.mockImplementation(async (options?: { channel?: string }) => {
      if (options?.channel === "chrome") {
        return createFakeBrowser(success);
      }
      return createFakeBrowser(failWith(HTTP2_ERROR_MESSAGE));
    });

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");
    const result = await openPageAndNavigate("https://example.com/", 5000);

    expect(result.response?.status()).toBe(200);
    // 同梱chromium(channel未指定)とシステムChrome(channel: "chrome")の2回起動されているはず
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(launchMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ headless: true }));
    expect(launchMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ headless: true, channel: "chrome" }));
  });

  it("(b) HTTP2エラー→システムChrome起動失敗→元の分類済みエラー(primaryError)へフォールスルーする", async () => {
    launchMock.mockImplementation(async (options?: { channel?: string }) => {
      if (options?.channel === "chrome") {
        throw new Error("Chromium distribution 'chrome' is not found at /path/to/chrome");
      }
      return createFakeBrowser(failWith(HTTP2_ERROR_MESSAGE));
    });

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");

    await expect(openPageAndNavigate("https://example.com/", 5000)).rejects.toThrow(HTTP2_ERROR_MESSAGE);
    // システムChromeの起動も試みられたことは確認する(フォールバック自体は発火した)
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it("(c) 非HTTP2エラーは即rethrowし、システムChrome起動を試みない", async () => {
    launchMock.mockImplementation(async () => createFakeBrowser(failWith(CONNECTION_REFUSED_MESSAGE)));

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");

    await expect(openPageAndNavigate("https://example.com/", 5000)).rejects.toThrow(CONNECTION_REFUSED_MESSAGE);
    // 同梱chromium(1回)のみ起動され、channel: "chrome"では起動されていないはず
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
    expect(launchMock).not.toHaveBeenCalledWith(expect.objectContaining({ channel: "chrome" }));
  });

  it("システムChromeが実行ファイル不在と判明した後は、以後のHTTP2エラーで再度launchを試みない(プロセス寿命内キャッシュ)", async () => {
    launchMock.mockImplementation(async (options?: { channel?: string }) => {
      if (options?.channel === "chrome") {
        throw new Error("Chromium distribution 'chrome' is not found at /path/to/chrome");
      }
      return createFakeBrowser(failWith(HTTP2_ERROR_MESSAGE));
    });

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");

    await expect(openPageAndNavigate("https://example.com/", 5000)).rejects.toThrow(HTTP2_ERROR_MESSAGE);
    expect(launchMock).toHaveBeenCalledTimes(2); // 同梱chromium + システムChrome(不在判明)

    launchMock.mockClear();

    await expect(openPageAndNavigate("https://example.com/", 5000)).rejects.toThrow(HTTP2_ERROR_MESSAGE);
    // 2回目: 同梱chromiumは既に起動済みインスタンスを再利用(launch不要)、
    // システムChromeも「不在判明済み」キャッシュにより起動を試みないため、launchMockは0回。
    expect(launchMock).not.toHaveBeenCalled();
  });
});
