import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ブラウザ経路のリダイレクトと、ページ内からの遷移で、robots.txtが拒否するパスを取らないこと(実Chromium)。
 * page.routeのhandlerはリダイレクトのホップでは呼ばれないため、フェイクでは確かめられない(実機で確認済み)。
 */

// ループバックはSSRF検証プロキシが断るので、このテストの間だけプロキシを通さずに届かせる(ブラウザ起動前に設定する)。
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";

const { BrowserUnavailableError, FetchTimeoutError, RobotsDeniedError } = await import("../src/errors.js");
const { closeBrowser, fetchWithBrowser, getBrowser, openPageAndNavigate } = await import("../src/fetcher/browser.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");
const { PolitenessManager } = await import("../src/politeness.js");

let browser: Browser | null = null;
try {
  browser = await getBrowser();
} catch (error) {
  if (!(error instanceof BrowserUnavailableError)) throw error;
}

const itWithBrowser = browser ? it : it.skip;
const arrivals: string[] = [];
let server: Server;
let origin: string;
/** 別オリジン(別のポート)。robots.txt の応答を遅らせられる。 */
const otherArrivals: string[] = [];
let otherRobotsDelayMs = 0;
let other: Server;
let otherOrigin: string;

const page = (marker: string, head = "") =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${marker}</title>${head}</head><body><article><h1>${marker}</h1><p>${marker}</p></article></body></html>`;

beforeAll(async () => {
  setAddressPolicyForTests(() => false);
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    arrivals.push(path);
    const html = (body: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    if (path === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private/\n");
      return;
    }
    if (path === "/go") return void res.writeHead(302, { location: "/private/secret" }).end();
    if (path === "/to-other") return void res.writeHead(302, { location: `${otherOrigin}/fine` }).end();
    if (path === "/a") return void res.writeHead(301, { location: "/b" }).end();
    if (path === "/b") return void res.writeHead(307, { location: "/ok" }).end();
    if (path === "/js") return html(page("JS", `<script>location.href='/private/js'</script>`));
    if (path.startsWith("/private/")) return html(page(`SECRET${path}`));
    return html(page(`PAGE${path}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  other = createServer((req, res) => {
    const path = req.url ?? "/";
    otherArrivals.push(path);
    if (path === "/robots.txt") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /private/\n");
      }, otherRobotsDelayMs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(path.startsWith("/private/") ? `SECRET${path}` : `OTHER${path}`));
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setAddressPolicyForTests(null);
  await closeBrowser();
  for (const s of [server, other]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function checkRobots() {
  return new PolitenessManager({ sleep: async () => {} }).robotsCheckForThisCall();
}

describe("ブラウザ経路のrobots.txt確認(実Chromium)", () => {
  itWithBrowser("同一オリジン内のリダイレクトでDisallowのパスへ誘導されたら、転送先へ送らずに拒否する", async () => {
    arrivals.length = 0;

    await expect(fetchWithBrowser(`${origin}/go`, 10_000, { checkRobots: checkRobots() })).rejects.toThrow(RobotsDeniedError);
    expect(arrivals).not.toContain("/private/secret");
  }, 30_000);

  itWithBrowser("ページ内からの遷移でDisallowのパスへ誘導されたら、エラー画面を返さず拒否する", async () => {
    arrivals.length = 0;

    await expect(fetchWithBrowser(`${origin}/js`, 10_000, { checkRobots: checkRobots() })).rejects.toThrow(RobotsDeniedError);
    expect(arrivals).not.toContain("/private/js");
  }, 30_000);

  itWithBrowser("gotoが返った後のページ内の遷移も、contextを閉じるまでrobots.txtで止めて、理由を返せる", async () => {
    arrivals.length = 0;
    const navigation = await openPageAndNavigate(`${origin}/plain`, 10_000, {}, { checkRobots: checkRobots() });
    try {
      expect(() => navigation.assertNotBlocked()).not.toThrow();
      // 読み込みが終わった後で、ページのスクリプトが遷移する(setTimeoutでの遷移と同じ)
      await navigation.page.evaluate(() => {
        location.href = "/private/late";
      });
      let blocked: unknown = null;
      for (let i = 0; i < 100 && blocked === null; i++) {
        try {
          navigation.assertNotBlocked();
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (error) {
          blocked = error;
        }
      }
      expect(blocked).toBeInstanceOf(RobotsDeniedError);
      expect(arrivals).not.toContain("/private/late");
    } finally {
      await navigation.context.close();
    }
  }, 30_000);

  itWithBrowser("転送の段の判定の途中で時間切れになったら、その段を後から送らない", async () => {
    otherRobotsDelayMs = 3_000;
    otherArrivals.length = 0;
    const startedAt = Date.now();
    try {
      await expect(fetchWithBrowser(`${origin}/to-other`, 1_000, { checkRobots: checkRobots() })).rejects.toThrow(FetchTimeoutError);
      expect(Date.now() - startedAt).toBeLessThan(otherRobotsDelayMs); // robots.txt の判定を待たずに戻る
      await new Promise((resolve) => setTimeout(resolve, otherRobotsDelayMs + 500)); // 判定が終わった後まで見る
      expect(otherArrivals).toEqual(["/robots.txt"]);
    } finally {
      otherRobotsDelayMs = 0;
    }
  }, 30_000);

  itWithBrowser("許可されたパスだけを通る複数段のリダイレクトは、最後まで辿って本文を返す", async () => {
    const result = await fetchWithBrowser(`${origin}/a`, 10_000, { checkRobots: checkRobots() });

    expect(result.finalUrl).toBe(`${origin}/ok`);
    expect(result.html).toContain("PAGE/ok");
  }, 30_000);
});
