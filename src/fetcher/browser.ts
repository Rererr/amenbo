/**
 * fetcher/browser.ts — Playwrightで起動する共有ブラウザインスタンス(システムのChrome優先、無ければ同梱Chromium)。
 *
 * 二段フェッチ(fetcher/index.ts)でSPAと判定された場合のみ起動する遅延初期化。
 * プロセス終了シグナルでクリーンアップする。
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request,
  type Response as PlaywrightResponse,
  type Route,
} from "playwright";
import { AmenboError, BrowserLaunchError, BrowserUnavailableError, FetchTimeoutError, InvalidUrlError, NetworkError, PrivateAddressError } from "../errors.js";
import type { PageGeometrySnapshot } from "../extract/geometry.js";
import { CONSENT_BANNER_RULES } from "../jp/consentBanner.js";
import { assertUsableResponse, detectBotChallenge, guardPublicAddress, USER_AGENT } from "./http.js";
import { closeSharedSsrfProxy, getSharedSsrfProxyUrl, takeRecentProxyBlock, type ProxyBlock } from "./ssrfProxy.js";

export type { PageGeometrySnapshot } from "../extract/geometry.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** load の後に networkidle(500msの無通信)を待つ上限。来なくても読み込みは済んでいるので先へ進む。 */
const NETWORK_IDLE_WAIT_MS = 5_000;

let browserPromise: Promise<Browser> | null = null;
let cleanupRegistered = false;

/**
 * システムのGoogle Chromeを使えない場合にplaywright-coreが投げるエラーメッセージのパターン。
 * 未インストール("... is not found at ...")と、Chromeの配布先として定義の無いOS
 * ("... is not supported on freebsd"等。linux/darwin/win32以外)の両方を含む。
 */
const SYSTEM_CHROME_UNAVAILABLE_PATTERN = /Chromium distribution 'chrome' is not (found|supported)/;

function isSystemChromeUnavailableError(error: unknown): boolean {
  return error instanceof Error && SYSTEM_CHROME_UNAVAILABLE_PATTERN.test(error.message);
}

/**
 * Chromium遅延化(§4)対応: 同梱chromiumが未インストール(`npx -y amenbo install-browser`未実行)の場合、
 * playwright-coreは"Executable doesn't exist at ..."とインストール手順(`playwright install`)を
 * 含むメッセージを投げる(node_modules/playwright-core/lib/coreBundle.jsで確認)。単一の文字列に
 * 頼るとメッセージ文言の些細な変更や偶然の一致で誤判定しうるため、2つの既知マーカーが両方
 * 含まれる場合のみ「未インストール」と判定する(それ以外の起動失敗は汎用のBrowserLaunchErrorのまま扱う)。
 */
const CHROMIUM_MISSING_MARKERS = [/Executable doesn't exist/, /playwright install/];

function isMissingChromiumExecutableError(error: unknown): boolean {
  return error instanceof Error && CHROMIUM_MISSING_MARKERS.every((pattern) => pattern.test(error.message));
}

/**
 * M2: 以前はcleanup内でclose後にprocess.exit()を呼んでおらず、chromium起動後は
 * SIGINTの既定動作(即終了)がこのリスナーに上書きされたままハングしていた
 * (closeBrowser()はPromiseを返すだけで、'exit'イベントは同期処理しか待てないため
 * 実質何もせず終了していた)。close完了を待ってから明示的にprocess.exit()する。
 */
function registerCleanupHandlers(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const shutdown = (): void => {
    void closeBrowser().finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/**
 * 共有ブラウザインスタンスを取得する(未起動なら遅延起動)。
 *
 * システムのGoogle Chromeを優先し、使えない環境に限り同梱Chromiumを使う。同梱Chromiumは
 * Playwrightの版に固定されたベータ相当のビルドで、Chrome安定版のセキュリティ修正が届かない
 * (任意の外部ページを開くamenboでは古いビルドがそのまま攻撃面になる)。どちらもOSの
 * サンドボックスを有効にして起動する(Playwrightの既定は--no-sandbox)。
 */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    registerCleanupHandlers();
    const promise: Promise<Browser> = startBrowser().then(
      (browser) => {
        // 常駐MCPでブラウザが落ちた(OOM kill・パッケージ更新による実行ファイルの置き換え等)後も
        // 死んだインスタンスを返し続けないよう、次の呼び出しで起動し直させる。
        browser.on("disconnected", () => {
          if (browserPromise === promise) browserPromise = null;
        });
        return browser;
      },
      (cause: unknown) => {
        // 失敗中にcloseBrowser→getBrowserで始まった別の起動を消さないよう、自分の起動の場合だけ戻す。
        if (browserPromise === promise) browserPromise = null;
        throw cause;
      },
    );
    browserPromise = promise;
  }
  return browserPromise;
}

async function startBrowser(): Promise<Browser> {
  // C2(browser tier): 全リクエストをSSRF検証プロキシ経由にする。Chromiumがホスト名を自前で
  // 解決せずプロキシへ委ねるため、事前検証と実接続の間のDNS rebinding(TOCTOU)を塞げる。
  let proxyServer: string;
  try {
    proxyServer = await getSharedSsrfProxyUrl();
  } catch (cause) {
    throw new BrowserLaunchError(`SSRF検証プロキシを起動できませんでした(${firstLine(cause)})`, { cause });
  }

  const options = { headless: true, chromiumSandbox: true, proxy: { server: proxyServer } };
  try {
    return await chromium.launch({ ...options, channel: "chrome" });
  } catch (cause) {
    // Chromeはあるが起動に失敗した場合は同梱Chromiumへ黙って切り替えない(古いビルドで
    // 動き続けると、利用者は失敗の原因にも安全性の低下にも気づけない)。
    if (!isSystemChromeUnavailableError(cause)) {
      throw new BrowserLaunchError(describeLaunchFailure("システムのGoogle Chrome", cause), { cause });
    }
  }
  try {
    return await chromium.launch(options);
  } catch (cause) {
    if (isMissingChromiumExecutableError(cause)) {
      throw new BrowserUnavailableError({ cause });
    }
    throw new BrowserLaunchError(describeLaunchFailure("同梱Chromium", cause), { cause });
  }
}

/** playwright-coreが"No usable sandbox!"等のサンドボックス起動失敗を書き換えた先頭行。 */
const SANDBOX_FAILURE_MARKER = "Chromium sandboxing failed!";

/**
 * 起動失敗の理由と対処を利用者向けの文言にする(呼び出し側はcauseを表示しないため、ここで要点を含める)。
 * サンドボックスを無効にして起動し直す道は用意しない(任意の外部ページを開くamenboでは、
 * 無効化がそのまま利用者のユーザー権限での任意コード実行につながるため)。
 */
function describeLaunchFailure(browserLabel: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes(SANDBOX_FAILURE_MARKER)) {
    return (
      `${browserLabel}をOSのサンドボックス付きで起動できませんでした。` +
      "rootで実行している場合は一般ユーザーで実行してください。" +
      "ユーザー名前空間を制限している環境(Ubuntu 23.10以降の既定など)では、その利用を許可する設定が必要です"
    );
  }
  return `${browserLabel}の起動に失敗しました(${firstLine(cause)})`;
}

function firstLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split("\n").find((line) => line.trim() !== "")?.trim() ?? "原因不明";
}

/** 共有ブラウザインスタンスを終了する(プロセス終了時・使われなくなったとき・テストのクリーンアップ用)。 */
export async function closeBrowser(): Promise<void> {
  clearIdleTimer();
  const promise = browserPromise;
  browserPromise = null;
  if (promise) {
    try {
      const browser = await promise;
      await browser.close();
    } catch {
      // 起動に失敗していた場合等は無視(既にクローズ済み/未起動)
    }
  }
  // ブラウザを閉じた後にSSRF検証プロキシも停止する(開いているとプロセスが終了できずハングする)。
  // 閉じている間に次の取得が新しいブラウザを起動していたら、そのブラウザが使うので止めない。
  if (browserPromise === null) await closeSharedSsrfProxy();
}

/**
 * 最後にブラウザで開いてから、これだけ使わなければブラウザを閉じる。常駐のMCPサーバーでは、
 * 一度起動したChromeがプロセスの寿命いっぱい(実環境で約4日、約200MB)残っていた。
 * 次にブラウザを使うときは起動し直すので、その分の時間を払う。
 */
const BROWSER_IDLE_CLOSE_MS = 5 * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleClose(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void closeIdleBrowser();
  }, BROWSER_IDLE_CLOSE_MS);
  // この待ちのためだけにプロセスを生かさない(stdinが閉じたら終われるようにする)。
  idleTimer.unref();
}

async function closeIdleBrowser(): Promise<void> {
  const promise = browserPromise;
  const browser = await promise?.catch(() => null);
  if (!browser || browserPromise !== promise) return;
  // ページを開いたままの取得(撮影の途中など)があれば、閉じずに待ち直す。
  if (browser.contexts().length > 0) {
    scheduleIdleClose();
    return;
  }
  await closeBrowser();
}

export interface BrowserFetchResult {
  finalUrl: string;
  html: string;
  status: number;
  geometry: PageGeometrySnapshot;
}

// ---- Phase 4: ジオメトリ抽出用のデータ採取(型はextract/geometry.tsを正とする) ----

const EMPTY_GEOMETRY: PageGeometrySnapshot = { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 };

/**
 * Phase 4 ジオメトリ抽出用に、テキストを直接持つリーフ要素の bounding box・フォントサイズ・
 * 可視性と、表/canvas/svgの bounding box を採取する。
 *
 * 対象要素には一時属性 `data-amenbo-gid` を付与する。これは page.content() 呼び出し前に
 * 実行することで、後段の抽出処理(extract/markdown.ts, linkedomでの再パース)が
 * 同じ要素をCSSセレクタで再選択できるようにするため(ブラウザとNode間でDOM参照を
 * 直接受け渡せないので、属性経由で紐付ける)。
 */
export async function collectPageGeometry(page: Page): Promise<PageGeometrySnapshot> {
  return page.evaluate(() => {
    const leafSelector = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, figcaption";
    const textBlocks: Array<{ id: number; x: number; y: number; width: number; height: number; textLength: number }> = [];
    let gid = 0;

    for (const el of Array.from(document.querySelectorAll(leafSelector))) {
      const text = (el.textContent ?? "").trim();
      if (text.length < 2) continue;

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      gid++;
      el.setAttribute("data-amenbo-gid", String(gid));
      textBlocks.push({
        id: gid,
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        textLength: text.length,
      });
    }

    const visualElements: Array<{ tag: string; x: number; y: number; width: number; height: number }> = [];
    for (const el of Array.from(document.querySelectorAll("table, canvas, svg"))) {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      visualElements.push({
        tag: el.tagName.toLowerCase(),
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }

    return {
      textBlocks,
      visualElements,
      pageWidth: Math.ceil(document.documentElement.scrollWidth),
      pageHeight: Math.ceil(document.documentElement.scrollHeight),
    };
  });
}

// page.evaluate内でNode側のRegExpを参照できないため、判定定義を引数で渡す。
export async function hideConsentBanners(page: Page): Promise<number> {
  return page.evaluate(
    ({ textPatterns, idClassPattern, maxTextLength }) => {
      const textRegexes = textPatterns.map(({ source, flags }) => new RegExp(source, flags));
      const idClassRegex = new RegExp(idClassPattern.source, idClassPattern.flags);

      let hidden = 0;
      const candidates = Array.from(document.querySelectorAll("div, section, aside, dialog"));
      for (const el of candidates) {
        const text = el.textContent ?? "";
        if (text.length === 0 || text.length > maxTextLength) continue;

        const idClassMatch = idClassRegex.test(`${el.id} ${el.className}`);
        const textMatch = textRegexes.some((pattern) => pattern.test(text));
        if (!(idClassMatch && textMatch)) continue;

        const style = window.getComputedStyle(el);
        const isOverlayish = style.position === "fixed" || style.position === "sticky" || Number(style.zIndex || "0") >= 100;

        if (isOverlayish) {
          (el as HTMLElement).style.setProperty("display", "none", "important");
          hidden++;
        }
      }
      return hidden;
    },
    CONSENT_BANNER_RULES,
  );
}

// ---- C1/C2: SSRFガード付きナビゲーション ----

const NAVIGATION_ROUTE_PATTERN = "**/*";

/**
 * サブリソース/サブフレームのリクエストURLをSSRF検証する。
 *
 * data:/blob:/about: 等ネットワークアクセスを伴わないスキーム(インライン画像・CSS等)は許可し、
 * file: はローカルファイル読み取り防止のため遮断、http(s)は埋め込みIPが予約アドレスでないか検証する。
 * 同一ホストへの繰り返し(ページ自身のホストやCDN等)でDNS解決を重複させないよう、
 * 1回のナビゲーション内はホスト単位で検証結果(Promise)を使い回す。
 */
function guardRequestUrl(rawUrl: string, hostGuardCache: Map<string, Promise<void>>): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return Promise.reject(new InvalidUrlError(rawUrl, "リクエストURLの形式が不正です"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    if (parsed.protocol === "file:") {
      return Promise.reject(new InvalidUrlError(rawUrl, "サブリソースのfile:スキームは許可されません"));
    }
    return Promise.resolve();
  }
  const key = `${parsed.protocol}//${parsed.host}`;
  let cached = hostGuardCache.get(key);
  if (!cached) {
    cached = guardPublicAddress(rawUrl);
    hostGuardCache.set(key, cached);
  }
  return cached;
}

/**
 * C1: browser.ts(fetchWithBrowser)・screenshot.ts(captureTiledScreenshot)は
 * fetcher/http.tsのSSRF/スキーム検証(guardPublicAddress)を経由せずpage.goto()していたため、
 * `file:///etc/passwd` や `http://169.254.169.254/...` が素通りしていた。
 *
 * 対応:
 *   1. page.goto()の前にguardPublicAddressで初回遷移先を検証する
 *   2. context.route()で全リクエストを横取りし、以下を検証する:
 *      - メインフレームのナビゲーション(初回遷移・ページ内からの遷移): guardPublicAddressで
 *        再検証し、private/予約アドレスやhttp(s)以外のスキームは実接続前にabort。型付きエラー
 *        (PrivateAddressError/InvalidUrlError)へ変換してgoto()の失敗を報告する。
 *      - サブフレーム(iframe)のナビゲーション・サブリソース(img/xhr/fetch等): 同様にSSRF検証し、
 *        private/予約アドレス・file:へのリクエストはabortする(呼び出しは失敗させず該当リクエストのみ遮断)。
 *
 * サブフレーム/サブリソースも検証対象に含めるのは、攻撃者ページが `<iframe src=http://169.254.169.254/...>`
 * を埋め込んでスクリーンショットに内部情報を写し込む(同一オリジンポリシーを迂回した情報窃取)、
 * あるいは no-cors fetch で内部サービスへ副作用付きリクエストを送る、といった browser tier 経由の
 * SSRF を塞ぐため。
 *
 *   3. メインフレームのリダイレクトの各ホップは、CDPのFetchドメインで送る前に止めて、1と同じ検証と
 *      robots.txtの確認をする(page.routeのhandlerはリダイレクトのホップでは呼ばれない。実測)。
 *
 * robots.txtで確かめるのはメインフレームの遷移だけで、サブフレーム(iframe)とサブリソースの遷移・リダイレクトは
 * 確かめない(ページ自体が許可されていれば、その部品として読み込むものとして扱う)。サブフレームとサブリソースの
 * リダイレクト先のSSRFは、全通信を通す検証プロキシ(ssrfProxy.ts)が塞ぐ。
 *
 * 完全なTOCTOU対策(fetcher/http.tsのssrfSafeLookupのような接続時点での検証)は
 * Playwright側では現実的に組み込めないため、遷移前検証+リクエスト時の再検証という
 * 「可能な範囲」の対策にとどめる。
 */
export async function navigateSafely(
  page: Page,
  url: string,
  timeoutMs: number,
  options: SafeNavigationOptions = {},
): Promise<SafeNavigation> {
  await guardPublicAddress(url);

  let blockedError: AmenboError | null = null;
  let lastMainFrameUrl = url;
  let challengeSeen = false;
  const hostGuardCache = new Map<string, Promise<void>>();
  const isMainFrame = (request: Request): boolean => request.isNavigationRequest() && request.frame() === page.mainFrame();
  // routeのhandlerは転送の最初のURLでしか呼ばれない(実測)ので、転送のたびに発火するrequestで着地先を追う。
  const onRequest = (request: Request): void => {
    if (isMainFrame(request)) lastMainFrameUrl = request.url();
  };
  // 確認画面の応答を見たら、以後の要求(スクリプトのfetch・sendBeacon・画像・解いた後の遷移)をすべて止める。
  // 応答ヘッダの時点で旗を立てるので、HTMLの解析が始まって出る要求より先に立つ(実測で、これらは先方へ届かなかった)。
  // WebSocketはrouteを通らないので止められない(実測で、確認画面のスクリプトが開いたWebSocketの接続要求は届いた)。
  // routeWebSocketで止める案は、通常のページのWebSocketまでPlaywright経由の中継に変え、その接続がSSRF検証
  // プロキシを通るかを確かめていないため入れていない。
  const onResponse = (response: PlaywrightResponse): void => {
    if (!isMainFrame(response.request())) return;
    const headers = response.headers();
    if (detectBotChallenge((name) => headers[name])) challengeSeen = true;
  };
  const handler = async (route: Route, request: Request): Promise<void> => {
    if (challengeSeen) {
      await route.abort();
      return;
    }
    const requestUrl = request.url();
    const isMainFrameNavigation = isMainFrame(request);
    try {
      if (isMainFrameNavigation) {
        await guardPublicAddress(requestUrl);
        // ページ内からの遷移も、同一オリジンを含めて確かめる。レート制御の待機はタイムアウト予算を消費するため、ここでは行わない。
        if (options.checkRobots) {
          await options.checkRobots(requestUrl);
        }
      } else {
        await guardRequestUrl(requestUrl, hostGuardCache);
      }
      // 検証を待つ間に確認画面と分かった場合も、先方へ送らない。
      if (challengeSeen) {
        await route.abort();
        return;
      }
      await route.continue();
    } catch (error) {
      // メインフレームの遷移失敗のみgoto()の失敗として型付きエラーで報告する。サブフレーム/
      // サブリソースの遮断はページ全体を失敗させず、該当リクエストのabortにとどめる(ブラウザが
      // 読み込めないリソースをスキップするのと同じ挙動)。
      if (isMainFrameNavigation) {
        blockedError = error instanceof AmenboError ? error : new InvalidUrlError(requestUrl, "ナビゲーション検証に失敗しました");
      }
      await route.abort();
    }
  };

  const stopGuardingRedirects = await guardMainFrameRedirects(
    page,
    options.checkRobots,
    (error) => {
      blockedError = error;
    },
    () => challengeSeen,
  );
  await page.route(NAVIGATION_ROUTE_PATTERN, handler);
  // ページ内からの遷移(location.href・meta refresh)を止めると、gotoは成功したままエラー画面に置き換わる。
  const assertNotBlocked = (): void => {
    if (blockedError) throw blockedError as AmenboError;
  };
  const deadline = Date.now() + timeoutMs;
  const remainingMs = (): number => Math.max(1, deadline - Date.now());
  let responded = false;
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    // 応答ヘッダが届いた時点(commit)で止まり、エラーと bot 対策の確認画面を読み込みを待たずに弾く。
    // commitの時点でもHTMLの解析とインラインのスクリプトは始まりうる(実測)。先方へ要求が出ないのは、
    // 上のonResponseが以後の要求を止めるためで、ここでの判定は失敗として返すためのもの。
    const response = await page.goto(url, { waitUntil: "commit", timeout: timeoutMs });
    responded = true;
    assertNotBlocked();
    if (response) {
      const headers = response.headers();
      const status = response.status();
      const proxyBlock = status === 403 ? takeRecentProxyBlock(new URL(page.url()).hostname) : null;
      if (proxyBlock) throw proxyBlockedError(page.url(), proxyBlock);
      // HTTP経路(httpGet)と同じく、400以上と bot 対策の確認画面は失敗にする(取得成功として返さないため)。
      assertUsableResponse(page.url(), { status, statusText: response.statusText(), ok: status < 400 }, (name) => headers[name]);
    }
    await page.waitForLoadState("load", { timeout: remainingMs() });
    // 解析のビーコンやロングポーリングで通信が途切れないページは networkidle が来ない。中身は読めているので、
    // 短く待って来なければそのまま進む(networkidleを必須にすると、読めたページを毎回タイムアウトにする)。
    await page.waitForLoadState("networkidle", { timeout: Math.min(NETWORK_IDLE_WAIT_MS, remainingMs()) }).catch(() => {});
    assertNotBlocked();
    // 成功しても検証は外さない。gotoが返った後のページ内の遷移も止めるため(外すのはcontextを閉じるとき)。
    return { response, assertNotBlocked };
  } catch (cause) {
    // 先にCDPで止めている段を失敗させる。判定の途中で時間切れになった段を、後から送らせないため。
    await stopGuardingRedirects();
    // 確認画面のときは止める handler を外さない。外すと、閉じるまでの間に確認画面のスクリプトの要求が先方へ届く(実測)。
    if (!challengeSeen) await page.unroute(NAVIGATION_ROUTE_PATTERN, handler).catch(() => {});
    assertNotBlocked();
    if (cause instanceof AmenboError) throw cause;
    if (cause instanceof Error && /timeout/i.test(cause.message)) {
      throw new FetchTimeoutError(url, timeoutMs, responded ? "browser" : "browser-response");
    }
    const proxyBlock =
      cause instanceof Error && cause.message.includes("ERR_TUNNEL_CONNECTION_FAILED") ? takeRecentProxyBlock(new URL(lastMainFrameUrl).hostname) : null;
    if (proxyBlock) throw proxyBlockedError(lastMainFrameUrl, proxyBlock);
    throw NetworkError.fromBrowserNavigation(lastMainFrameUrl, cause) ?? cause;
  }
}

/**
 * 事前検証を通った後、ブラウザの接続時の再解決(SSRF検証プロキシ)で接続を拒否した。
 * 予約アドレスならSSRFの拒否、名前解決できなければHTTP経路と同じDNSの失敗にする。
 */
function proxyBlockedError(url: string, block: ProxyBlock): AmenboError {
  return block.blocked === "private" ? new PrivateAddressError(url, block.address) : NetworkError.dnsFailure(url);
}

export interface SafeNavigation {
  response: PlaywrightResponse | null;
  /**
   * 遷移の検証が止めた遷移があれば、その理由で投げる。検証はcontextを閉じるまで働くので、本文や画像を
   * 返す直前にも呼ぶ(gotoが返った後のページ内の遷移が止められると、ページはエラー画面に置き換わっている)。
   */
  assertNotBlocked(): void;
}

/**
 * メインフレームのリダイレクトの各ホップを、送る前にSSRF検証とrobots.txtの確認にかける。
 * 拒否したホップは送らずに失敗させ、onBlockedで理由を渡す。戻り値は止めるのをやめる関数で、そのとき判定の途中の
 * ホップは送らずに失敗させる。
 */
async function guardMainFrameRedirects(
  page: Page,
  checkRobots: ((url: string) => Promise<void>) | undefined,
  onBlocked: (error: AmenboError) => void,
  /** trueを返す間は、止めた文書の要求をすべて送らずに失敗させる(bot 対策の確認画面の後)。 */
  isStopped: () => boolean,
): Promise<() => Promise<void>> {
  const session = await page.context().newCDPSession(page);
  const { frameTree } = await session.send("Page.getFrameTree");
  const mainFrameId = frameTree.frame.id;
  const checking = new Set<string>();
  // 送る前にページが閉じられていれば続ける先が無いので、失敗は無視してよい。
  const fail = (requestId: string) => session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
  session.on("Fetch.requestPaused", (event) => {
    void (async () => {
      if (isStopped()) {
        await fail(event.requestId);
        return;
      }
      const hopUrl = event.request.url;
      if (event.frameId === mainFrameId && event.redirectedRequestId !== undefined) {
        checking.add(event.requestId);
        try {
          await guardPublicAddress(hopUrl);
          await checkRobots?.(hopUrl);
        } catch (error) {
          onBlocked(error instanceof AmenboError ? error : new InvalidUrlError(hopUrl, "リダイレクト先の検証に失敗しました"));
          await fail(event.requestId);
          return;
        } finally {
          checking.delete(event.requestId);
        }
      }
      if (isStopped()) {
        await fail(event.requestId);
        return;
      }
      await session.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
    })();
  });
  await session.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
  return async () => {
    await Promise.all([...checking].map(fail));
    await session.detach().catch(() => {});
  };
}

export interface BrowserNavigation extends SafeNavigation {
  context: BrowserContext;
  page: Page;
}

export interface SafeNavigationOptions {
  /**
   * メインフレームの遷移(初回・リダイレクトの各ホップ・ページ内からの遷移)ごとに呼ばれるrobots.txt確認
   * (fetcher/http.tsのHttpGetOptions.checkRobotsと同じ役割)。拒否時はそのまま伝播する。
   */
  checkRobots?: ((url: string) => Promise<void>) | undefined;
}

/** 共有ブラウザでcontext/pageを作りnavigateSafelyでナビゲーションする。失敗時はcontextを閉じて投げ直す。 */
export async function openPageAndNavigate(
  url: string,
  timeoutMs: number,
  contextOptions: BrowserContextOptions = {},
  navigationOptions: SafeNavigationOptions = {},
): Promise<BrowserNavigation> {
  const browser = await getBrowser();
  scheduleIdleClose();
  // Service Workerはナビゲーションを横取りして、遷移の検証を通らない応答(robots.txtが拒否するページ等)を返せる。
  // 取得のためのブラウザには要らないので登録させない。
  const context = await browser.newContext({ ...contextOptions, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    const { response, assertNotBlocked } = await navigateSafely(page, url, timeoutMs, navigationOptions);
    return { context, page, response, assertNotBlocked };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/** Playwrightでページをレンダリングし、レンダリング後のHTMLを取得する。 */
export async function fetchWithBrowser(
  url: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  navigationOptions: SafeNavigationOptions = {},
): Promise<BrowserFetchResult> {
  const { context, page, response, assertNotBlocked } = await openPageAndNavigate(url, timeoutMs, { userAgent: USER_AGENT }, navigationOptions);
  try {
    await hideConsentBanners(page).catch(() => {
      // ページ評価に失敗しても取得自体は継続する(ベストエフォート)
    });
    // Phase 4: ジオメトリ抽出用のデータ採取(data-amenbo-gid付与)は、それがHTMLへ反映される
    // page.content()より必ず先に行う
    const geometry = await collectPageGeometry(page).catch(() => EMPTY_GEOMETRY);
    const html = await page.content();
    assertNotBlocked();
    return { finalUrl: page.url(), html, status: response?.status() ?? 200, geometry };
  } finally {
    await context.close();
  }
}
