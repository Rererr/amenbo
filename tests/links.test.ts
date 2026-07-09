import { beforeEach, describe, expect, it, vi } from "vitest";

const httpGetMock = vi.fn();
const fetchPageMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args),
  };
});

vi.mock("../src/fetcher/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/index.js")>();
  return {
    ...actual,
    fetchPage: (...args: Parameters<typeof actual.fetchPage>) => fetchPageMock(...args),
  };
});

const { PolitenessManager } = await import("../src/politeness.js");
const { discoverLinks } = await import("../src/links.js");

function htmlResult(html: string, status = 200) {
  return { finalUrl: "http://example.com/", status, headers: new Headers(), html, encoding: "UTF-8" };
}

function notFound() {
  return { finalUrl: "http://example.com/robots.txt", status: 404, headers: new Headers(), html: "", encoding: "" };
}

beforeEach(() => {
  httpGetMock.mockReset();
  fetchPageMock.mockReset();
});

function makePoliteness() {
  return new PolitenessManager({ sleep: async () => {} });
}

describe("discoverLinks - sitemap優先", () => {
  it("robots.txtが宣言するsitemapからURLを列挙する(source=sitemap)", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return htmlResult("Sitemap: http://example.com/sitemap.xml\n");
      if (url === "http://example.com/sitemap.xml") {
        return htmlResult(`<?xml version="1.0"?><urlset><url><loc>http://example.com/a</loc></url><url><loc>http://example.com/b</loc></url></urlset>`);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.source).toBe("sitemap");
    expect(result.links.map((l) => l.url)).toEqual(["http://example.com/a", "http://example.com/b"]);
    expect(fetchPageMock).not.toHaveBeenCalled();
  });

  it("sitemapindexの場合は子sitemapを辿って合算する", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return htmlResult("Sitemap: http://example.com/sitemap-index.xml\n");
      if (url === "http://example.com/sitemap-index.xml") {
        return htmlResult(
          `<?xml version="1.0"?><sitemapindex><sitemap><loc>http://example.com/sitemap-1.xml</loc></sitemap><sitemap><loc>http://example.com/sitemap-2.xml</loc></sitemap></sitemapindex>`,
        );
      }
      if (url === "http://example.com/sitemap-1.xml") {
        return htmlResult(`<urlset><url><loc>http://example.com/p1</loc></url></urlset>`);
      }
      if (url === "http://example.com/sitemap-2.xml") {
        return htmlResult(`<urlset><url><loc>http://example.com/p2</loc></url></urlset>`);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.source).toBe("sitemap");
    expect(result.links.map((l) => l.url).sort()).toEqual(["http://example.com/p1", "http://example.com/p2"]);
  });

  it("robots.txtにSitemap宣言が無ければ慣例パス/sitemap.xmlを試す", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return htmlResult("User-agent: *\nDisallow:\n");
      if (url === "http://example.com/sitemap.xml") {
        return htmlResult(`<urlset><url><loc>http://example.com/conventional</loc></url></urlset>`);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.source).toBe("sitemap");
    expect(result.links.map((l) => l.url)).toEqual(["http://example.com/conventional"]);
  });

  it("同一URLの重複はまとめる", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return htmlResult("Sitemap: http://example.com/sitemap.xml\n");
      if (url === "http://example.com/sitemap.xml") {
        return htmlResult(`<urlset><url><loc>http://example.com/a</loc></url><url><loc>http://example.com/a</loc></url></urlset>`);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.links).toHaveLength(1);
  });
});

describe("discoverLinks - RSS/Atomフォールバック", () => {
  it("sitemapが無ければページのlink[rel=alternate]からRSSを見つけて解析する(source=rss)", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url === "http://example.com/sitemap.xml") return notFound();
      if (url === "http://example.com/rss.xml") {
        return htmlResult(
          `<?xml version="1.0"?><rss><channel><item><link>http://example.com/post1</link><title>記事1</title></item><item><link>http://example.com/post2</link><title>記事2</title></item></channel></rss>`,
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    fetchPageMock.mockResolvedValue({
      finalUrl: "http://example.com/",
      html: `<html><head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head><body></body></html>`,
      tier: "http",
      status: 200,
      encoding: "UTF-8",
      etag: null,
      lastModified: null,
      escalationReason: null,
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.source).toBe("rss");
    expect(result.links).toEqual([
      { url: "http://example.com/post1", title: "記事1" },
      { url: "http://example.com/post2", title: "記事2" },
    ]);
  });

  it("RSSの<link>要素(void要素扱い問題)からURLを正しく取り出す", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url === "http://example.com/sitemap.xml") return notFound();
      if (url === "http://example.com/feed") {
        return htmlResult(`<rss><channel><item><link>http://example.com/x</link><title>X</title></item></channel></rss>`);
      }
      throw new Error(`unexpected url: ${url}`);
    });
    fetchPageMock.mockResolvedValue({
      finalUrl: "http://example.com/",
      html: `<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head></html>`,
      tier: "http",
      status: 200,
      encoding: "UTF-8",
      etag: null,
      lastModified: null,
      escalationReason: null,
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.links[0]?.url).toBe("http://example.com/x");
  });

  it("Atomフィードも解析する(source=rss)", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url === "http://example.com/sitemap.xml") return notFound();
      if (url === "http://example.com/atom.xml") {
        return htmlResult(
          `<?xml version="1.0"?><feed><entry><link href="http://example.com/entry1"/><title>エントリ1</title></entry></feed>`,
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });
    fetchPageMock.mockResolvedValue({
      finalUrl: "http://example.com/",
      html: `<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head></html>`,
      tier: "http",
      status: 200,
      encoding: "UTF-8",
      etag: null,
      lastModified: null,
      escalationReason: null,
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.source).toBe("rss");
    expect(result.links).toEqual([{ url: "http://example.com/entry1", title: "エントリ1" }]);
  });
});

describe("discoverLinks - ページ内リンク抽出(最終手段)", () => {
  it("sitemap/RSSどちらも無ければページ内の<a>リンクを抽出する(source=page)", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url === "http://example.com/sitemap.xml") return notFound();
      throw new Error(`unexpected url: ${url}`);
    });
    fetchPageMock.mockResolvedValue({
      finalUrl: "http://example.com/",
      html: `<html><body><a href="/page1">ページ1</a><a href="https://external.example/x">外部</a><a href="#top">アンカー</a></body></html>`,
      tier: "http",
      status: 200,
      encoding: "UTF-8",
      etag: null,
      lastModified: null,
      escalationReason: null,
    });

    const result = await discoverLinks("http://example.com/", makePoliteness());
    expect(result.source).toBe("page");
    expect(result.links).toEqual([
      { url: "http://example.com/page1", title: "ページ1" },
      { url: "https://external.example/x", title: "外部" },
    ]);
  });

  it("filter(部分一致)でURLまたはタイトルを絞り込む", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url === "http://example.com/sitemap.xml") return notFound();
      throw new Error(`unexpected url: ${url}`);
    });
    fetchPageMock.mockResolvedValue({
      finalUrl: "http://example.com/",
      html: `<html><body><a href="/blog/1">ブログ記事</a><a href="/about">会社概要</a></body></html>`,
      tier: "http",
      status: 200,
      encoding: "UTF-8",
      etag: null,
      lastModified: null,
      escalationReason: null,
    });

    const result = await discoverLinks("http://example.com/", makePoliteness(), { filter: "blog" });
    expect(result.links).toEqual([{ url: "http://example.com/blog/1", title: "ブログ記事" }]);
  });

  it("filter(glob)でURLを絞り込む", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return notFound();
      if (url === "http://example.com/sitemap.xml") return notFound();
      throw new Error(`unexpected url: ${url}`);
    });
    fetchPageMock.mockResolvedValue({
      finalUrl: "http://example.com/",
      html: `<html><body><a href="http://example.com/articles/1">記事1</a><a href="http://example.com/about">概要</a></body></html>`,
      tier: "http",
      status: 200,
      encoding: "UTF-8",
      etag: null,
      lastModified: null,
      escalationReason: null,
    });

    const result = await discoverLinks("http://example.com/", makePoliteness(), { filter: "*/articles/*" });
    expect(result.links).toEqual([{ url: "http://example.com/articles/1", title: "記事1" }]);
  });
});
