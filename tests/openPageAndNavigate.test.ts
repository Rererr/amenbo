import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * openPageAndNavigate(fetcher/browser.ts)のユニットテスト。
 * 実ブラウザを起動せず、"playwright"のchromium.launchをモックする。
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

// navigateSafely内部のguardPublicAddress(fetcher/http.ts)は実SSRFガードのままだと
// DNS解決等の実ネットワーク依存が生じるため、常に許可するようモックする(このテストの
// 関心事はopenPageAndNavigateのcontext管理であり、SSRF検証自体は
// browserNavigate.test.ts側で別途検証済み)。
vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    guardPublicAddress: vi.fn(async () => {}),
  };
});

type GotoResult = { status(): number; statusText?(): string; headers?(): Record<string, string> } | null;

/** page.route/unroute/mainFrame/goto/urlの最小フェイク(browserNavigate.test.tsのFakePageと同系統)。 */
function createFakePage(gotoImpl: (url: string) => Promise<GotoResult>, landedUrl?: string) {
  const mainFrameSentinel = { id: "main-frame" };
  let finalUrl = "";
  // リダイレクトのホップを止めるCDPのFetchドメイン(このテストではホップを起こさないので受けるだけ)
  const cdpSession = {
    on: () => {},
    send: async (method: string) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main-frame" } } } : {}),
    detach: async () => {},
  };
  return {
    mainFrame: () => mainFrameSentinel,
    context: () => ({ newCDPSession: async () => cdpSession }),
    route: async () => {},
    unroute: async () => {},
    goto: async (url: string) => {
      const result = await gotoImpl(url);
      finalUrl = landedUrl ?? url;
      return result;
    },
    url: () => finalUrl,
  };
}

function createFakeBrowser(gotoImpl: (url: string) => Promise<GotoResult>, onContextClose: () => void = () => {}, landedUrl?: string) {
  return {
    newContext: async () => ({
      newPage: async () => createFakePage(gotoImpl, landedUrl),
      close: async () => onContextClose(),
    }),
    on: () => {},
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

describe("openPageAndNavigate", () => {
  beforeEach(() => {
    vi.resetModules();
    launchMock.mockReset();
    proxyUrlMock.mockReset().mockResolvedValue("http://127.0.0.1:1");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("遷移に成功したらcontext・page・responseを返す", async () => {
    launchMock.mockImplementation(async () => createFakeBrowser(success));

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");
    const result = await openPageAndNavigate("https://example.com/", 5000);

    expect(result.response?.status()).toBe(200);
    expect(result.page.url()).toBe("https://example.com/");
  });

  it("bot 対策の画面(429)はcontextを閉じてHttpStatusErrorにし、Retry-Afterを載せる(取得成功として返さない)", async () => {
    let closedContexts = 0;
    const refused = async (): Promise<GotoResult> => ({ status: () => 429, statusText: () => "Too Many Requests", headers: () => ({ "retry-after": "60" }) });
    launchMock.mockImplementation(async () => createFakeBrowser(refused, () => closedContexts++, "https://www.example.com/sorry"));

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");
    const { HttpStatusError } = await import("../src/errors.js");

    const error = await openPageAndNavigate("https://example.com/", 5000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    // 記録するのは転送後に着いたホスト(断ってきた相手)。
    expect(error).toMatchObject({ status: 429, retryAfterMs: 60_000, url: "https://www.example.com/sorry" });
    expect(closedContexts).toBe(1);
  });

  it.each([400, 404])("%i もHttpStatusErrorにする(HTTP経路と同じく400以上は失敗)", async (status) => {
    const failed = async (): Promise<GotoResult> => ({ status: () => status, statusText: () => "x", headers: () => ({}) });
    launchMock.mockImplementation(async () => createFakeBrowser(failed));

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");
    const { HttpStatusError } = await import("../src/errors.js");

    await expect(openPageAndNavigate("https://example.com/", 5000)).rejects.toThrow(HttpStatusError);
  });

  it("399 以下は成功として返す", async () => {
    launchMock.mockImplementation(async () => createFakeBrowser(async () => ({ status: () => 399 })));

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");
    await expect(openPageAndNavigate("https://example.com/", 5000)).resolves.toMatchObject({ page: expect.anything() });
  });

  it("遷移に失敗したらcontextを閉じて元のエラーを投げ、別のブラウザで取り直さない", async () => {
    let closedContexts = 0;
    launchMock.mockImplementation(async () => createFakeBrowser(failWith(HTTP2_ERROR_MESSAGE), () => closedContexts++));

    const { openPageAndNavigate } = await import("../src/fetcher/browser.js");

    await expect(openPageAndNavigate("https://example.com/", 5000)).rejects.toThrow(HTTP2_ERROR_MESSAGE);
    expect(closedContexts).toBe(1);
    expect(launchMock).toHaveBeenCalledTimes(1);
  });
});
