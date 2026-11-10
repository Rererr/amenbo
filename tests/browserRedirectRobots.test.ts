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

const { BrowserUnavailableError, RobotsDeniedError } = await import("../src/errors.js");
const { closeBrowser, fetchWithBrowser, getBrowser } = await import("../src/fetcher/browser.js");
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
    if (path === "/a") return void res.writeHead(301, { location: "/b" }).end();
    if (path === "/b") return void res.writeHead(307, { location: "/ok" }).end();
    if (path === "/js") return html(page("JS", `<script>location.href='/private/js'</script>`));
    if (path.startsWith("/private/")) return html(page(`SECRET${path}`));
    return html(page(`PAGE${path}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setAddressPolicyForTests(null);
  await closeBrowser();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

  itWithBrowser("許可されたパスだけを通る複数段のリダイレクトは、最後まで辿って本文を返す", async () => {
    const result = await fetchWithBrowser(`${origin}/a`, 10_000, { checkRobots: checkRobots() });

    expect(result.finalUrl).toBe(`${origin}/ok`);
    expect(result.html).toContain("PAGE/ok");
  }, 30_000);
});
