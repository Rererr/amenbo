import { describe, expect, it, vi } from "vitest";
import { BotChallengeError, FetchTimeoutError, InvalidUrlError, PrivateAddressError, RobotsDeniedError } from "../src/errors.js";
import { navigateSafely } from "../src/fetcher/browser.js";

/**
 * C1/C2: fetcher/browser.tsのnavigateSafelyは、Playwrightのpage.goto()前後で
 * SSRF/スキーム検証(guardPublicAddress)を通す(初回遷移+各リダイレクトホップの再検証)。
 *
 * 実ブラウザを起動せずにこの振る舞いを検証するため、テストで使う分だけの最小限の
 * Playwright Page互換フェイクを用意する(route/unroute/mainFrame/goto/context().newCDPSession)。
 * goto()はこのフェイク内で「リダイレクトチェーン」を実機と同じ形で模倣する:
 * page.route()のハンドラは最初の要求(と、ページ内からの遷移)でしか呼ばれず、リダイレクトの
 * ホップはCDPのFetch.requestPausedとしてだけ届く(実機で確認。tests/browserRedirectRobots.test.ts)。
 * IPリテラル(93.184.216.34, 127.0.0.1等)を使うことでDNS解決を伴わずに完全にオフラインで再現できる。
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

type PausedListener = (event: { requestId: string; request: { url: string }; frameId: string; redirectedRequestId?: string }) => void;

/** CDPSessionのうち、Fetchドメインでリダイレクトのホップを止める分だけのフェイク。 */
class FakeCdpSession {
  fetchEnabled = false;
  private listener: PausedListener | null = null;
  private readonly outcomes = new Map<string, (outcome: "continue" | "fail") => void>();

  on(event: string, listener: PausedListener): void {
    if (event === "Fetch.requestPaused") this.listener = listener;
  }

  async send(method: string, params?: { requestId?: string }): Promise<unknown> {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
    if (method === "Fetch.enable") this.fetchEnabled = true;
    if (method === "Fetch.continueRequest") this.outcomes.get(params!.requestId!)?.("continue");
    if (method === "Fetch.failRequest") this.outcomes.get(params!.requestId!)?.("fail");
    return {};
  }

  async detach(): Promise<void> {
    this.fetchEnabled = false;
  }

  /** リダイレクトのホップを止めて、continue/failのどちらになるかを待つ。Fetchが無効なら素通りする。 */
  pauseRedirect(url: string, hop: number): Promise<"continue" | "fail"> {
    if (!this.fetchEnabled || !this.listener) return Promise.resolve("continue");
    const requestId = `hop-${hop}`;
    const outcome = new Promise<"continue" | "fail">((resolve) => this.outcomes.set(requestId, resolve));
    this.listener({ requestId, request: { url }, frameId: "main-frame", redirectedRequestId: `hop-${hop - 1}` });
    return outcome;
  }
}

class FakePage {
  readonly redirects = new Map<string, string>();
  /** 読み込みの後にページ内から遷移する先(location.href・meta refresh相当)。route handlerへ通す。 */
  clientNavigation: string | null = null;
  readonly cdp = new FakeCdpSession();
  /** ページ読み込み中に発生するサブフレーム/サブリソースのリクエスト(route handlerへ通す)。 */
  readonly subRequests: FakeRequest[] = [];
  /** 各サブリクエストがhandlerでcontinue/abortのどちらになったか。 */
  readonly subRequestOutcomes: Array<{ url: string; outcome: "continue" | "abort" }> = [];
  private handler: RouteHandler | null = null;
  private readonly mainFrameSentinel = { id: "main-frame" };
  private finalUrl = "";

  on(): void {}

  off(): void {}

  mainFrame(): unknown {
    return this.mainFrameSentinel;
  }

  // routeはcontextに掛かる(ポップアップの要求も検証するため)。このフェイクではページ1枚なのでページへ渡す。
  context(): {
    newCDPSession(page: unknown): Promise<FakeCdpSession>;
    route(pattern: string, handler: RouteHandler): Promise<void>;
    unroute(pattern: string, handler?: RouteHandler): Promise<void>;
  } {
    return {
      newCDPSession: async () => this.cdp,
      route: (pattern, handler) => this.route(pattern, handler),
      unroute: (pattern, handler) => this.unroute(pattern, handler),
    };
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

  /** waitForLoadState に渡された状態と上限(待ち方の検証用)。 */
  readonly loadStateWaits: Array<{ state: string; timeout: number | undefined }> = [];
  /** networkidle が来ないページを模す(true なら networkidle の待ちがタイムアウトする)。 */
  networkNeverIdle = false;
  /** load が来ないページを模す。 */
  loadNeverFires = false;
  /** 最終応答のヘッダ(bot 対策の確認画面の印の検証用)。 */
  responseHeaders: Record<string, string> = {};
  readonly gotoOptions: unknown[] = [];

  async waitForLoadState(state: string, options?: { timeout?: number }): Promise<void> {
    this.loadStateWaits.push({ state, timeout: options?.timeout });
    if (state === "networkidle" && this.networkNeverIdle) throw new Error(`Timeout ${options?.timeout}ms exceeded.`);
    if (state === "load" && this.loadNeverFires) throw new Error(`page.waitForLoadState: Timeout ${options?.timeout}ms exceeded.`);
  }

  async goto(startUrl: string, opts: unknown): Promise<{ status(): number; statusText(): string; headers(): Record<string, string> } | null> {
    this.gotoOptions.push(opts);
    let currentUrl = startUrl;
    for (let hop = 0; hop < 5; hop++) {
      if (hop === 0) {
        // Playwright実機でabortされたナビゲーションはgoto()の例外(net::ERR_FAILED等)になる
        if (await this.navigateThroughRoute(currentUrl)) throw new Error(`net::ERR_FAILED at ${currentUrl}`);
      } else if ((await this.cdp.pauseRedirect(currentUrl, hop)) === "fail") {
        throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${startUrl}`);
      }

      const next = this.redirects.get(currentUrl);
      if (!next) {
        this.finalUrl = currentUrl;
        await this.dispatchSubRequests();
        // ページ内からの遷移が止められると、gotoは成功したままエラー画面に置き換わる(実機と同じ)
        if (this.clientNavigation && (await this.navigateThroughRoute(this.clientNavigation))) {
          this.finalUrl = "chrome-error://chromewebdata/";
        }
        return { status: () => 200, statusText: () => "OK", headers: () => this.responseHeaders };
      }
      currentUrl = next;
    }
    throw new Error("too many redirects (test fixture)");
  }

  /** メインフレームの新しい遷移をroute handlerへ通し、abortされたかを返す。 */
  private async navigateThroughRoute(url: string): Promise<boolean> {
    const request: FakeRequest = { url: () => url, isNavigationRequest: () => true, frame: () => this.mainFrameSentinel };
    let aborted = false;
    const route: FakeRoute = {
      abort: async () => {
        aborted = true;
      },
      continue: async () => {},
    };
    if (this.handler) await this.handler(route, request);
    return aborted;
  }

  url(): string {
    return this.finalUrl;
  }
}

describe("navigateSafely", () => {
  it("公開IPアドレスへの直接遷移は許可される", async () => {
    const page = new FakePage();
    const { response } = await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000);
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

  it("C2寄り: リダイレクト先がprivateアドレスの場合、CDPで止めたそのホップを遮断しPrivateAddressErrorへ変換する", async () => {
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

    const { response } = await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/", 5000);
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

    const { response } = await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/a", 5000);
    expect(response?.status()).toBe(200);
    expect(page.url()).toBe("http://93.184.216.34/c");
  });
});

describe("navigateSafely - リダイレクト時のrobots.txt確認", () => {
  it("メインフレームの遷移ごとに、同一オリジンの転送先も含めてcheckRobotsが呼ばれる", async () => {
    const page = new FakePage();
    page.redirects.set("http://93.184.216.34/a", "http://93.184.216.34/b"); // 同一オリジン
    page.redirects.set("http://93.184.216.34/b", "http://8.8.8.8/c"); // 別オリジン
    const checkRobots = vi.fn(async () => {});

    await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/a", 5000, { checkRobots });

    expect(checkRobots.mock.calls.map((call) => call[0])).toEqual(["http://93.184.216.34/a", "http://93.184.216.34/b", "http://8.8.8.8/c"]);
  });

  it("ページ内からの遷移(location.href等)がrobots.txtで拒否されたら、gotoが成功してもエラー画面を返さず失敗する", async () => {
    const page = new FakePage();
    page.clientNavigation = "http://93.184.216.34/private/js";
    const checkRobots = vi.fn(async (url: string) => {
      if (new URL(url).pathname.startsWith("/private/")) throw new RobotsDeniedError(url);
    });

    await expect(
      navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/js", 5000, { checkRobots }),
    ).rejects.toThrow(RobotsDeniedError);
  });

  it("同一オリジンの転送先がrobots.txtで拒否された場合もナビゲーションが失敗する", async () => {
    const page = new FakePage();
    page.redirects.set("http://93.184.216.34/go", "http://93.184.216.34/private/secret");
    const checkRobots = vi.fn(async (url: string) => {
      if (new URL(url).pathname.startsWith("/private/")) throw new RobotsDeniedError(url);
    });

    await expect(
      navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/go", 5000, { checkRobots }),
    ).rejects.toThrow(RobotsDeniedError);
  });

  it("着地先がrobots.txtで拒否された場合はナビゲーションが失敗する", async () => {
    const page = new FakePage();
    page.redirects.set("http://93.184.216.34/a", "http://8.8.8.8/blocked");
    const checkRobots = vi.fn(async (url: string) => {
      throw new RobotsDeniedError(url);
    });

    await expect(
      navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/a", 5000, { checkRobots }),
    ).rejects.toThrow(RobotsDeniedError);
  });

  it("checkRobots未指定なら従来通りSSRF検証のみで通過する(後方互換)", async () => {
    const page = new FakePage();
    page.redirects.set("http://93.184.216.34/a", "http://8.8.8.8/c");

    const { response } = await navigateSafely(page as unknown as import("playwright").Page, "http://93.184.216.34/a", 5000);

    expect(response?.status()).toBe(200);
  });
});

describe("navigateSafely - 読み込みの待ち方", () => {
  const asPage = (page: FakePage) => page as unknown as import("playwright").Page;

  it("通信が途切れないページ(networkidle が来ない)でも、load の後に短く待って中身を返す", async () => {
    const page = new FakePage();
    page.networkNeverIdle = true;

    const { response } = await navigateSafely(asPage(page), "http://93.184.216.34/", 15_000);

    expect(response?.status()).toBe(200);
    expect(page.loadStateWaits.map((wait) => wait.state)).toEqual(["load", "networkidle"]);
    expect(page.loadStateWaits[1]!.timeout).toBeLessThanOrEqual(5_000);
  });

  it("応答ヘッダが届いた時点(commit)で止まり、bot 対策の確認画面なら読み込みを待たずに失敗する", async () => {
    const page = new FakePage();
    page.responseHeaders = { "cf-mitigated": "challenge" };

    await expect(navigateSafely(asPage(page), "http://93.184.216.34/", 15_000)).rejects.toThrow(BotChallengeError);
    expect(page.gotoOptions[0]).toMatchObject({ waitUntil: "commit" });
    expect(page.loadStateWaits).toEqual([]);
  });

  it("load が来ないときは、ブラウザの読み込みのタイムアウトとして HTTP のタイムアウトと区別できる文言にする", async () => {
    const page = new FakePage();
    page.loadNeverFires = true;

    const error = await navigateSafely(asPage(page), "http://93.184.216.34/", 15_000).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FetchTimeoutError);
    expect(error).toMatchObject({ stage: "browser" });
    expect((error as Error).message).toContain("ブラウザで開いたページの読み込み");
    expect((error as Error).message).not.toContain("取得がタイムアウトしました");
  });
});
