/**
 * links.ts — linksツール。sitemap.xml / RSS・Atomフィード優先のリンク列挙。
 *
 * ページを舐めて全リンクを辿るのではなく、まずsitemap.xml/RSS・Atomフィードという
 * 「サイト側が既に用意した索引」を優先利用することで、収集先への負荷を最小化する
 * (plan.md §4「sitemap/RSSが在ればリンク探索はそちらを優先」)。
 *
 * 優先順位: robots.txt宣言のsitemap(→慣例パス`/sitemap.xml`) → ページの<link rel=alternate>
 * が指すRSS/Atomフィード → 最終手段としてページ内の<a>リンク抽出。ページを取ったときに、そのページが
 * llms.txt の在りかを知らせていれば、フィードより先に llms.txt を使う。在りかを推測して探しには行かない。
 * 順はキャッシュの状態(前に fetch したか)に依らず一つに決める。sitemap がある限りページを取らないので、
 * ページの知らせる llms.txt を sitemap より先に置くと、そのためだけにページを取る要求が増える。
 *
 * 取得した sitemap・フィード・ページ・llms.txt は、ページと同じTTLでキャッシュする。filter を
 * 変えて呼び直すたびに同じ索引を取り直さないため(先方への要求を増やさない)。
 */
import { gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import type { PageCache } from "./cache.js";
import {
  BotChallengeError,
  HostRefusedError,
  HttpStatusError,
  PrivateAddressError,
  RequestCancelledError,
  RobotsDeniedError,
  UnsupportedContentError,
  WaitTooLongError,
} from "./errors.js";
import { fetchPage } from "./fetcher/index.js";
import { assertHttpScheme, decodeHtmlBytes, httpGet, httpGetBinary, resolveDefaultMaxBodyBytes } from "./fetcher/http.js";
import { currentCancellation, type PolitenessManager } from "./politeness.js";

/**
 * M5: robots拒否(RobotsDeniedError)・SSRF拒否(PrivateAddressError)は「sitemap/feedが
 * 無いだけ」として握りつぶさず再送出すべき明示的な拒否シグナルである。
 *
 * 公開品質バグ修正: 一方でHttpStatusError(404/403/5xx等)は、sitemap.xml/feedが
 * 単に存在しないという極めて一般的なケースで発生する(実際、これがsitemap→RSS→
 * ページ内リンクへのフォールバックの主な発生源になっている)。これをAmenboError全般として
 * 再送出してしまうと、sitemap.xmlの無い(=大半の)サイトでlinksツールが丸ごと失敗する
 * 深刻な回帰になるため、再送出するのは拒否シグナルのみに絞る。
 *
 * 待ちの上限超過(WaitTooLongError)と取り消し(RequestCancelledError)も再送出する。同じホストへの
 * 次の候補も同じ待ち行列に並ぶので、フォールバックしても同じ理由で止まるだけになる。ただしsitemap・フィードが
 * ページと別のホストにあるときの待ちの上限超過は、ページのホストへは進めるので、discoverLinksOnceが飛ばす。
 */
function isFallbackBlockingError(error: unknown): boolean {
  return (
    error instanceof PrivateAddressError ||
    error instanceof RobotsDeniedError ||
    error instanceof HostRefusedError ||
    error instanceof WaitTooLongError ||
    error instanceof RequestCancelledError ||
    error instanceof BotChallengeError ||
    (error instanceof HttpStatusError && error.isRefusal)
  );
}

export type LinkSource = "sitemap" | "rss" | "llms.txt" | "page";

export interface LinkEntry {
  url: string;
  title: string | null;
}

export interface LinksResult {
  source: LinkSource;
  links: LinkEntry[];
  /** MAX_LINKSを超えて切り捨てた場合true。 */
  truncated: boolean;
  /**
   * フィルタ適用前(重複排除後)の件数。
   * filter指定時にlinks.length===0となった場合、これが0なら「sitemap/RSS/ページ自体が空」、
   * 0より大きければ「filterに一致しなかった」と原因を切り分けられる(呼び出し側でのみ使う)。
   */
  preFilterCount: number;
  /** 取得したが読めなかった出典の注記(gzipの sitemap を展開できなかった等)。無ければ省略。 */
  warnings?: string[];
}

const MAX_LINKS = 200;
/** sitemapindexの場合、負荷を抑えるため先頭N件の子sitemapのみ辿る。 */
const MAX_SITEMAP_CHILDREN = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * filter未指定なら常に真。*を含む場合はglob、それ以外は部分一致。
 *
 * レビュー指摘対応: globは`^…$`で両端アンカーせず非アンカー(部分一致)にする。
 * README/記事が例示する`--filter "blog/*"`は絶対URL(`https://example.com/blog/123`)全体とは
 * 一致しないため、アンカー版だと必ず0件になっていた。URL/タイトルの一部にglobパターンが
 * 現れれば真とする(通常の部分一致フィルタと同じ「含む」感覚に揃える)。
 */
function matchesFilter(value: string, filter: string | undefined): boolean {
  if (!filter) return true;
  if (filter.includes("*")) {
    const pattern = new RegExp(filter.split("*").map(escapeRegExp).join(".*"), "i");
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

/** links が使うキャッシュ(PageCacheの一部。呼び出し側とテストが差し替えられるよう構造で受ける)。 */
export type LinkSourceCache = Pick<PageCache, "get" | "isFresh" | "set">;

function isLinkEntries(value: unknown): value is LinkEntry[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return false;
      const { url, title } = entry as Record<string, unknown>;
      return typeof url === "string" && (typeof title === "string" || title === null);
    })
  );
}

function isSitemapDocument(value: unknown): value is SitemapDocument {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "urlset") return isLinkEntries(record.links);
  if (record.kind === "index") return Array.isArray(record.children) && record.children.every((child) => typeof child === "string");
  return record.kind === "none" && (record.warning === undefined || typeof record.warning === "string");
}

function isPageDocument(value: unknown): value is PageDocument {
  if (typeof value !== "object" || value === null) return false;
  const { feedUrl, llmsTxt, links } = value as Record<string, unknown>;
  const isUrlOrNull = (field: unknown): boolean => typeof field === "string" || field === null;
  return isUrlOrNull(feedUrl) && isUrlOrNull(llmsTxt) && isLinkEntries(links);
}

/**
 * 出典ごとの取得結果をキャッシュから返すか、取得してキャッシュする。ページのキャッシュ
 * (fetchツール)と同じ表に置くため、キーはURLの前に種別を付けて衝突させない。
 * loadがnullを返したら(一時的な失敗)保存しない。保存した値は形を確かめ、合わなければ取り直す。
 */
async function cachedSource<T>(
  cache: LinkSourceCache | undefined,
  key: string,
  isValid: (value: unknown) => value is T,
  load: () => Promise<{ value: T; cacheControl: string | null } | null>,
): Promise<T | null> {
  const entry = cache?.get(key);
  if (entry && cache?.isFresh(entry)) {
    try {
      const value: unknown = JSON.parse(entry.markdown);
      if (isValid(value)) return value;
    } catch {
      // 形の壊れた行は無いものとして取り直す。
    }
  }
  const loaded = await load();
  if (!loaded) return null;
  cache?.set({ url: key, etag: null, lastModified: null, markdown: JSON.stringify(loaded.value), metadata: {}, cacheControl: loaded.cacheControl });
  return loaded.value;
}

/** 取得はできたが中身を読めなかった(gzipを展開できない等)。理由は応答の注記に出す。 */
class UnreadableSourceError extends Error {}

/** gzipの先頭2バイト(RFC 1952)。Content-Encodingで送られた圧縮はundiciが展開済みなので、ここに来るのは .gz のファイルそのもの。 */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** gzipを、本文の取得と同じ上限(展開後のバイト数)で展開する(gzip爆弾でメモリを使い切らないため)。 */
function gunzipWithinLimit(bytes: Uint8Array): Uint8Array {
  const limit = resolveDefaultMaxBodyBytes();
  try {
    return gunzipSync(bytes, { maxOutputLength: limit });
  } catch (error) {
    const tooLarge = error instanceof RangeError || (error as NodeJS.ErrnoException | null)?.code === "ERR_BUFFER_TOO_LARGE";
    const reason = tooLarge ? `gzipの展開後の大きさが上限(${limit}バイト)を超えました` : `gzipを展開できませんでした(${(error as Error).message})`;
    throw new UnreadableSourceError(reason);
  }
}

async function fetchXml(
  url: string,
  timeoutMs: number,
  politeness: PolitenessManager,
  rewrite?: (xml: string) => string,
): Promise<{ document: XmlLikeDocument; cacheControl: string | null }> {
  // リダイレクトの転送先ごとにrobots.txtも確認する(fetcher/http.tsのHttpGetOptions.checkRobots参照)。
  const result = await httpGetBinary(url, { timeoutMs, checkRobots: (targetUrl) => politeness.checkRedirectTarget(targetUrl) });
  const gzipped = isGzip(result.bytes);
  // 展開した中身には、gzipファイルとしてのContent-Typeのcharsetが当てはまらない。
  const text = decodeHtmlBytes(gzipped ? gunzipWithinLimit(result.bytes) : result.bytes, gzipped ? null : result.contentType).text;
  const { document } = parseHTML(rewrite ? rewrite(text) : text);
  return { document: document as unknown as XmlLikeDocument, cacheControl: result.headers.get("cache-control") };
}

/**
 * 出典の取得の失敗を振り分ける。拒否の印は投げ直し、出典が無いだけ(4xx)は「無し」として
 * キャッシュしてよい結果に、それ以外(タイムアウト・5xx等の一時的な失敗)はnull(保存しない)にする。
 */
function absentOrTransient<T>(error: unknown, absent: T, label: string, url: string): { value: T; cacheControl: string | null } | null {
  if (isFallbackBlockingError(error)) throw error;
  if (error instanceof HttpStatusError) return error.status < 500 ? { value: absent, cacheControl: null } : null;
  // sitemap.xml等が存在しない(404等)のは大半のサイトで起きる通常のフォールバック経路なので
  // ログを出さない。それ以外(タイムアウト等の予期しない失敗)のみ診断用にログする。
  console.error(`${label}の取得に失敗しました: ${url}`, error);
  return null;
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

interface SourceContext {
  politeness: PolitenessManager;
  timeoutMs: number;
  onProgress: ((message: string) => void) | undefined;
  cache: LinkSourceCache | undefined;
  /** 読めなかった出典の注記(応答に出す)。 */
  warnings: string[];
}

type SitemapDocument = { kind: "urlset"; links: LinkEntry[] } | { kind: "index"; children: string[] } | { kind: "none"; warning?: string };

function loadSitemap(sitemapUrl: string, context: SourceContext): Promise<SitemapDocument | null> {
  return cachedSource(context.cache, `links-sitemap:${sitemapUrl}`, isSitemapDocument, async () => {
    try {
      await context.politeness.guard(sitemapUrl, context.onProgress);
      const { document, cacheControl } = await fetchXml(sitemapUrl, context.timeoutMs, context.politeness);
      const children = Array.from(document.querySelectorAll("sitemapindex > sitemap > loc"))
        .map((loc) => loc.textContent.trim())
        .filter((loc) => loc.length > 0);
      if (children.length > 0) return { value: { kind: "index", children }, cacheControl };
      const links = Array.from(document.querySelectorAll("urlset > url > loc"))
        .map((loc) => ({ url: loc.textContent.trim(), title: null }))
        .filter((entry) => entry.url.length > 0);
      return { value: links.length > 0 ? { kind: "urlset", links } : { kind: "none" }, cacheControl };
    } catch (error) {
      if (error instanceof UnreadableSourceError) {
        return { value: { kind: "none", warning: `sitemapを読めませんでした: ${sitemapUrl} (${error.message})` }, cacheControl: null };
      }
      return absentOrTransient<SitemapDocument>(error, { kind: "none" }, "sitemap", sitemapUrl);
    }
  });
}

async function tryParseSitemap(sitemapUrl: string, context: SourceContext, depth = 0): Promise<LinkEntry[] | null> {
  const sitemap = await loadSitemap(sitemapUrl, context);
  if (!sitemap) return null;
  if (sitemap.kind === "none") {
    if (sitemap.warning) context.warnings.push(sitemap.warning);
    return null;
  }
  if (sitemap.kind === "urlset") return sitemap.links;
  // sitemapindex(子sitemapへの参照一覧)の場合、先頭数件のみ辿って合算する
  if (depth > 0) return null;
  const results: LinkEntry[] = [];
  for (const childUrl of sitemap.children.slice(0, MAX_SITEMAP_CHILDREN)) {
    const childLinks = await tryParseSitemap(childUrl, context, depth + 1);
    // push(...childLinks)は引数展開のため、子sitemapが約15万件を超えるとスタックが溢れる。
    if (childLinks) for (const link of childLinks) results.push(link);
    if (results.length >= MAX_LINKS) break;
  }
  return results.length > 0 ? results : null;
}

function feedEntries(document: XmlLikeDocument): LinkEntry[] {
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

  return [];
}

function tryParseFeed(feedUrl: string, context: SourceContext): Promise<LinkEntry[] | null> {
  return cachedSource(context.cache, `links-feed:${feedUrl}`, isLinkEntries, async () => {
    try {
      await context.politeness.guard(feedUrl, context.onProgress);
      // RSS 2.0の<link>はHTMLパーサにvoid要素として扱われるためリネームして回避する(escapeRssLinkTag参照)
      const { document, cacheControl } = await fetchXml(feedUrl, context.timeoutMs, context.politeness, escapeRssLinkTag);
      return { value: feedEntries(document), cacheControl };
    } catch (error) {
      if (error instanceof UnreadableSourceError) return { value: [], cacheControl: null };
      return absentOrTransient<LinkEntry[]>(error, [], "フィード", feedUrl);
    }
  });
}

/**
 * llms.txt(llmstxt.org)のファイル一覧 `- [名前](URL): 説明` を読む。説明はどのページを取るかの
 * 判断材料になるので、名前に続けて出す(filterも説明に当たる)。
 */
export function parseLlmsTxt(text: string, baseUrl: string): LinkEntry[] {
  const links: LinkEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*+]\s+\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?$/.exec(line);
    if (!match) continue;
    let resolved: URL;
    try {
      resolved = new URL(match[2]!, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    const name = match[1]!.trim();
    const description = match[3]?.trim();
    links.push({ url: resolved.toString(), title: description ? `${name}: ${description}` : name });
  }
  return links;
}

function tryParseLlmsTxt(llmsTxtUrl: string, context: SourceContext): Promise<LinkEntry[] | null> {
  return cachedSource(context.cache, `links-llms:${llmsTxtUrl}`, isLinkEntries, async () => {
    try {
      await context.politeness.guard(llmsTxtUrl, context.onProgress);
      const result = await httpGet(llmsTxtUrl, {
        timeoutMs: context.timeoutMs,
        checkRobots: (targetUrl) => context.politeness.checkRedirectTarget(targetUrl),
      });
      return { value: parseLlmsTxt(result.html, result.finalUrl), cacheControl: result.headers.get("cache-control") };
    } catch (error) {
      return absentOrTransient<LinkEntry[]>(error, [], "llms.txt", llmsTxtUrl);
    }
  });
}

interface PageDocument {
  feedUrl: string | null;
  llmsTxt: string | null;
  links: LinkEntry[];
}

const EMPTY_PAGE: PageDocument = { feedUrl: null, llmsTxt: null, links: [] };

async function loadPage(url: string, context: SourceContext): Promise<PageDocument> {
  const page = await cachedSource(context.cache, `links-page:${url}`, isPageDocument, async () => {
    await context.politeness.guard(url, context.onProgress);
    const pageResult = await fetchPage(url, {
      timeoutMs: context.timeoutMs,
      checkRobots: (targetUrl) => context.politeness.checkRedirectTarget(targetUrl),
      waitTurn: (targetUrl) => context.politeness.waitTurn(targetUrl, context.onProgress),
    });
    if ("notModified" in pageResult) {
      return { value: EMPTY_PAGE, cacheControl: null };
    }
    // 機能B: 非HTMLコンテンツはハンドオフ応答(fetchツール向け)の対象であり、linksツールでは
    // DOMが無くリンク抽出できない。以前のfetchPage(HTML以外はUnsupportedContentError)と
    // 同じ挙動を維持する(linksツールの応答形式は変えない)。
    if ("handoff" in pageResult) {
      throw new UnsupportedContentError(pageResult.finalUrl, pageResult.contentType ?? "(不明)");
    }
    const { document } = parseHTML(pageResult.html);
    const feedHref = document
      .querySelector('link[rel="alternate"][type="application/rss+xml"], link[rel="alternate"][type="application/atom+xml"]')
      ?.getAttribute("href");
    return {
      value: {
        feedUrl: feedHref ? new URL(feedHref, pageResult.finalUrl).toString() : null,
        llmsTxt: pageResult.agentResources.llmsTxt,
        links: extractPageLinks(pageResult.html, pageResult.finalUrl),
      },
      cacheControl: pageResult.cacheControl,
    };
  });
  // loadは一時的な失敗でもnullを返さず投げるので、ここには来ない。
  return page ?? EMPTY_PAGE;
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

function finalize(source: LinkSource, links: LinkEntry[], filter: string | undefined, warnings: string[]): LinksResult {
  const deduped = dedupeByUrl(links);
  const filtered = deduped.filter((link) => matchesFilter(link.url, filter) || matchesFilter(link.title ?? "", filter));
  return {
    source,
    links: filtered.slice(0, MAX_LINKS),
    truncated: filtered.length > MAX_LINKS,
    preFilterCount: deduped.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export interface DiscoverLinksOptions {
  filter?: string;
  timeoutMs?: number;
  /**
   * MCP progress notifications用。sitemapindexの子sitemap再帰・フィード取得を含め
   * politeness待機が複数回発生しうる経路のため、累積待機が最も長引きうる。
   * server.tsがprogressToken有無に応じて組み立てて渡す(CLIは渡さない=未指定で後方互換)。
   */
  onProgress?: ((message: string) => void) | undefined;
  /** 出典の取得結果を保存するキャッシュ(省略時は保存しない)。 */
  cache?: LinkSourceCache | undefined;
}

/** URLからリンク一覧を発見する。sitemap → RSS/Atom → ページ内リンクの優先順で試す。 */
export function discoverLinks(url: string, politeness: PolitenessManager, options: DiscoverLinksOptions = {}): Promise<LinksResult> {
  return politeness.rememberRefusals(() => discoverLinksOnce(url, politeness, options));
}

async function discoverLinksOnce(url: string, politeness: PolitenessManager, options: DiscoverLinksOptions): Promise<LinksResult> {
  // 公開品質バグ修正: robots.txt/sitemap取得より前にスキームを検証する。file:等を先に弾かないと
  // origin("null"等)から `null/sitemap.xml` のような壊れたURLを組み立ててしまい、
  // new URL()の生のTypeErrorがstderrに漏れてしまう。
  assertHttpScheme(url);
  // robots.txt の取得(getSitemaps)は guard より前にあるので、止めているホストはここで止める。
  politeness.assertNotRefused(url);
  // 同じ理由で、取り消し済みならrobots.txtを取りに行く前に抜ける(robots.txtの取得は取り消せない)。
  if (currentCancellation()?.aborted) throw new RequestCancelledError(url);
  const context: SourceContext = {
    politeness,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onProgress: options.onProgress,
    cache: options.cache,
    warnings: [],
  };
  const origin = new URL(url).origin;
  const pageHost = new URL(url).host;
  const skipWaitOnOtherHost = (error: unknown): null => {
    if (error instanceof WaitTooLongError && error.host !== pageHost) return null;
    throw error;
  };

  // 1. sitemap優先(robots.txtのSitemap宣言 → 見つからなければ慣例パス)
  const declaredSitemaps = await politeness.getSitemaps(url);
  const candidateSitemaps = declaredSitemaps.length > 0 ? declaredSitemaps : [`${origin}/sitemap.xml`];
  for (const sitemapUrl of candidateSitemaps) {
    const links = await tryParseSitemap(sitemapUrl, context).catch(skipWaitOnOtherHost);
    if (links && links.length > 0) {
      return finalize("sitemap", links, options.filter, context.warnings);
    }
  }

  // 2. ページを取得し、知らせている llms.txt、<link rel=alternate>が指すRSS/Atomフィードの順に試す
  const page = await loadPage(url, context);
  if (page.llmsTxt) {
    const links = await tryParseLlmsTxt(page.llmsTxt, context).catch(skipWaitOnOtherHost);
    if (links && links.length > 0) return finalize("llms.txt", links, options.filter, context.warnings);
  }
  if (page.feedUrl) {
    const feedLinks = await tryParseFeed(page.feedUrl, context).catch(skipWaitOnOtherHost);
    if (feedLinks && feedLinks.length > 0) {
      return finalize("rss", feedLinks, options.filter, context.warnings);
    }
  }

  // 3. 最終手段: ページ内リンク抽出
  return finalize("page", page.links, options.filter, context.warnings);
}
