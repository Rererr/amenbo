import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { HttpStatusError, NetworkError, PrivateAddressError, TooManyRedirectsError } from "../src/errors.js";
import { navigateSafely } from "../src/fetcher/browser.js";
import { httpGet, setAddressPolicyForTests } from "../src/fetcher/http.js";
import { closeSharedSsrfProxy, getSharedSsrfProxyUrl } from "../src/fetcher/ssrfProxy.js";

/**
 * 症状の違う失敗を、利用者(LLM)が見分けられる文言にする。同じ文言だと、取り直すべきか・
 * 報告すべきかの判断を誤らせる(SSRFの拒否をサイトの403と、転送のループを存在しないステータスと取り違える)。
 */

afterAll(async () => {
  setAddressPolicyForTests(null);
  await closeSharedSsrfProxy();
});

describe("転送の上限超過", () => {
  it("存在しないステータス(310)の HTTP エラーでなく、転送のループと分かる専用のエラーにする", async () => {
    const server: Server = createServer((req, res) => res.writeHead(302, { Location: `/loop${Number(req.url?.slice(5) || 0) + 1}` }).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    setAddressPolicyForTests(() => false);
    try {
      const error = await httpGet(`http://127.0.0.1:${(server.address() as AddressInfo).port}/loop0`).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TooManyRedirectsError);
      expect(error).not.toBeInstanceOf(HttpStatusError);
      expect((error as Error).message).toContain("リダイレクトが上限(5回)を超えました");
      expect((error as Error).message).not.toContain("310");
    } finally {
      setAddressPolicyForTests(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("HTTP/2 の説明句の無いステータス", () => {
  it("「HTTPエラー(403 )」のような空欄を作らない", () => {
    expect(new HttpStatusError("https://example.com/", 403, "").message).toContain("HTTPエラー(403): ");
  });
});

describe("NetworkError.fromBrowserNavigation - Playwright の net::ERR_*", () => {
  it.each([
    ["net::ERR_NAME_NOT_RESOLVED", "dns"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "tls"],
    ["net::ERR_SSL_PROTOCOL_ERROR", "tls"],
    ["net::ERR_CONNECTION_REFUSED", "connection"],
    ["net::ERR_CONNECTION_RESET", "connection"],
    ["net::ERR_TUNNEL_CONNECTION_FAILED", "connection"],
    ["net::ERR_HTTP2_PROTOCOL_ERROR", "connection"],
    ["net::ERR_EMPTY_RESPONSE", "connection"],
    ["net::ERR_ABORTED", "unknown"],
  ])("%s は %s に分類する", (code, kind) => {
    const error = NetworkError.fromBrowserNavigation("https://example.com/", new Error(`page.goto: ${code} at https://example.com/\nCall log:\n  - navigating`));

    expect(error?.kind).toBe(kind);
    expect(error?.message).toContain(code);
    expect(error?.message).toContain("ブラウザでの接続に失敗しました");
    // 既にブラウザで失敗しているので、ブラウザ経由の再試行は案内しない。
    expect(error?.message).not.toContain("mode: screenshot");
    // Playwright の複数行の呼び出しログを LLM へ流さない。
    expect(error?.message).not.toContain("Call log");
  });

  it("net::ERR_* を含まない失敗は null(呼び出し側が元の例外を投げ直す)", () => {
    expect(NetworkError.fromBrowserNavigation("https://example.com/", new Error("Target page, context or browser has been closed"))).toBeNull();
  });
});

/** 転送の段を止める CDP の Fetch ドメインの代わり(ここでは転送の段を起こさないので受けるだけ)。 */
const fakeCdpSession = {
  on: () => {},
  send: async (method: string) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main-frame" } } } : {}),
  detach: async () => {},
};

/** navigateSafely に渡す最小の Page。goto は与えた失敗か応答を返す。 */
function fakePage(goto: () => Promise<unknown>, landedUrl: string) {
  return {
    mainFrame: () => ({}),
    context: () => ({ newCDPSession: async () => fakeCdpSession }),
    route: async () => {},
    unroute: async () => {},
    waitForLoadState: async () => {},
    goto,
    url: () => landedUrl,
  } as unknown as import("playwright").Page;
}

/** 共有の SSRF 検証プロキシへ生の要求を1本送り、拒否させる(ブラウザが送るのと同じ形)。 */
async function sendThroughSharedProxy(requestText: string): Promise<void> {
  const proxyUrl = new URL(await getSharedSsrfProxyUrl());
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(proxyUrl.port), "127.0.0.1", () => socket.write(requestText));
    socket.once("data", () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
  });
}

describe("ブラウザ経路での SSRF 検証プロキシの拒否", () => {
  it("HTTPS(CONNECT)の拒否は、トンネルの接続失敗でなく予約アドレスの拒否として返す", async () => {
    // 事前検証(guardPublicAddress)を通った後に、接続時の再解決で予約アドレスと判定された状況を作る。
    setAddressPolicyForTests(() => false);
    await sendThroughSharedProxy("CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n");
    const page = fakePage(async () => {
      throw new Error("page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://169.254.169.254/");
    }, "");

    await expect(navigateSafely(page, "https://169.254.169.254/latest", 5000)).rejects.toThrow(PrivateAddressError);
  });

  it("平文 HTTP の拒否(プロキシの403)は、サイトの403でなく予約アドレスの拒否として返す", async () => {
    setAddressPolicyForTests(() => false);
    await sendThroughSharedProxy("GET http://10.0.0.1/ HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n");
    const page = fakePage(async () => ({ status: () => 403, statusText: () => "Forbidden", headers: () => ({}) }), "http://10.0.0.1/");

    await expect(navigateSafely(page, "http://10.0.0.1/", 5000)).rejects.toThrow(PrivateAddressError);
  });

  it("プロキシが拒否していないホストの403は、従来どおりサイトの HTTP エラー", async () => {
    setAddressPolicyForTests(() => false);
    const page = fakePage(async () => ({ status: () => 403, statusText: () => "Forbidden", headers: () => ({}) }), "http://93.184.216.34/");

    await expect(navigateSafely(page, "http://93.184.216.34/", 5000)).rejects.toThrow(HttpStatusError);
  });
});
