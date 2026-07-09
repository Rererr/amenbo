#!/usr/bin/env node
/**
 * server.ts — amenbo MCP stdioサーバー。
 *
 * ツール `fetch` を提供する。処理の流れ:
 *   politeness(robots+レート制御) → cache(fresh/revalidated/miss判定)
 *   → 二段フェッチ(fetcher/index.ts) → Markdown抽出(extract/markdown.ts)
 *   → J5ページネーション(tokens.ts) → メタデータ付きテキスト応答
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PageCache, type CacheStatus } from "./cache.js";
import { AmenboError } from "./errors.js";
import { extractMarkdown } from "./extract/markdown.js";
import { fetchPage, type FetchTier } from "./fetcher/index.js";
import { PolitenessManager } from "./politeness.js";
import { paginateMarkdown } from "./tokens.js";

const politeness = new PolitenessManager();
const cache = new PageCache();

process.once("exit", () => {
  cache.close();
});

interface FetchToolResponse {
  title: string | null;
  finalUrl: string;
  modeUsed: "markdown";
  cacheStatus: CacheStatus;
  tokens: number;
  page: number;
  totalPages: number;
  fetchTier: FetchTier | "cache";
  markdown: string;
}

/** URLとselectorの組から、新規取得・変換したMarkdownとメタデータを作る。 */
async function fetchAndExtract(
  url: string,
  selector: string | undefined,
  conditionalHeaders: Record<string, string> | undefined,
): Promise<
  | { status: "not_modified" }
  | { status: "fetched"; markdown: string; title: string | null; finalUrl: string; tier: FetchTier; etag: string | null; lastModified: string | null }
> {
  const fetchResult = await fetchPage(url, conditionalHeaders ? { headers: conditionalHeaders } : {});
  if ("notModified" in fetchResult) {
    return { status: "not_modified" };
  }

  const extracted = extractMarkdown(fetchResult.html, {
    url: fetchResult.finalUrl,
    ...(selector ? { selector } : {}),
  });
  return {
    status: "fetched",
    markdown: extracted.markdown,
    title: extracted.title,
    finalUrl: fetchResult.finalUrl,
    tier: fetchResult.tier,
    etag: fetchResult.etag,
    lastModified: fetchResult.lastModified,
  };
}

/** サーバー側が304を受け取ったがキャッシュが存在しない、という到達しないはずの異常系。 */
class UnexpectedNotModifiedError extends AmenboError {
  readonly code = "UNEXPECTED_NOT_MODIFIED";
  constructor(url: string) {
    super(`キャッシュが存在しないのにNot Modified(304)が返されました: ${url}`);
  }
}

async function handleFetch(url: string, selector: string | undefined, page: number, maxTokens: number): Promise<FetchToolResponse> {
  await politeness.guard(url);

  // selector指定時はURL単位のキャッシュを使わない(同一URLでも抽出結果がselector毎に変わるため)
  if (selector) {
    const result = await fetchAndExtract(url, selector, undefined);
    if (result.status === "not_modified") {
      // 条件ヘッダを送っていないため到達しない想定だが、型上のフォールバックとして扱う
      throw new UnexpectedNotModifiedError(url);
    }
    const paginated = paginateMarkdown(result.markdown, maxTokens, page);
    return {
      title: result.title,
      finalUrl: result.finalUrl,
      modeUsed: "markdown",
      cacheStatus: "miss",
      tokens: paginated.tokens,
      page: paginated.page,
      totalPages: paginated.totalPages,
      fetchTier: result.tier,
      markdown: paginated.content,
    };
  }

  const cached = cache.get(url);
  if (cached && cache.isFresh(cached)) {
    const paginated = paginateMarkdown(cached.markdown, maxTokens, page);
    return {
      title: (cached.metadata.title as string | null) ?? null,
      finalUrl: (cached.metadata.finalUrl as string | undefined) ?? url,
      modeUsed: "markdown",
      cacheStatus: "fresh",
      tokens: paginated.tokens,
      page: paginated.page,
      totalPages: paginated.totalPages,
      fetchTier: "cache",
      markdown: paginated.content,
    };
  }

  const conditionalHeaders: Record<string, string> = {};
  if (cached?.etag) conditionalHeaders["If-None-Match"] = cached.etag;
  if (cached?.lastModified) conditionalHeaders["If-Modified-Since"] = cached.lastModified;

  const result = await fetchAndExtract(url, undefined, Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined);

  if (result.status === "not_modified" && cached) {
    cache.touch(url);
    const paginated = paginateMarkdown(cached.markdown, maxTokens, page);
    return {
      title: (cached.metadata.title as string | null) ?? null,
      finalUrl: (cached.metadata.finalUrl as string | undefined) ?? url,
      modeUsed: "markdown",
      cacheStatus: "revalidated",
      tokens: paginated.tokens,
      page: paginated.page,
      totalPages: paginated.totalPages,
      fetchTier: "cache",
      markdown: paginated.content,
    };
  }

  if (result.status === "not_modified") {
    throw new UnexpectedNotModifiedError(url);
  }

  cache.set({
    url,
    etag: result.etag,
    lastModified: result.lastModified,
    markdown: result.markdown,
    metadata: { title: result.title, finalUrl: result.finalUrl, tier: result.tier },
  });

  const paginated = paginateMarkdown(result.markdown, maxTokens, page);
  return {
    title: result.title,
    finalUrl: result.finalUrl,
    modeUsed: "markdown",
    cacheStatus: "miss",
    tokens: paginated.tokens,
    page: paginated.page,
    totalPages: paginated.totalPages,
    fetchTier: result.tier,
    markdown: paginated.content,
  };
}

function formatResponse(response: FetchToolResponse): string {
  const header = [
    `title: ${response.title ?? "(なし)"}`,
    `url: ${response.finalUrl}`,
    `mode_used: ${response.modeUsed}`,
    `cache: ${response.cacheStatus}`,
    `tokens: ${response.tokens}`,
    `page: ${response.page} of ${response.totalPages}`,
    `fetch_tier: ${response.fetchTier}`,
  ].join("\n");
  return `${header}\n\n${response.markdown}`;
}

const server = new McpServer({ name: "amenbo", version: "0.1.0" });

server.registerTool(
  "fetch",
  {
    title: "Fetch a web page as Markdown",
    description:
      "日本語Webページを低負荷・省トークンで取得し、Markdownへ変換して返す。robots.txt/レート制御/キャッシュを内蔵する。",
    inputSchema: {
      url: z.string().url().describe("取得対象のURL(http/httpsのみ)"),
      mode: z
        .enum(["auto", "markdown"])
        .optional()
        .describe("取得モード。現時点ではautoもmarkdownへ委譲される(既定: auto)"),
      selector: z.string().optional().describe("抽出前にDOMへ適用するCSSセレクタ"),
      page: z.number().int().positive().optional().describe("ページ番号(既定: 1)"),
      max_tokens: z.number().int().positive().optional().describe("1ページあたりの概算トークン上限(既定: 8000)"),
    },
  },
  async ({ url, selector, page, max_tokens: maxTokens }) => {
    try {
      const response = await handleFetch(url, selector, page ?? 1, maxTokens ?? 8000);
      return { content: [{ type: "text" as const, text: formatResponse(response) }] };
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
