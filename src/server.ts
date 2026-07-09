#!/usr/bin/env node
/**
 * server.ts — amenbo MCP stdioサーバー。
 *
 * ツール:
 *   - fetch: politeness(robots+レート制御) → cache(fresh/revalidated/miss判定)
 *     → 二段フェッチ(fetcher/index.ts) → J4 fit-pruning + Markdown抽出(extract/markdown.ts)
 *     → mode別出力(markdown/outline/section切り出し/品質スコアによるscreenshot自動切替)
 *   - screenshot: 明示的な視覚確認用。Playwrightでタイル分割スクリーンショットを撮影する。
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { computeScreenshotCacheKey, PageCache, type CacheStatus, type ScreenshotCacheStatus } from "./cache.js";
import { AmenboError, SectionNotFoundError } from "./errors.js";
import { extractMarkdown } from "./extract/markdown.js";
import { buildOutline, extractSection, type OutlineResult } from "./extract/outline.js";
import { evaluateQuality } from "./extract/qualityScore.js";
import { fetchPage, type FetchTier } from "./fetcher/index.js";
import { PolitenessManager } from "./politeness.js";
import { captureTiledScreenshot, DEFAULT_TILE_WIDTH } from "./screenshot.js";
import { paginateMarkdown, type PaginatedResult } from "./tokens.js";

const politeness = new PolitenessManager();
const cache = new PageCache();

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
}

type FetchAndExtractResult = { status: "not_modified" } | ExtractedPage;

/** URLとselectorの組から、新規取得・変換したMarkdownと品質スコア/pruning結果を作る。 */
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
  };
}

/**
 * URL(+selector)からMarkdownを解決する。selector指定時はURL単位のキャッシュを使わない
 * (同一URLでも抽出結果がselector毎に変わるため)。品質スコア判定結果もキャッシュメタデータへ
 * 保存し、'fresh'なキャッシュ応答時にもブラウザ再レンダー無しでmode:autoの判定を再現できるようにする。
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
  ].join("\n");
  return `${header}\n\n${paginated.content}`;
}

function formatOutlineResponse(page: ResolvedPage, outline: OutlineResult): string {
  const header = [
    `title: ${page.title ?? "(なし)"}`,
    `url: ${page.finalUrl}`,
    `mode_used: outline`,
    `cache: ${page.cacheStatus}`,
    `total_tokens: ${outline.totalTokens}`,
    `fetch_tier: ${page.tier}`,
    `pruned_blocks: ${page.prunedBlockCount}`,
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

// ---- fetchツール ----

interface FetchToolInput {
  url: string;
  mode?: "auto" | "markdown" | "outline" | "screenshot" | undefined;
  selector?: string | undefined;
  section?: string | undefined;
  page?: number | undefined;
  max_tokens?: number | undefined;
}

async function handleFetchTool(input: FetchToolInput): Promise<Array<TextBlock | ImageBlock>> {
  const mode = input.mode ?? "auto";
  await politeness.guard(input.url);

  const resolved = await resolvePage(input.url, input.selector);

  // sectionが指定された場合は、mode指定に関わらずその節のMarkdownのみを返す
  if (input.section) {
    const sectionMarkdown = extractSection(resolved.markdown, input.section);
    if (sectionMarkdown === null) {
      throw new SectionNotFoundError(input.url, input.section);
    }
    const paginated = paginateMarkdown(sectionMarkdown, input.max_tokens ?? DEFAULT_MAX_TOKENS, input.page ?? DEFAULT_PAGE);
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

  const paginated = paginateMarkdown(resolved.markdown, input.max_tokens ?? DEFAULT_MAX_TOKENS, input.page ?? DEFAULT_PAGE);
  return [{ type: "text", text: formatMarkdownResponse(resolved, paginated, null) }];
}

// ---- MCPサーバー本体 ----

const server = new McpServer({ name: "amenbo", version: "0.2.0" });

server.registerTool(
  "fetch",
  {
    title: "Fetch a web page as Markdown",
    description:
      "日本語Webページを低負荷・省トークンで取得する。robots.txt/レート制御/キャッシュを内蔵し、" +
      "modeでMarkdown全文/見出しアウトライン/特定セクション/スクリーンショットを選べる。" +
      "mode:autoは品質スコアに応じてMarkdownとスクリーンショットを自動切替する。",
    inputSchema: {
      url: z.string().url().describe("取得対象のURL(http/httpsのみ)"),
      mode: z
        .enum(["auto", "markdown", "outline", "screenshot"])
        .optional()
        .describe(
          "取得モード(既定: auto)。auto=品質スコアで自動判定/markdown=常にMarkdown/" +
            "outline=見出しツリーと概算トークン数のみ/screenshot=常にスクリーンショット",
        ),
      selector: z.string().optional().describe("抽出前にDOMへ適用するCSSセレクタ"),
      section: z.string().optional().describe("outlineモードで得たsection ID(例: 's2')。指定時はmodeに関わらずその節のMarkdownのみ取得する"),
      page: z.number().int().positive().optional().describe("ページ番号(既定: 1)"),
      max_tokens: z.number().int().positive().optional().describe("1ページあたりの概算トークン上限(既定: 8000)"),
    },
  },
  async ({ url, mode, selector, section, page, max_tokens: maxTokens }) => {
    try {
      const content = await handleFetchTool({ url, mode, selector, section, page, max_tokens: maxTokens });
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
