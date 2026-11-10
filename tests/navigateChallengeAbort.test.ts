import { describe, expect, it } from "vitest";
import { navigateSafely } from "../src/fetcher/browser.js";

/**
 * route の handler が要求の検証(SSRF)を待つ間に、メインフレームの応答で bot 対策の確認画面と分かったら、
 * 検証が通っても先方へ送らない。handler の入口の判定だけでは、検証を待つ間に立った旗を見落とす。
 */

type Listener = (value: unknown) => void;
type RouteHandler = (route: { continue(): Promise<void>; abort(): Promise<void> }, request: unknown) => Promise<void>;

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
    handler: () => handler,
    emit: (event: string, value: unknown) => listeners.get(event)?.forEach((listener) => listener(value)),
    finishGoto: (value: unknown) => finishGoto(value),
    mainFrame,
  };
}

describe("navigateSafely - 検証を待つ間に確認画面と分かった要求", () => {
  it("検証が通っても continue せず abort する", async () => {
    const fake = controllablePage();
    const navigation = navigateSafely(fake.page, "http://93.184.216.34/", 5000).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const handler = fake.handler();
    expect(handler).not.toBeNull();

    const outcome: string[] = [];
    const route = { continue: async () => void outcome.push("continue"), abort: async () => void outcome.push("abort") };
    const subresource = { url: () => "http://93.184.216.34/img.png", isNavigationRequest: () => false, frame: () => ({}) };
    const pending = handler!(route, subresource);
    // 検証(guardPublicAddress)の await の最中に、メインフレームの確認画面の応答が届く。
    const mainRequest = { url: () => "http://93.184.216.34/", isNavigationRequest: () => true, frame: () => fake.mainFrame };
    fake.emit("response", { request: () => mainRequest, headers: () => ({ "cf-mitigated": "challenge" }) });
    await pending;

    expect(outcome).toEqual(["abort"]);
    fake.finishGoto({ status: () => 403, statusText: () => "Forbidden", headers: () => ({ "cf-mitigated": "challenge" }) });
    await navigation;
  });
});
