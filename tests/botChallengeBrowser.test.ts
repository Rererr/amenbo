import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { BotChallengeError } from "../src/errors.js";
import { navigateSafely } from "../src/fetcher/browser.js";
import { setAddressPolicyForTests } from "../src/fetcher/http.js";

/**
 * 実ブラウザで、bot 対策の確認画面のスクリプトが先方へ要求を出せないこと(確認画面を解かせない方針)。
 * waitUntil: "commit" の時点でもHTMLの解析は始まりうるため、応答を見た時点で以後の要求を止める必要がある。
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

const browser = await launchBrowser();
const hits: string[] = [];
const server: Server = createServer((req, res) => {
  hits.push(req.url ?? "");
  if (req.url === "/challenge") {
    res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    res.end(`<html><head><script>fetch('/ran-inline')</script></head><body><img src="/img"><script>location.href='/solved'</script></body></html>`);
    return;
  }
  if (req.url === "/slow-challenge") {
    res.writeHead(202, { "content-type": "text/html", "x-amzn-waf-action": "challenge" });
    res.write(`<html><head><script>fetch('/ran-early')</script></head>`);
    setTimeout(() => res.end(`<body><img src="/img-late"></body></html>`), 300);
    return;
  }
  res.writeHead(404).end();
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

describe("確認画面のスクリプトを先方へ届かせない(実ブラウザ)", () => {
  itWithBrowser.each(["/challenge", "/slow-challenge"])(
    "%s: 失敗の時点でも、その後しばらく待っても、確認画面の文書以外の要求は先方へ届かない",
    async (path) => {
      hits.length = 0;
      const context = await browser!.newContext();
      try {
        const page = await context.newPage();
        const error = await navigateSafely(page, `${origin}${path}`, 10_000).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BotChallengeError);
        expect(hits).toEqual([path]);
        // 閉じる前に残りの本文とスクリプトが流れる時間を与える。
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(hits).toEqual([path]);
      } finally {
        await context.close();
      }
    },
    30_000,
  );
});
