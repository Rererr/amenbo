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
 *
 * ツール登録・エラーラッピング・stdioトランスポート接続のみを担当する。
 * politeness/cacheのシングルトンやツールハンドラの実処理はcore.ts(CLIと共有)にある。
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  formatLinksResponse,
  handleFetchTool,
  handleScreenshotTool,
  politeness,
  resolvePackageVersion,
} from "./core.js";
import { AmenboError } from "./errors.js";
import { discoverLinks } from "./links.js";

// テスト用export(既存スタイルに合わせた最小のテスト可能化。InMemoryTransport経由の
// MCP progress notifications統合テストでclient.connect()の相手として使う)。
export const server = new McpServer({ name: "amenbo", version: resolvePackageVersion() });

/**
 * MCP progress notifications: リクエストにprogressToken(_meta.progressToken)が付いている
 * クライアントに対してのみ、進捗メッセージをホストUIへ通知するコールバックを組み立てる。
 * progressTokenが無い(=進捗通知に対応しない/希望しないクライアント)場合はundefinedを返し、
 * core.ts側の各通知ポイントは呼び出し自体を行わない(条件分岐のみでオーバーヘッドは実質ゼロ)。
 *
 * sendNotificationはtotalを送らない(処理量が事前に不定なため)。失敗はツール本処理を
 * 壊さないようベストエフォートで握りつぶし、原因のみstderrへ記録する。
 */
function buildProgressNotifier(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): ((message: string) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;

  let progress = 0;
  return (message: string) => {
    progress += 1;
    void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } }).catch((error: unknown) => {
      console.error("進捗通知(notifications/progress)の送信に失敗しました:", error);
    });
  };
}

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
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ url, mode, selector, section, page, max_tokens: maxTokens, force_full: forceFull }, extra) => {
    try {
      const onProgress = buildProgressNotifier(extra);
      const content = await handleFetchTool({ url, mode, selector, section, page, max_tokens: maxTokens, force_full: forceFull, onProgress });
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
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
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
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ url, fullPage, width, scale }, extra) => {
    try {
      const onProgress = buildProgressNotifier(extra);
      const content = await handleScreenshotTool({ url, fullPage, width, scale, onProgress });
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

/** MCP stdioサーバーを起動する。CLI(cli.ts)が引数なし/`serve`サブコマンド時に呼ぶ後方互換経路でもある。 */
export async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * このモジュールが直接実行された(node dist/server.js / tsx src/server.ts / binエントリ経由)場合のみ
 * trueを返す。テスト(vitest)がformatHandoffResponse等のユニットテストのためにこのファイルを
 * importした際、stdioトランスポート接続(runServer())が誤って走ってテストプロセスがハングするのを防ぐ。
 *
 * npm/npx経由の実行ではprocess.argv[1]がnode_modules/.bin配下のシンボリックリンクのパスになる一方、
 * fileURLToPath(import.meta.url)はリンクを解決した実体パスになるため、realpathSyncで両者を揃えてから比較する。
 */
function isDirectlyExecuted(): boolean {
  return typeof process.argv[1] === "string" && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
}

if (isDirectlyExecuted()) {
  runServer().catch((error: unknown) => {
    console.error("amenboサーバーの起動に失敗しました:", error);
    process.exit(1);
  });
}
