import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PageCache } from "../src/cache.js";
import { setAddressPolicyForTests } from "../src/fetcher/http.js";
import { formatLinksResponse } from "../src/formatting.js";
import { discoverLinks, parseLlmsTxt } from "../src/links.js";
import { PolitenessManager } from "../src/politeness.js";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * links の出典(sitemap・フィード・ページ・llms.txt)を、ローカルのフィクスチャサーバーと一時キャッシュで確かめる。
 * 見るのは先方への到着回数(filter を変えて呼び直しても取り直さない、知らされていない llms.txt を探しに行かない)と、
 * 読めなかった出典を黙らずに応答へ出すこと。
 */

interface Site {
  robots: string;
  routes: Record<string, { status?: number; headers?: Record<string, string>; body: string | Buffer }>;
}

const hits = new Map<string, number>();
let site: Site = { robots: "", routes: {} };
let origin = "";

const server: Server = createServer((req, res) => {
  const path = req.url ?? "/";
  hits.set(path, (hits.get(path) ?? 0) + 1);
  if (path === "/robots.txt") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end(site.robots.replaceAll("__ORIGIN__", origin));
    return;
  }
  const route = site.routes[path];
  if (!route) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }
  const body = typeof route.body === "string" ? route.body.replaceAll("__ORIGIN__", origin) : route.body;
  res.writeHead(route.status ?? 200, route.headers ?? {}).end(body);
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-links-sources-"));
const cache = new PageCache({ cacheDir });
// robots.txt はオリジンごとに覚えるので、サイトの形を変えるテストごとに作り直す(afterEach)。
let politeness = new PolitenessManager({ minIntervalMs: 0, sleep: async () => {} });

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setAddressPolicyForTests(() => false);
});

afterEach(() => {
  politeness = new PolitenessManager({ minIntervalMs: 0, sleep: async () => {} });
  hits.clear();
  delete process.env.AMENBO_MAX_BODY_BYTES;
});

afterAll(async () => {
  setAddressPolicyForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupCacheDir(cacheDir, () => cache.close());
});

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?><urlset>
<url><loc>__ORIGIN__/blog/1</loc></url><url><loc>__ORIGIN__/blog/2</loc></url><url><loc>__ORIGIN__/news/1</loc></url></urlset>`;

function page(head: string, body = '<a href="/a">A</a>'): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>起点</title>${head}</head><body>${body}</body></html>`;
}

/** 呼び出しごとに別のパスにして、前のテストのキャッシュを踏まないようにする。 */
let sequence = 0;
function fresh(path: string): string {
  sequence++;
  return `${path}${path.includes("?") ? "&" : "?"}t=${sequence}`;
}

describe("出典のキャッシュ", () => {
  it("filter を変えて3回呼んでも、sitemap の取得は1回", async () => {
    const sitemapPath = fresh("/sitemap.xml");
    site = { robots: `User-agent: *\nAllow: /\nSitemap: __ORIGIN__${sitemapPath}\n`, routes: { [sitemapPath]: { headers: { "Content-Type": "application/xml" }, body: SITEMAP } } };
    const start = `${origin}${fresh("/")}`;

    const all = await discoverLinks(start, politeness, { cache });
    const blog = await discoverLinks(start, politeness, { cache, filter: "blog" });
    const news = await discoverLinks(start, politeness, { cache, filter: "news" });

    expect(all.links).toHaveLength(3);
    expect(blog.links).toHaveLength(2);
    expect(news.links).toHaveLength(1);
    expect(hits.get(sitemapPath)).toBe(1);
  });

  it("sitemap が無い(404)サイトでも、2回目以降は sitemap・ページ・フィードを取り直さない", async () => {
    const pagePath = fresh("/index.html");
    const feedPath = fresh("/feed.xml");
    site = {
      robots: "User-agent: *\nAllow: /\n",
      routes: {
        [pagePath]: { headers: { "Content-Type": "text/html; charset=utf-8" }, body: page(`<link rel="alternate" type="application/rss+xml" href="${feedPath}">`) },
        [feedPath]: {
          headers: { "Content-Type": "application/rss+xml" },
          body: `<rss><channel><item><title>記事1</title><link>__ORIGIN__/p/1</link></item><item><title>記事2</title><link>__ORIGIN__/p/2</link></item></channel></rss>`,
        },
      },
    };
    const start = `${origin}${pagePath}`;

    for (const filter of [undefined, "1", "2"]) {
      const result = await discoverLinks(start, politeness, { cache, ...(filter ? { filter } : {}) });
      expect(result.source).toBe("rss");
    }

    expect(hits.get("/sitemap.xml")).toBe(1);
    expect(hits.get(pagePath)).toBe(1);
    expect(hits.get(feedPath)).toBe(1);
  });

  it("no-store の sitemap は保存せず、次の呼び出しで取り直す", async () => {
    const sitemapPath = fresh("/sitemap.xml");
    site = {
      robots: `User-agent: *\nAllow: /\nSitemap: __ORIGIN__${sitemapPath}\n`,
      routes: { [sitemapPath]: { headers: { "Content-Type": "application/xml", "Cache-Control": "no-store" }, body: SITEMAP } },
    };
    const start = `${origin}${fresh("/")}`;

    await discoverLinks(start, politeness, { cache });
    await discoverLinks(start, politeness, { cache });

    expect(hits.get(sitemapPath)).toBe(2);
  });
});

describe("gzip の sitemap", () => {
  it("robots.txt が宣言した .xml.gz を展開して読む", async () => {
    const sitemapPath = fresh("/sitemap.xml.gz");
    site = {
      robots: `User-agent: *\nAllow: /\nSitemap: __ORIGIN__${sitemapPath}\n`,
      routes: { [sitemapPath]: { headers: { "Content-Type": "application/x-gzip" }, body: gzipSync(Buffer.from(SITEMAP.replaceAll("__ORIGIN__", "https://example.com"))) } },
    };

    const result = await discoverLinks(`${origin}${fresh("/")}`, politeness, { cache });

    expect(result.source).toBe("sitemap");
    expect(result.links.map((link) => link.url)).toContain("https://example.com/blog/2");
    expect(result.warnings).toBeUndefined();
  });

  it.each([
    ["展開後の大きさが上限を超える(gzip 爆弾)", () => gzipSync(Buffer.alloc(2_000_000, 0x20)), "上限(100000バイト)を超えました"],
    ["壊れている", () => Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]), "gzipを展開できませんでした"],
  ])("%s gzip は読めなかったことを応答に出し、ページのリンクへ進む", async (_label, body, reason) => {
    process.env.AMENBO_MAX_BODY_BYTES = "100000";
    const sitemapPath = fresh("/sitemap.xml.gz");
    const pagePath = fresh("/index.html");
    site = {
      robots: `User-agent: *\nAllow: /\nSitemap: __ORIGIN__${sitemapPath}\n`,
      routes: {
        [sitemapPath]: { headers: { "Content-Type": "application/gzip" }, body: body() },
        [pagePath]: { headers: { "Content-Type": "text/html; charset=utf-8" }, body: page("") },
      },
    };
    const start = `${origin}${pagePath}`;

    const result = await discoverLinks(start, politeness, { cache });
    const text = formatLinksResponse(start, result);

    expect(result.source).toBe("page");
    expect(text).toContain(`warning: sitemapを読めませんでした: ${origin}${sitemapPath}`);
    expect(text).toContain(reason);
  });
});

describe("llms.txt", () => {
  const LLMS_TXT = `# Docs\n\n> サイトの要約\n\n## Docs\n\n- [Quickstart](/docs/quickstart.md): 最初の一歩\n- [API](https://example.com/docs/api.md)\n- [Bad](javascript:alert(1)): 除く\n`;

  it("起点のページが知らせていれば llms.txt を出典にし、説明を名前に続ける", async () => {
    const pagePath = fresh("/docs");
    const llmsPath = fresh("/llms.txt");
    site = {
      robots: "User-agent: *\nAllow: /\n",
      routes: {
        [pagePath]: { headers: { "Content-Type": "text/html; charset=utf-8", Link: `<${llmsPath}>; rel="llms-txt"` }, body: page("") },
        [llmsPath]: { headers: { "Content-Type": "text/plain; charset=utf-8" }, body: LLMS_TXT },
      },
    };
    const start = `${origin}${pagePath}`;

    const result = await discoverLinks(start, politeness, { cache });
    const again = await discoverLinks(start, politeness, { cache, filter: "最初" });

    expect(result.source).toBe("llms.txt");
    expect(result.links).toEqual([
      { url: `${origin}/docs/quickstart.md`, title: "Quickstart: 最初の一歩" },
      { url: "https://example.com/docs/api.md", title: "API" },
    ]);
    expect(again.links.map((link) => link.title)).toEqual(["Quickstart: 最初の一歩"]);
    expect(hits.get(llmsPath)).toBe(1);
  });

  it("fetch で取ったページが知らせていたと分かっていれば、sitemap より先に llms.txt を使い、sitemap は取らない", async () => {
    const sitemapPath = fresh("/sitemap.xml");
    const llmsPath = fresh("/llms.txt");
    site = {
      robots: `User-agent: *\nAllow: /\nSitemap: __ORIGIN__${sitemapPath}\n`,
      routes: {
        [sitemapPath]: { headers: { "Content-Type": "application/xml" }, body: SITEMAP },
        [llmsPath]: { headers: { "Content-Type": "text/markdown" }, body: LLMS_TXT },
      },
    };
    const start = `${origin}${fresh("/docs")}`;
    cache.set({ url: start, etag: null, lastModified: null, markdown: "# 起点", metadata: { agentResources: { markdownAlternate: null, llmsTxt: `${origin}${llmsPath}` } } });

    const result = await discoverLinks(start, politeness, { cache });

    expect(result.source).toBe("llms.txt");
    expect(hits.get(sitemapPath)).toBeUndefined();
  });

  it("知らされていなければ llms.txt を探しに行かない", async () => {
    const pagePath = fresh("/plain");
    site = { robots: "User-agent: *\nAllow: /\n", routes: { [pagePath]: { headers: { "Content-Type": "text/html; charset=utf-8" }, body: page("") }, "/llms.txt": { body: LLMS_TXT } } };

    const result = await discoverLinks(`${origin}${pagePath}`, politeness, { cache });

    expect(result.source).toBe("page");
    expect(hits.get("/llms.txt")).toBeUndefined();
  });

  it("parseLlmsTxt は一覧の行だけを読み、http(s) 以外の URL を除く", () => {
    expect(parseLlmsTxt(LLMS_TXT, "https://example.com/llms.txt").map((link) => link.url)).toEqual([
      "https://example.com/docs/quickstart.md",
      "https://example.com/docs/api.md",
    ]);
  });
});
