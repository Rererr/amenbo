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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { computeScreenshotCacheKey, PageCache, type CacheStatus, type ScreenshotCacheStatus } from "./cache.js";
import { diffMarkdown, type SectionDiff } from "./diff.js";
import { AmenboError, SectionNotFoundError } from "./errors.js";
import { extractMarkdown } from "./extract/markdown.js";
import { buildOutline, extractSection, type OutlineResult } from "./extract/outline.js";
import { DEFAULT_PDF_MAX_BYTES, extractPdfText, looksLikePdf, markdownFromPdfText, renderPdfPages } from "./extract/pdf.js";
import { evaluateQuality } from "./extract/qualityScore.js";
import { fetchPage, type FetchTier } from "./fetcher/index.js";
import { httpGetBinary } from "./fetcher/http.js";
import { discoverLinks, type LinksResult } from "./links.js";
import { PolitenessManager } from "./politeness.js";
import { captureTiledScreenshot, DEFAULT_TILE_WIDTH } from "./screenshot.js";
import { paginateMarkdown, type PaginatedResult } from "./tokens.js";

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

process.once("exit", () => {
  cache.close();
});

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_PAGE = 1;
const DEFAULT_SCREENSHOT_SCALE = 1.0;

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
}

type FetchAndExtractResult = { status: "not_modified" } | ExtractedPage;

/** URLとselectorの組から、新規取得・変換したMarkdownと品質スコア/pruning/アダプタ結果を作る。 */
async function fetchAndExtract(
  url: string,
  selector: string | undefined,
  conditionalHeaders: Record<string, string> | undefined,
): Promise<FetchAndExtractResult> {
  const fetchResult = await fetchPage(url, conditionalHeaders ? { headers: conditionalHeaders } : {});
  if ("notModified" in fetchResult) {
    return { status: "not_modified" };
  }

  const extracted = extractMarkdown(fetchResult.html, {
    url: fetchResult.finalUrl,
    ...(selector ? { selector } : {}),
  });
  const quality = evaluateQuality(extracted.qualityInput);

  return {
    status: "fetched",
    markdown: extracted.markdown,
    title: extracted.title,
    finalUrl: fetchResult.finalUrl,
    tier: fetchResult.tier,
    etag: fetchResult.etag,
    lastModified: fetchResult.lastModified,
    lowQuality: quality.lowQuality,
    qualityReason: quality.reason,
    prunedBlockCount: extracted.prunedBlockCount,
    adapterName: extracted.adapterName,
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
  /** 新規フェッチ(cacheStatus==='miss')の場合のみ、上書き前の旧キャッシュ内容(§3-3差分応答用)。 */
  previousMarkdown: string | null;
}

function pageFromCacheEntry(url: string, cached: ReturnType<PageCache["get"]>, cacheStatus: CacheStatus): ResolvedPage {
  const metadata = cached?.metadata ?? {};
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
    previousMarkdown: null,
  };
}

/**
 * URL(+selector)からMarkdownを解決する。selector指定時はURL単位のキャッシュを使わない
 * (同一URLでも抽出結果がselector毎に変わるため)。品質スコア/アダプタ判定結果もキャッシュ
 * メタデータへ保存し、'fresh'なキャッシュ応答時にも再フェッチ無しでmode:autoの判定を再現する。
 */
async function resolvePage(url: string, selector: string | undefined): Promise<ResolvedPage> {
  if (selector) {
    const result = await fetchAndExtract(url, selector, undefined);
    if (result.status === "not_modified") {
      throw new UnexpectedNotModifiedError(url);
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
      previousMarkdown: null,
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

  const previousMarkdown = cached?.markdown ?? null;

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
    previousMarkdown,
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
}

interface ResolveScreenshotOptions {
  fullPage: boolean;
  width: number;
  scale: number;
}

async function resolveScreenshot(url: string, options: ResolveScreenshotOptions): Promise<ResolvedScreenshot> {
  // 実URLへの独立したブラウザ遷移が発生するため、markdown抽出時とは別にpolitenessの順番待ちを行う
  await politeness.guard(url);

  const cacheKey = computeScreenshotCacheKey(url, options.width, options.scale, options.fullPage);
  const cached = cache.getScreenshot(cacheKey);
  if (cached && cache.isFresh(cached)) {
    return {
      finalUrl: cached.url,
      tiles: cached.tilePaths.map((filePath) => ({ data: readFileSync(filePath) })),
      cacheStatus: "fresh",
      pageWidth: Number(cached.metadata.pageWidth ?? 0),
      pageHeight: Number(cached.metadata.pageHeight ?? 0),
    };
  }

  const captured = await captureTiledScreenshot(url, options);
  cache.setScreenshot({
    cacheKey,
    url: captured.finalUrl,
    tiles: captured.tiles.map((tile) => tile.png),
    metadata: { pageWidth: captured.pageWidth, pageHeight: captured.pageHeight },
  });

  return {
    finalUrl: captured.finalUrl,
    tiles: captured.tiles.map((tile) => ({ data: tile.png })),
    cacheStatus: "miss",
    pageWidth: captured.pageWidth,
    pageHeight: captured.pageHeight,
  };
}

// ---- 応答フォーマット ----

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

function adapterLine(adapterName: string | null): string[] {
  return adapterName ? [`adapter: ${adapterName}`] : [];
}

function formatMarkdownResponse(page: ResolvedPage, paginated: PaginatedResult, sectionId: string | null): string {
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
  ].join("\n");
  return `${header}\n\n${paginated.content}`;
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
function formatDiffResponse(page: ResolvedPage, sections: SectionDiff[]): string {
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
  ].join("\n");

  return `${header}\n\n${sections.map(formatSectionDiffBlock).join("\n\n")}`;
}

function formatOutlineResponse(page: ResolvedPage, outline: OutlineResult): string {
  const header = [
    `title: ${page.title ?? "(なし)"}`,
    `url: ${page.finalUrl}`,
    `mode_used: outline`,
    `cache: ${page.cacheStatus}`,
    `total_tokens: ${outline.totalTokens}`,
    `fetch_tier: ${page.tier}`,
    ...adapterLine(page.adapterName),
  ].join("\n");

  const body =
    outline.sections
      .map((section) => `${"  ".repeat(section.level - 1)}- [${section.id}] ${"#".repeat(section.level)} ${section.heading} — ${section.excerpt} (~${section.tokens} tok)`)
      .join("\n") || "(見出しが見つかりませんでした。mode: markdown で全文を取得してください)";

  return `${header}\n\n${body}`;
}

function buildScreenshotContent(
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
  await politeness.guard(input.url);

  if (looksLikePdf(input.url, null)) {
    return handlePdfFetch(input.url, page, maxTokens);
  }

  const resolved = await resolvePage(input.url, input.selector);

  // sectionが指定された場合は、mode指定に関わらずその節のMarkdownのみを返す(差分応答は適用しない)
  if (input.section) {
    const sectionMarkdown = extractSection(resolved.markdown, input.section);
    if (sectionMarkdown === null) {
      throw new SectionNotFoundError(input.url, input.section);
    }
    const paginated = paginateMarkdown(sectionMarkdown, maxTokens, page);
    return [{ type: "text", text: formatMarkdownResponse(resolved, paginated, input.section) }];
  }

  if (mode === "outline") {
    const outline = buildOutline(resolved.markdown);
    return [{ type: "text", text: formatOutlineResponse(resolved, outline) }];
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
  const diffEligible = !input.selector && !input.force_full && resolved.cacheStatus === "miss" && resolved.previousMarkdown !== null;
  if (diffEligible) {
    if (resolved.previousMarkdown === resolved.markdown) {
      return [{ type: "text", text: formatUnchangedResponse(resolved) }];
    }
    const diff = diffMarkdown(resolved.previousMarkdown ?? "", resolved.markdown);
    if (diff.sections.length > 0 && !diff.allSectionsChanged) {
      return [{ type: "text", text: formatDiffResponse(resolved, diff.sections) }];
    }
    // 全節変更、または差分検出不能な場合は通常の全文応答へフォールバックする
  }

  const paginated = paginateMarkdown(resolved.markdown, maxTokens, page);
  return [{ type: "text", text: formatMarkdownResponse(resolved, paginated, null) }];
}

// ---- MCPサーバー本体 ----

const server = new McpServer({ name: "amenbo", version: "0.3.0" });

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
      force_full: z.boolean().optional().describe("既定false。trueで差分応答(unchanged/diff)を無効化し常に全文を返す"),
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

main().catch((error: unknown) => {
  console.error("amenboサーバーの起動に失敗しました:", error);
  process.exit(1);
});
