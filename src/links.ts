/**
 * links.ts — linksツール。sitemap.xml / RSS・Atomフィード優先のリンク列挙。
 *
 * ページを舐めて全リンクを辿るのではなく、まずsitemap.xml/RSS・Atomフィードという
 * 「サイト側が既に用意した索引」を優先利用することで、収集先への負荷を最小化する
 * (plan.md §4「sitemap/RSSが在ればリンク探索はそちらを優先」)。
 *
 * 優先順位: robots.txt宣言のsitemap(→慣例パス`/sitemap.xml`) → ページの<link rel=alternate>
 * が指すRSS/Atomフィード → 最終手段としてページ内の<a>リンク抽出。
 */
import { parseHTML } from "linkedom";
import { HttpStatusError, PrivateAddressError, RobotsDeniedError, UnsupportedContentError } from "./errors.js";
import { fetchPage } from "./fetcher/index.js";
import { assertHttpScheme, httpGet } from "./fetcher/http.js";
import type { PolitenessManager } from "./politeness.js";

/**
 * M5: robots拒否(RobotsDeniedError)・SSRF拒否(PrivateAddressError)は「sitemap/feedが
 * 無いだけ」として握りつぶさず再送出すべき明示的な拒否シグナルである。
 *
 * 公開品質バグ修正: 一方でHttpStatusError(404/403/5xx等)は、sitemap.xml/feedが
 * 単に存在しないという極めて一般的なケースで発生する(実際、これがsitemap→RSS→
 * ページ内リンクへのフォールバックの主な発生源になっている)。これをAmenboError全般として
 * 再送出してしまうと、sitemap.xmlの無い(=大半の)サイトでlinksツールが丸ごと失敗する
 * 深刻な回帰になるため、再送出するのは拒否シグナルのみに絞る。
 */
function isFallbackBlockingError(error: unknown): boolean {
  return error instanceof PrivateAddressError || error instanceof RobotsDeniedError;
}

export type LinkSource = "sitemap" | "rss" | "page";

export interface LinkEntry {
  url: string;
  title: string | null;
}

export interface LinksResult {
  source: LinkSource;
  links: LinkEntry[];
  /** MAX_LINKSを超えて切り捨てた場合true。 */
  truncated: boolean;
}

const MAX_LINKS = 200;
/** sitemapindexの場合、負荷を抑えるため先頭N件の子sitemapのみ辿る。 */
const MAX_SITEMAP_CHILDREN = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** filter未指定なら常に真。*を含む場合はglob、それ以外は部分一致。 */
function matchesFilter(value: string, filter: string | undefined): boolean {
  if (!filter) return true;
  if (filter.includes("*")) {
    const pattern = new RegExp(`^${filter.split("*").map(escapeRegExp).join(".*")}$`, "i");
    return pattern.test(value);
  }
  return value.toLowerCase().includes(filter.toLowerCase());
}

interface XmlLikeElement {
  textContent: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): XmlLikeElement | null;
}

interface XmlLikeDocument {
  querySelectorAll(selector: string): ArrayLike<XmlLikeElement>;
  querySelector(selector: string): XmlLikeElement | null;
}

async function fetchXml(url: string, timeoutMs: number, rewrite?: (xml: string) => string): Promise<XmlLikeDocument> {
  const result = await httpGet(url, { timeoutMs });
  const { document } = parseHTML(rewrite ? rewrite(result.html) : result.html);
  return document as unknown as XmlLikeDocument;
}

/**
 * RSS 2.0の `<link>URL</link>` は、linkedomがHTMLパーサとして`<link>`をvoid要素
 * (`<link>`/`<br>`/`<img>`等、閉じタグ不要かつ子を持てない要素)として扱ってしまうため、
 * テキスト内容(URL)が失われる(Atomの`<link href="...">`は属性ベースなので影響を受けない)。
 * パース前に `<link>` を衝突しない別タグ名へ機械的にリネームして回避する。
 */
function escapeRssLinkTag(xml: string): string {
  return xml.replace(/<link>([\s\S]*?)<\/link>/gi, "<rss-link>$1</rss-link>");
}

async function tryParseSitemap(
  sitemapUrl: string,
  politeness: PolitenessManager,
  timeoutMs: number,
  depth = 0,
): Promise<LinkEntry[] | null> {
  let document: XmlLikeDocument;
  try {
    await politeness.guard(sitemapUrl);
    document = await fetchXml(sitemapUrl, timeoutMs);
  } catch (error) {
    if (isFallbackBlockingError(error)) throw error;
    // sitemap.xmlが存在しない(404等)のは大半のサイトで起きる通常のフォールバック経路なので
    // ログを出さない。それ以外(タイムアウト等の予期しない失敗)のみ診断用にログする。
    if (!(error instanceof HttpStatusError)) {
      console.error(`sitemapの取得に失敗しました: ${sitemapUrl}`, error);
    }
    return null;
  }

  // sitemapindex(子sitemapへの参照一覧)の場合、先頭数件のみ辿って合算する
  const childLocs = Array.from(document.querySelectorAll("sitemapindex > sitemap > loc"));
  if (childLocs.length > 0 && depth === 0) {
    const results: LinkEntry[] = [];
    for (const loc of childLocs.slice(0, MAX_SITEMAP_CHILDREN)) {
      const childUrl = loc.textContent.trim();
      if (!childUrl) continue;
      const childLinks = await tryParseSitemap(childUrl, politeness, timeoutMs, depth + 1);
      if (childLinks) results.push(...childLinks);
      if (results.length >= MAX_LINKS) break;
    }
    return results.length > 0 ? results : null;
  }

  const urlLocs = Array.from(document.querySelectorAll("urlset > url > loc"));
  if (urlLocs.length === 0) return null;
  return urlLocs.map((loc) => ({ url: loc.textContent.trim(), title: null })).filter((entry) => entry.url.length > 0);
}

async function tryParseFeed(feedUrl: string, politeness: PolitenessManager, timeoutMs: number): Promise<LinkEntry[] | null> {
  let document: XmlLikeDocument;
  try {
    await politeness.guard(feedUrl);
    // RSS 2.0の<link>はHTMLパーサにvoid要素として扱われるためリネームして回避する(下記コメント参照)
    document = await fetchXml(feedUrl, timeoutMs, escapeRssLinkTag);
  } catch (error) {
    if (isFallbackBlockingError(error)) throw error;
    if (!(error instanceof HttpStatusError)) {
      console.error(`フィードの取得に失敗しました: ${feedUrl}`, error);
    }
    return null;
  }

  // RSS 2.0
  const items = Array.from(document.querySelectorAll("item"));
  if (items.length > 0) {
    const entries = items
      .map((item) => {
        const link = item.querySelector?.("rss-link")?.textContent?.trim();
        const title = item.querySelector?.("title")?.textContent?.trim() ?? null;
        return link ? { url: link, title } : null;
      })
      .filter((entry): entry is LinkEntry => entry !== null);
    if (entries.length > 0) return entries;
  }

  // Atom
  const atomEntries = Array.from(document.querySelectorAll("entry"));
  if (atomEntries.length > 0) {
    const entries = atomEntries
      .map((entry) => {
        const link = entry.querySelector?.("link")?.getAttribute?.("href")?.trim();
        const title = entry.querySelector?.("title")?.textContent?.trim() ?? null;
        return link ? { url: link, title } : null;
      })
      .filter((entry): entry is LinkEntry => entry !== null);
    if (entries.length > 0) return entries;
  }

  return null;
}

/** ページ内の&lt;a href&gt;リンクを抽出する(機能C: extract/dataSources.tsからも再利用される)。 */
export function extractPageLinks(html: string, baseUrl: string): LinkEntry[] {
  const { document } = parseHTML(html);
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const seen = new Set<string>();
  const links: LinkEntry[] = [];

  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;

    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const title = (a.textContent ?? "").replace(/\s+/g, " ").trim() || null;
    links.push({ url: resolved, title });
  }

  return links;
}

function dedupeByUrl(links: LinkEntry[]): LinkEntry[] {
  const seen = new Set<string>();
  const result: LinkEntry[] = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    result.push(link);
  }
  return result;
}

function finalize(source: LinkSource, links: LinkEntry[], filter: string | undefined): LinksResult {
  const filtered = dedupeByUrl(links).filter((link) => matchesFilter(link.url, filter) || matchesFilter(link.title ?? "", filter));
  return { source, links: filtered.slice(0, MAX_LINKS), truncated: filtered.length > MAX_LINKS };
}

export interface DiscoverLinksOptions {
  filter?: string;
  timeoutMs?: number;
}

/** URLからリンク一覧を発見する。sitemap → RSS/Atom → ページ内リンクの優先順で試す。 */
export async function discoverLinks(url: string, politeness: PolitenessManager, options: DiscoverLinksOptions = {}): Promise<LinksResult> {
  // 公開品質バグ修正: robots.txt/sitemap取得より前にスキームを検証する。file:等を先に弾かないと
  // origin("null"等)から `null/sitemap.xml` のような壊れたURLを組み立ててしまい、
  // new URL()の生のTypeErrorがstderrに漏れてしまう。
  assertHttpScheme(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin = new URL(url).origin;

  // 1. sitemap優先(robots.txtのSitemap宣言 → 見つからなければ慣例パス)
  const declaredSitemaps = await politeness.getSitemaps(url);
  const candidateSitemaps = declaredSitemaps.length > 0 ? declaredSitemaps : [`${origin}/sitemap.xml`];
  for (const sitemapUrl of candidateSitemaps) {
    const links = await tryParseSitemap(sitemapUrl, politeness, timeoutMs);
    if (links && links.length > 0) {
      return finalize("sitemap", links, options.filter);
    }
  }

  // 2. ページを取得し、<link rel=alternate>が指すRSS/Atomフィードを試す
  await politeness.guard(url);
  const pageResult = await fetchPage(url, { timeoutMs });
  if ("notModified" in pageResult) {
    return finalize("page", [], options.filter);
  }
  // 機能B: 非HTMLコンテンツはハンドオフ応答(fetchツール向け)の対象であり、linksツールでは
  // DOMが無くリンク抽出できない。以前のfetchPage(HTML以外はUnsupportedContentError)と
  // 同じ挙動を維持する(linksツールの応答形式は変えない)。
  if ("handoff" in pageResult) {
    throw new UnsupportedContentError(pageResult.finalUrl, pageResult.contentType ?? "(不明)");
  }

  const { document } = parseHTML(pageResult.html);
  const feedLinkEl = document.querySelector(
    'link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]',
  );
  const feedHref = feedLinkEl?.getAttribute("href");
  if (feedHref) {
    const feedUrl = new URL(feedHref, pageResult.finalUrl).toString();
    const feedLinks = await tryParseFeed(feedUrl, politeness, timeoutMs);
    if (feedLinks && feedLinks.length > 0) {
      return finalize("rss", feedLinks, options.filter);
    }
  }

  // 3. 最終手段: ページ内リンク抽出
  return finalize("page", extractPageLinks(pageResult.html, pageResult.finalUrl), options.filter);
}
