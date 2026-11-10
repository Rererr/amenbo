import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * bot 対策の確認画面(Cloudflare の cf-mitigated: challenge、AWS WAF の x-amzn-waf-action)を、
 * ステータスに関係なく失敗として返し、ブラウザへ昇格させないこと。
 * 昇格すると確認画面のスクリプトがブラウザで走り、意図せず通過しうる(bot 対策を回避しない方針)。
 */

const { fetchWithBrowserMock } = vi.hoisted(() => ({ fetchWithBrowserMock: vi.fn() }));
vi.mock("../src/fetcher/browser.js", () => ({ fetchWithBrowser: fetchWithBrowserMock }));

const { fetchPage } = await import("../src/fetcher/index.js");
const { setAddressPolicyForTests, detectBotChallenge } = await import("../src/fetcher/http.js");
const { BotChallengeError, HttpStatusError } = await import("../src/errors.js");

const CHALLENGE_HTML = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body><noscript>Please enable JavaScript and cookies to continue</noscript><div id="root"></div></body></html>`;

const responses: Record<string, { status: number; headers: Record<string, string>; body: string }> = {
  "/cf-200": { status: 200, headers: { "cf-mitigated": "challenge" }, body: CHALLENGE_HTML },
  "/cf-403": { status: 403, headers: { "cf-mitigated": "challenge" }, body: CHALLENGE_HTML },
  "/waf-202": { status: 202, headers: { "x-amzn-waf-action": "challenge" }, body: "" },
  "/waf-405": { status: 405, headers: { "x-amzn-waf-action": "captcha" }, body: CHALLENGE_HTML },
  "/cf-429": { status: 429, headers: { "cf-mitigated": "challenge", "retry-after": "120" }, body: CHALLENGE_HTML },
  "/spa": { status: 200, headers: {}, body: CHALLENGE_HTML },
};

const server: Server = createServer((req, res) => {
  const response = responses[req.url ?? ""];
  if (!response) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(response.status, { "Content-Type": "text/html; charset=utf-8", ...response.headers });
  res.end(response.body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
setAddressPolicyForTests(() => false);

afterAll(async () => {
  setAddressPolicyForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fetchWithBrowserMock.mockReset().mockResolvedValue({ finalUrl: `${origin}/spa`, html: "<p>rendered</p>", status: 200, geometry: null });
});

describe("HTTP 経路の bot 対策の確認画面", () => {
  it.each([
    ["/cf-200", "cf-mitigated: challenge", 200],
    ["/cf-403", "cf-mitigated: challenge", 403],
    ["/waf-202", "x-amzn-waf-action: challenge", 202],
    ["/waf-405", "x-amzn-waf-action: captcha", 405],
  ])("%s は確認画面の失敗になり、ブラウザへ昇格しない", async (path, marker, status) => {
    const error = await fetchPage(`${origin}${path}`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BotChallengeError);
    expect(error).toMatchObject({ marker, status });
    expect((error as Error).message).toContain("確認画面");
    expect(fetchWithBrowserMock).not.toHaveBeenCalled();
  });

  it("回数制限(429・Retry-After)は確認画面の印があっても、断られた失敗としてホストを止める側に倒す", async () => {
    const error = await fetchPage(`${origin}/cf-429`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({ status: 429, isRefusal: true });
  });

  it("印の無い同じ画面は、従来どおり SPA と判定してブラウザへ昇格する(印だけで判定している)", async () => {
    await fetchPage(`${origin}/spa`);

    expect(fetchWithBrowserMock).toHaveBeenCalledTimes(1);
  });
});

describe("detectBotChallenge", () => {
  it.each([
    [{ "cf-mitigated": "challenge" }, "cf-mitigated: challenge"],
    [{ "x-amzn-waf-action": "captcha" }, "x-amzn-waf-action: captcha"],
    [{ "cf-mitigated": "none" }, null],
    [{}, null],
  ])("%o → %s", (headers: Record<string, string>, expected) => {
    expect(detectBotChallenge((name) => headers[name])).toBe(expected);
  });
});
