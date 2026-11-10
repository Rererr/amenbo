import { describe, expect, it, vi } from "vitest";
import { RobotsDeniedError } from "../src/errors.js";
import { navigateSafely } from "../src/fetcher/browser.js";

/**
 * route は context に掛けるので、ページが開いたポップアップの最初のナビゲーション要求も handler に届く。
 * その要求はフレームが作られる前に届き、Playwright の request.frame() は例外を投げる(CI の実ブラウザで発生)。
 * 実ブラウザの時機に頼らず、frame() が投げる要求を作って、例外にならずに検証が効くことを確かめる。
 */

type Listener = (value: unknown) => void;
type FakeRoute = { continue(): Promise<void>; abort(): Promise<void> };
type RouteHandler = (route: FakeRoute, request: unknown) => Promise<void>;

function controllablePage() {
  const listeners = new Map<string, Set<Listener>>();
  const mainFrame = {};
  let handler: RouteHandler | null = null;
  let finishGoto: (value: unknown) => void = () => {};
  const page = {
    mainFrame: () => mainFrame,
    context: () => ({
      newCDPSession: async () => ({
        on: () => {},
        send: async (method: string) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main-frame" } } } : {}),
        detach: async () => {},
      }),
      route: async (_pattern: string, routeHandler: RouteHandler) => {
        handler = routeHandler;
      },
      unroute: async () => {},
    }),
    on: (event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off: (event: string, listener: Listener) => listeners.get(event)?.delete(listener),
    waitForLoadState: async () => {},
    goto: () => new Promise((resolve) => (finishGoto = resolve)),
    url: () => "http://93.184.216.34/",
  };
  return {
    page: page as unknown as import("playwright").Page,
    handler: () => handler!,
    emit: (event: string, value: unknown) => listeners.get(event)?.forEach((listener) => listener(value)),
    finishGoto: (value: unknown) => finishGoto(value),
    mainFrame,
  };
}

/** フレームが作られる前のナビゲーション要求(ポップアップの最初の要求)。frame() は実物と同じく例外を投げる。 */
function popupNavigation(url: string) {
  return {
    url: () => url,
    isNavigationRequest: () => true,
    frame: () => {
      throw new Error("Frame for this navigation request is not available, because the request was issued before the frame is created.");
    },
  };
}

function recordingRoute() {
  const outcome: string[] = [];
  const route: FakeRoute = { continue: async () => void outcome.push("continue"), abort: async () => void outcome.push("abort") };
  return { route, outcome };
}

const OK_RESPONSE = { status: () => 200, statusText: () => "OK", headers: () => ({}) };

async function startNavigation(checkRobots?: (url: string) => Promise<void>) {
  const fake = controllablePage();
  const navigation = navigateSafely(fake.page, "http://93.184.216.34/", 5000, checkRobots ? { checkRobots } : {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { fake, navigation };
}

describe("navigateSafely - フレームがまだ無いナビゲーション要求(ポップアップの最初の要求)", () => {
  it("例外にならず、SSRF と robots.txt の検証を通れば送る", async () => {
    const checkRobots = vi.fn(async () => {});
    const { fake, navigation } = await startNavigation(checkRobots);
    const { route, outcome } = recordingRoute();

    await fake.handler()(route, popupNavigation("http://93.184.216.35/popup"));

    expect(outcome).toEqual(["continue"]);
    expect(checkRobots).toHaveBeenCalledWith("http://93.184.216.35/popup");
    fake.finishGoto(OK_RESPONSE);
    await expect(navigation).resolves.toMatchObject({ response: OK_RESPONSE });
  });

  it("robots.txt が拒否するポップアップは送らず、元のページの取得は失敗させない", async () => {
    const checkRobots = vi.fn(async (url: string) => {
      if (url.endsWith("/popup")) throw new RobotsDeniedError(url);
    });
    const { fake, navigation } = await startNavigation(checkRobots);
    const { route, outcome } = recordingRoute();

    await fake.handler()(route, popupNavigation("http://93.184.216.35/popup"));

    expect(outcome).toEqual(["abort"]);
    fake.finishGoto(OK_RESPONSE);
    const result = await navigation;
    expect(() => result.assertNotBlocked()).not.toThrow();
  });

  it("予約アドレスへのポップアップは送らない", async () => {
    const { fake, navigation } = await startNavigation();
    const { route, outcome } = recordingRoute();

    await fake.handler()(route, popupNavigation("http://10.0.0.1/popup"));

    expect(outcome).toEqual(["abort"]);
    fake.finishGoto(OK_RESPONSE);
    await navigation;
  });

  it("確認画面の後は、ポップアップの要求も送らない", async () => {
    const { fake, navigation } = await startNavigation();
    const mainRequest = { url: () => "http://93.184.216.34/", isNavigationRequest: () => true, frame: () => fake.mainFrame };
    fake.emit("response", { request: () => mainRequest, headers: () => ({ "cf-mitigated": "challenge" }) });
    const { route, outcome } = recordingRoute();

    await fake.handler()(route, popupNavigation("http://93.184.216.35/popup"));

    expect(outcome).toEqual(["abort"]);
    fake.finishGoto({ status: () => 403, statusText: () => "Forbidden", headers: () => ({ "cf-mitigated": "challenge" }) });
    await navigation.catch(() => {});
  });

  it("ポップアップの要求で request イベントと response イベントが来ても例外にならない", async () => {
    const { fake, navigation } = await startNavigation();
    const popup = popupNavigation("http://93.184.216.35/popup");

    expect(() => fake.emit("request", popup)).not.toThrow();
    expect(() => fake.emit("response", { request: () => popup, headers: () => ({}) })).not.toThrow();
    fake.finishGoto(OK_RESPONSE);
    await navigation;
  });
});
