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
  /** ページ読み込み中に発生するサブフレーム/サブリソースのリクエスト(route handlerへ通す)。 */
  readonly subRequests: FakeRequest[] = [];
  /** 各サブリクエストがhandlerでcontinue/abortのどちらになったか。 */
  readonly subRequestOutcomes: Array<{ url: string; outcome: "continue" | "abort" }> = [];
  private handler: RouteHandler | null = null;
  private readonly mainFrameSentinel = { id: "main-frame" };
  private finalUrl = "";

  mainFrame(): unknown {
    return this.mainFrameSentinel;
  }

  private async dispatchSubRequests(): Promise<void> {
    for (const request of this.subRequests) {
      let aborted = false;
      const route: FakeRoute = {
        abort: async () => {
          aborted = true;
        },
        continue: async () => {},
      };
      if (this.handler) await this.handler(route, request);
      this.subRequestOutcomes.push({ url: request.url(), outcome: aborted ? "abort" : "continue" });
    }
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
        await this.dispatchSubRequests();
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

  const subFrameNav = (url: string): FakeRequest => ({
    url: () => url,
    isNavigationRequest: () => true,
    frame: () => ({ id: "sub-frame" }),
  });
  const subResource = (url: string): FakeRequest => ({
    url: () => url,
    isNavigationRequest: () => false,
    frame: () => ({ id: "sub-frame" }),
  });

  it("SSRF: privateアドレスへのサブフレーム(iframe)遷移はページ全体を失敗させずに該当リクエストのみabortする", async () => {
    const page = new FakePage();
    // 攻撃者ページが <iframe src=http://169.254.169.254/...> を埋め込み、スクリーンショットに
    // 内部情報を写し込もうとするケースを模す。iframeのナビゲーションは遮断されるが、
    // メインページの取得(goto)自体は成功する。
    page.subRequests.push(subFrameNav("http://169.254.169.254/latest/meta-data/"));

    const response = await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000);
    expect(response?.status()).toBe(200);
    expect(page.subRequestOutcomes).toEqual([{ url: "http://169.254.169.254/latest/meta-data/", outcome: "abort" }]);
  });

  it("SSRF: privateアドレスへのサブリソース(no-cors fetch/img等)はabortされる", async () => {
    const page = new FakePage();
    page.subRequests.push(subResource("http://127.0.0.1:8080/admin/delete"));

    await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000);
    expect(page.subRequestOutcomes).toEqual([{ url: "http://127.0.0.1:8080/admin/delete", outcome: "abort" }]);
  });

  it("SSRF: サブリソースのfile:スキームはabortされる", async () => {
    const page = new FakePage();
    page.subRequests.push(subResource("file:///etc/passwd"));

    await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000);
    expect(page.subRequestOutcomes).toEqual([{ url: "file:///etc/passwd", outcome: "abort" }]);
  });

  it("data:/公開ホストのサブリソースは許可される(インライン画像や正当な外部リソースを壊さない)", async () => {
    const page = new FakePage();
    page.subRequests.push(subResource("data:image/png;base64,iVBORw0KGgo="));
    page.subRequests.push(subResource("http://93.184.216.34/style.css"));

    await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000);
    expect(page.subRequestOutcomes).toEqual([
      { url: "data:image/png;base64,iVBORw0KGgo=", outcome: "continue" },
      { url: "http://93.184.216.34/style.css", outcome: "continue" },
    ]);
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
