import { describe, expect, it, vi } from "vitest";
import { InvalidUrlError, PrivateAddressError } from "../src/errors.js";
import { isChromiumHttp2NavigationError, navigateSafely } from "../src/fetcher/browser.js";

/**
 * C1/C2: fetcher/browser.tsのnavigateSafelyは、Playwrightのpage.goto()前後で
 * SSRF/スキーム検証(guardPublicAddress)を通す(初回遷移+各リダイレクトホップの再検証)。
 *
 * 実ブラウザを起動せずにこの振る舞いを検証するため、テストで使う分だけの最小限の
 * Playwright Page互換フェイクを用意する(route/unroute/mainFrame/goto)。goto()は
 * このフェイク内で「リダイレクトチェーン」を模倣し、page.route()相当のハンドラを
 * 各ホップに対して呼び出す(Playwright実機のroute interceptionと同じタイミングで
 * abort/continueされる)。IPリテラル(93.184.216.34, 127.0.0.1等)を使うことで
 * DNS解決を伴わずに完全にオフラインで再現できる。
 */

type RouteHandler = (route: FakeRoute, request: FakeRequest) => Promise<void>;

interface FakeRoute {
  abort(): Promise<void>;
  continue(): Promise<void>;
}

interface FakeRequest {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
}

class FakePage {
  readonly redirects = new Map<string, string>();
  private handler: RouteHandler | null = null;
  private readonly mainFrameSentinel = { id: "main-frame" };
  private finalUrl = "";

  mainFrame(): unknown {
    return this.mainFrameSentinel;
  }

  async route(_pattern: string, handler: RouteHandler): Promise<void> {
    this.handler = handler;
  }

  async unroute(_pattern: string, _handler?: RouteHandler): Promise<void> {
    this.handler = null;
  }

  async goto(startUrl: string, _opts: unknown): Promise<{ status(): number } | null> {
    let currentUrl = startUrl;
    for (let hop = 0; hop < 5; hop++) {
      const request: FakeRequest = {
        url: () => currentUrl,
        isNavigationRequest: () => true,
        frame: () => this.mainFrameSentinel,
      };
      let aborted = false;
      const route: FakeRoute = {
        abort: async () => {
          aborted = true;
        },
        continue: async () => {},
      };

      if (this.handler) {
        await this.handler(route, request);
      }
      if (aborted) {
        // Playwright実機でabortされたナビゲーションはgoto()の例外(net::ERR_FAILED等)になる
        throw new Error(`net::ERR_FAILED at ${currentUrl}`);
      }

      const next = this.redirects.get(currentUrl);
      if (!next) {
        this.finalUrl = currentUrl;
        return { status: () => 200 };
      }
      currentUrl = next;
    }
    throw new Error("too many redirects (test fixture)");
  }

  url(): string {
    return this.finalUrl;
  }
}

describe("navigateSafely", () => {
  it("公開IPアドレスへの直接遷移は許可される", async () => {
    const page = new FakePage();
    const response = await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000);
    expect(response?.status()).toBe(200);
  });

  it("C1: file:スキームは事前検証(page.goto呼び出し前)でInvalidUrlErrorとして拒否される", async () => {
    const page = new FakePage();
    const gotoSpy = vi.spyOn(page, "goto");

    await expect(navigateSafely(page as unknown as import("playwright").Page, "file:///etc/passwd", 5000)).rejects.toThrow(InvalidUrlError);
    expect(gotoSpy).not.toHaveBeenCalled();
  });

  it("C1: private/予約アドレスへの直接遷移はInvalidUrlErrorではなくPrivateAddressErrorとして拒否される", async () => {
    const page = new FakePage();
    await expect(navigateSafely(page as unknown as import("playwright").Page, "http://169.254.169.254/latest/meta-data/", 5000)).rejects.toThrow(
      PrivateAddressError,
    );
  });

  it("C2寄り: リダイレクト先がprivateアドレスの場合、route interceptorがそのホップを遮断しPrivateAddressErrorへ変換する", async () => {
    const page = new FakePage();
    page.redirects.set("http://93.184.216.34/", "http://127.0.0.1/admin");

    await expect(navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000)).rejects.toThrow(PrivateAddressError);
  });

  it("複数ホップの正常なリダイレクトは最終的に許可される", async () => {
    const page = new FakePage();
    page.redirects.set("http://93.184.216.34/a", "http://93.184.216.34/b");
    page.redirects.set("http://93.184.216.34/b", "http://93.184.216.34/c");

    const response = await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/a", 5000);
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe("http://93.184.216.34/c");
  });
});

describe("isChromiumHttp2NavigationError(改善キュー対応: システムChromeフォールバック判定)", () => {
  it("ERR_HTTP2_PROTOCOL_ERRORを含むエラーはtrue", () => {
    const error = new Error("page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://initial.inc/");
    expect(isChromiumHttp2NavigationError(error)).toBe(true);
  });

  it("ERR_HTTP2_接頭辞の別コード(STREAM_ERROR等)も対象に含む", () => {
    const error = new Error("page.goto: net::ERR_HTTP2_STREAM_ERROR at https://example.com/");
    expect(isChromiumHttp2NavigationError(error)).toBe(true);
  });

  it("接続拒否等の一般的なネットワークエラーはfalse(Chromeフォールバックの対象外)", () => {
    const error = new Error("page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/");
    expect(isChromiumHttp2NavigationError(error)).toBe(false);
  });

  it("タイムアウトエラーはfalse", () => {
    const error = new Error("page.goto: Timeout 15000ms exceeded.");
    expect(isChromiumHttp2NavigationError(error)).toBe(false);
  });

  it("Error以外の値はfalse", () => {
    expect(isChromiumHttp2NavigationError("not an error")).toBe(false);
    expect(isChromiumHttp2NavigationError(null)).toBe(false);
  });
});
