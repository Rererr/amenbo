import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * ページが知らせる Markdown 版と llms.txt の在りかを応答の頭に示す。amenbo は自分では取りに行かない
 * (どれを読むかは呼び出し元が決める。先方への要求を増やさない)。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-agent-resources-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { findAgentResources, parseLinkHeader } = await import("../src/fetcher/agentResources.js");
const { handleFetchTool, cache } = await import("../src/core.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");

const BASE = "https://docs.example.com/guide/quickstart";

describe("findAgentResources", () => {
  it("Link ヘッダの Markdown 版と llms.txt(Mintlify の形)を読む", () => {
    const resources = findAgentResources({
      linkHeader: '</guide/quickstart.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="llms-txt", </llms-full.txt>; rel="llms-full-txt"',
      llmsTxtHeader: "/llms.txt",
      html: "<html><head></head><body></body></html>",
      baseUrl: BASE,
    });

    expect(resources).toEqual({ markdownAlternate: "https://docs.example.com/guide/quickstart.md", llmsTxt: "https://docs.example.com/llms.txt" });
  });

  it.each([
    ['<link rel="alternate" type="text/markdown" href="quickstart.md">', "https://docs.example.com/guide/quickstart.md"],
    ["<LINK REL='Alternate' TYPE='text/markdown; charset=utf-8' HREF='/q.md'>", "https://docs.example.com/q.md"],
    ['<link rel="alternate" type="text/x-markdown" href="/q.md">', "https://docs.example.com/q.md"],
    ['<link rel="alternate" type="application/rss+xml" href="/feed.xml">', null],
    ['<link rel="stylesheet" type="text/markdown" href="/q.md">', null],
    ['<link rel="alternate" type="text/markdown" href="javascript:alert(1)">', null],
  ])("HTML の %s から Markdown 版を読む → %s", (tag, expected) => {
    const resources = findAgentResources({ linkHeader: null, llmsTxtHeader: null, html: `<html><head>${tag}</head><body></body></html>`, baseUrl: BASE });
    expect(resources.markdownAlternate).toBe(expected);
  });

  it("X-Llms-Txt ヘッダと <link rel=\"llms-txt\"> も llms.txt として読む", () => {
    expect(findAgentResources({ linkHeader: null, llmsTxtHeader: "https://cdn.example.net/llms.txt", html: "", baseUrl: BASE }).llmsTxt).toBe(
      "https://cdn.example.net/llms.txt",
    );
    expect(findAgentResources({ linkHeader: null, llmsTxtHeader: null, html: '<head><link rel="llms-txt" href="/docs/llms.txt"></head>', baseUrl: BASE }).llmsTxt).toBe(
      "https://docs.example.com/docs/llms.txt",
    );
  });

  it("本文中(</head> より後)の <link> は見ない", () => {
    const html = '<html><head></head><body><link rel="alternate" type="text/markdown" href="/spoof.md"></body></html>';
    expect(findAgentResources({ linkHeader: null, llmsTxtHeader: null, html, baseUrl: BASE }).markdownAlternate).toBeNull();
  });

  it("印が無ければ何も返さない", () => {
    expect(findAgentResources({ linkHeader: '</style.css>; rel="preload"', llmsTxtHeader: null, html: "<p>x</p>", baseUrl: BASE })).toEqual({
      markdownAlternate: null,
      llmsTxt: null,
    });
  });
});

describe("parseLinkHeader", () => {
  it("引用符の中のカンマとセミコロンで区切らない", () => {
    const links = parseLinkHeader('</a.md>; rel="alternate"; title="a, b; c"; type="text/markdown", </b>; rel="next"');
    expect(links.map((link) => link.target)).toEqual(["/a.md", "/b"]);
    expect(links[0]!.params.get("title")).toBe("a, b; c");
    expect(links[0]!.params.get("type")).toBe("text/markdown");
  });

  it("細工された長い値でも時間が爆発しない", () => {
    const started = Date.now();
    parseLinkHeader(`${"<".repeat(200_000)}${'";'.repeat(100_000)}`);
    findAgentResources({ linkHeader: null, llmsTxtHeader: null, html: `<head>${'<link rel="'.repeat(50_000)}</head>`, baseUrl: BASE });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("fetch の応答", () => {
  const ARTICLE = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>手順</title>
<link rel="alternate" type="text/markdown" href="/guide.md"></head>
<body><article><h1>手順</h1>
<p>この段落は本文抽出の対象として扱われる程度の分量を持たせるための文章です。取得側がページの知らせる Markdown 版の在りかを応答の頭に示し、自分では取りに行かないことを確かめます。</p>
<h2>詳細</h2>
<p>短すぎる本文は品質が低いと判定され、描画を伴う取得へ切り替わることがあります。そうなると同じページへの取得が余分に発生するため、通常の記事と同程度の段落数を置いています。</p>
<p>内容そのものは検証結果に影響しませんが、抽出器が本文領域を安定して選べるように段落を複数置いています。</p>
</article></body></html>`;
  const hits = new Map<string, number>();
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("User-agent: *\nAllow: /\n");
      return;
    }
    if (path === "/guide") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Link: '</llms.txt>; rel="llms-txt"' }).end(ARTICLE);
      return;
    }
    res.writeHead(404).end();
  });
  let origin = "";

  afterAll(async () => {
    setAddressPolicyForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupCacheDir(cacheDir, () => cache.close());
  });

  async function fetchText(input: Parameters<typeof handleFetchTool>[0]): Promise<string> {
    const content = await handleFetchTool(input);
    return content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  }

  it("Markdown 版と llms.txt の在りかを1行ずつ示し、どちらも取りに行かない(キャッシュから返すときも示す)", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setAddressPolicyForTests(() => false);

    const first = await fetchText({ url: `${origin}/guide` });
    const outline = await fetchText({ url: `${origin}/guide`, mode: "outline" });

    for (const text of [first, outline]) {
      expect(text).toContain(`markdown_alternate: ${origin}/guide.md\n`);
      expect(text).toContain(`llms_txt: ${origin}/llms.txt\n`);
    }
    expect(outline).toContain("cache: fresh");
    expect(hits.get("/guide.md")).toBeUndefined();
    expect(hits.get("/llms.txt")).toBeUndefined();
  }, 30_000);
});
