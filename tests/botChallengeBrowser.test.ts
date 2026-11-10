import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { BotChallengeError } from "../src/errors.js";
import { navigateSafely } from "../src/fetcher/browser.js";
import { setAddressPolicyForTests } from "../src/fetcher/http.js";

/**
 * 実ブラウザで、bot 対策の確認画面のスクリプトが先方へ要求を出せないこと(確認画面を解かせない方針)。
 * 要求を個別に止める方式では、ポップアップ・pagehideのsendBeacon・speculation rules・WebSocket・Service Workerが
 * 届いた(実測)。確認画面の本文をレンダラーへ渡さないので、どの経路も始まらないことを、経路ごとに確かめる。
 * SSRF検証プロキシはループバックを遮断するので、プロキシ無しで起動したブラウザに navigateSafely を当てる。
 */

async function launchBrowser(): Promise<Browser | null> {
  for (const options of [{ channel: "chrome" }, {}]) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch {
      // システムのChromeが無ければ同梱のChromiumを、それも無ければこのテストを飛ばす。
    }
  }
  return null;
}

const VECTORS: Record<string, string> = {
  inline: `<script>fetch('/ran-inline')</script><img src="/img"><script>location.href='/solved'</script>`,
  popup: `<script>window.open('/popup')</script>`,
  pagehideBeacon: `<script>addEventListener('pagehide', () => navigator.sendBeacon('/pagehide-beacon'))</script>`,
  speculation: `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["/spec-prefetch"]}],"prerender":[{"source":"list","urls":["/spec-prerender"]}]}</script>`,
  webSocket: `<script>try{new WebSocket('ws://'+location.host+'/ws')}catch(e){}</script>`,
  serviceWorker: `<script>navigator.serviceWorker && navigator.serviceWorker.register('/sw.js').catch(()=>{})</script>`,
};

const browser = await launchBrowser();
const hits: string[] = [];
const server: Server = createServer((req, res) => {
  const path = req.url ?? "";
  hits.push(path);
  const cf = /^\/challenge\/(\w+)$/.exec(path);
  if (cf) {
    res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    res.end(`<html><head>${VECTORS[cf[1]!] ?? ""}</head><body>challenge</body></html>`);
    return;
  }
  if (path === "/slow-challenge") {
    res.writeHead(202, { "content-type": "text/html", "x-amzn-waf-action": "challenge" });
    res.write(`<html><head><script>fetch('/ran-early')</script></head>`);
    setTimeout(() => res.end(`<body><img src="/img-late"></body></html>`), 300);
    return;
  }
  if (path === "/sw.js") {
    res.writeHead(200, { "content-type": "text/javascript" }).end("fetch('/from-service-worker')");
    return;
  }
  res.writeHead(404).end();
});
server.on("upgrade", (req, socket) => {
  hits.push(`upgrade ${req.url}`);
  socket.destroy();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
setAddressPolicyForTests(() => false);

afterAll(async () => {
  setAddressPolicyForTests(null);
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const itWithBrowser = browser ? it : it.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ポップアップの要求も検証する(実ブラウザ)", () => {
  itWithBrowser("ページが window.open で開いたポップアップの要求も、SSRF の検証で止める", async () => {
    // 予約アドレスへのポップアップを作るため、拒否する側のサーバーを IPv6 のループバックに置く。
    const blockedHits: string[] = [];
    const blocked: Server = createServer((req, res) => {
      blockedHits.push(req.url ?? "");
      res.writeHead(200).end("reached");
    });
    const listened = await new Promise<boolean>((resolve) => {
      blocked.once("error", () => resolve(false));
      blocked.listen(0, "::1", () => resolve(true));
    });
    if (!listened) return; // IPv6のループバックが無い環境では確かめられない
    const blockedPort = (blocked.address() as AddressInfo).port;
    const opener: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end(`<html><body>ok<script>window.open('http://[::1]:${blockedPort}/popup')</script></body></html>`);
    });
    await new Promise<void>((resolve) => opener.listen(0, "127.0.0.1", resolve));
    setAddressPolicyForTests((address) => address === "::1");
    const context = await browser!.newContext();
    try {
      const page = await context.newPage();
      await navigateSafely(page, `http://127.0.0.1:${(opener.address() as AddressInfo).port}/`, 10_000);
      await sleep(1000);
      expect(blockedHits).toEqual([]);
    } finally {
      await context.close();
      setAddressPolicyForTests(() => false);
      await new Promise<void>((resolve) => opener.close(() => resolve()));
      await new Promise<void>((resolve) => blocked.close(() => resolve()));
    }
  }, 30_000);
});

describe("確認画面のスクリプトを先方へ届かせない(実ブラウザ)", () => {
  itWithBrowser.each([...Object.keys(VECTORS).map((name) => `/challenge/${name}`), "/slow-challenge"])(
    "%s: 失敗の時点でも、待っても、contextを閉じた後も、確認画面の文書のほかは何も先方へ届かない",
    async (path) => {
      hits.length = 0;
      // Service Workerは本番(openPageAndNavigate)では登録させないが、ここでは本文を渡さないことだけで止まるかを見る。
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        const error = await navigateSafely(page, `${origin}${path}`, 10_000).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BotChallengeError);
        expect(hits).toEqual([path]);
        // 残りの本文とスクリプト(ポップアップ・Service Worker・先読み)が動く時間を与える。
        await sleep(1500);
        expect(hits).toEqual([path]);
      } finally {
        await context.close();
      }
      // 閉じるとき(pagehide)に出る要求も見る。
      await sleep(700);
      expect(hits).toEqual([path]);
    },
    30_000,
  );
});
