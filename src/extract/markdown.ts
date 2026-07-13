/**
 * extract/markdown.ts — HTML→Markdown変換パイプライン。
 *
 * linkedomでパース → J2 ruby除去 → J8 同意バナー除去 → 品質スコア用統計の採取(元DOM全体)
 * → 本文抽出(優先順: selector指定 > J7サイトアダプタ > Readability > Phase 4ジオメトリ抽出
 *   > body全体フォールバック) → turndown(GFM)でMarkdown化 → J3 CJK正規化。
 *
 * 設計判断:
 * - selectorは「抽出前にDOMへ適用」(plan.md)の記述に基づき、アダプタ・Readability・
 *   ジオメトリ抽出の全てより優先する。selector指定時はユーザーが本文位置を明示している
 *   とみなし、それら全てのヒューリスティックをスキップする(誤って削らないため)。
 * - J7サイトアダプタは自動判定(ユーザー指定ではない)なので、選択した要素の中にも
 *   J4 fit-pruningを適用する(アダプタのセレクタがコメント欄等まで含んでしまうケースの保険)。
 * - 品質スコア用の統計(qualityInput)はプルーニング/バナー除去後・selector適用前の
 *   ドキュメント全体から採取する。バナーは常にノイズなので統計からは除外し、
 *   ページ全体が視覚情報に依存しているかどうかを判定したい。
 * - Phase 4ジオメトリ抽出: Readabilityが本文を特定できない(MIN_READABILITY_TEXT_LENGTH未満)
 *   場合、body全体ダンプへ即座にフォールバックする前に、ブラウザ昇格時のみ利用可能な
 *   ジオメトリデータ(bounding box)から主コンテンツ領域を推定する(div soup/テーブル
 *   レイアウト対策)。それも失敗した場合のみ最終手段としてbody全体を使う。
 */
import { Readability } from "@mozilla/readability";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { findAdapter } from "../adapters/index.js";
import { ExtractionError } from "../errors.js";
import { normalizeCjkText, stripRubyAnnotations } from "../jp/normalize.js";
import { removeConsentBanners, type ConsentBannerHostDocument } from "../jp/consentBanner.js";
import { estimateTokens } from "../tokens.js";
import { computeVisualAreaRatio, selectMainContentCluster, type PageGeometrySnapshot } from "./geometry.js";
import { type QualityScoreInput } from "./qualityScore.js";
import { pruneLowValueBlocks, type PruneHostElement } from "./pruning.js";

export interface ExtractOptions {
  url?: string;
  /** CSSセレクタでDOMを絞り込んでから変換する(指定時はアダプタ/Readability/J4 pruning/ジオメトリ抽出をスキップ)。 */
  selector?: string;
  /** Phase 4: ブラウザ昇格時に採取したジオメトリデータ(HTTP tierやhttp未昇格時はnull/未指定)。 */
  geometry?: PageGeometrySnapshot | null;
}

/** どの経路で本文候補HTMLを得たか(観測性向上・メタデータ表示用)。 */
export type ExtractionMethod = "selector" | "adapter" | "readability" | "geometry" | "body-fallback";

export interface ExtractResult {
  title: string | null;
  markdown: string;
  /** J4 fit-pruningで除去したブロック数(selector指定時は常に0)。 */
  prunedBlockCount: number;
  /** 品質スコア(mode: autoでのスクリーンショット自動切替判定)の入力統計。 */
  qualityInput: QualityScoreInput;
  /** J7サイトアダプタが適用された場合、その識別名(selector指定時・未一致時はnull)。 */
  adapterName: string | null;
  extractionMethod: ExtractionMethod;
}

const MIN_READABILITY_TEXT_LENGTH = 200;
const LEAF_ELEMENT_SELECTOR = "p, li, td, th, span, div, canvas, svg, img, h1, h2, h3, h4, h5, h6, a, blockquote";
// J6の画像面積比の基準ページ面積(px^2)。実レイアウトを取得できないHTTP tierでも使える
// 固定近似値として、screenshot.tsの既定タイルサイズ(1280x1080)に揃えている。
const REFERENCE_PAGE_AREA = 1280 * 1080;

function createTurndownService(): TurndownService {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  service.use(gfm);
  return service;
}

interface QualityElement {
  remove(): void;
  textContent: string;
  getAttribute(name: string): string | null;
}

interface QualityHostElement extends PruneHostElement {
  cloneNode(deep: boolean): QualityHostElement;
  querySelectorAll(selector: string): ArrayLike<QualityElement>;
}

/** J6: img要素の面積占有率(近似)とalt欠落率を集計する。 */
function collectImageStats(body: QualityHostElement): { imgCount: number; imgMissingAltCount: number; imgAreaRatio: number } {
  const imgs = Array.from(body.querySelectorAll("img"));
  let totalArea = 0;
  let missingAlt = 0;

  for (const img of imgs) {
    const width = Number(img.getAttribute("width")) || 0;
    const height = Number(img.getAttribute("height")) || 0;
    totalArea += width * height;
    if (img.getAttribute("alt") === null) missingAlt++;
  }

  return {
    imgCount: imgs.length,
    imgMissingAltCount: missingAlt,
    imgAreaRatio: Math.min(totalArea / REFERENCE_PAGE_AREA, 1),
  };
}

/** 品質スコア判定用の統計を、元ドキュメント全体(script/style除く)から採取する。 */
function collectQualityInput(document: { body: QualityHostElement | null }, geometry: PageGeometrySnapshot | null | undefined): QualityScoreInput {
  const body = document.body;
  if (!body) {
    return {
      extractedTextLength: 0,
      visibleTextLength: 0,
      tableCellCount: 0,
      canvasCount: 0,
      svgCount: 0,
      totalLeafElementCount: 0,
      imgCount: 0,
      imgMissingAltCount: 0,
      imgAreaRatio: 0,
      extractedTokenEstimate: 0,
    };
  }

  // 元のDOMを変更しないよう、複製上でscript/style/noscriptを取り除いてから可視テキストを測る
  const clone = body.cloneNode(true);
  for (const el of Array.from(clone.querySelectorAll("script, style, noscript"))) {
    el.remove();
  }

  const visibleTextLength = (clone.textContent ?? "").replace(/\s+/g, "").length;
  const tableCellCount = body.querySelectorAll("td, th").length;
  const canvasCount = body.querySelectorAll("canvas").length;
  const svgCount = body.querySelectorAll("svg").length;
  const totalLeafElementCount = body.querySelectorAll(LEAF_ELEMENT_SELECTOR).length;
  const imageStats = collectImageStats(body);

  // Phase 4: ブラウザ昇格時は実ジオメトリから視覚要素占有率を計算し、近似値より優先させる。
  // table要素分の占有率も別途計算し、qualityScore.ts側で表由来分/canvas・svg由来分を
  // 分離できるようにする(表がGFMテーブルとして正しく抽出できているページの誤判定対策)。
  const validGeometry = geometry && geometry.pageWidth > 0 && geometry.pageHeight > 0 ? geometry : null;
  const geometryAreaRatios = validGeometry
    ? {
        realVisualAreaRatio: computeVisualAreaRatio(validGeometry.visualElements, validGeometry.pageWidth, validGeometry.pageHeight),
        realTableAreaRatio: computeVisualAreaRatio(
          validGeometry.visualElements.filter((el) => el.tag === "table"),
          validGeometry.pageWidth,
          validGeometry.pageHeight,
        ),
      }
    : null;

  return {
    extractedTextLength: 0, // Markdown生成後に上書きする
    visibleTextLength,
    tableCellCount,
    canvasCount,
    svgCount,
    totalLeafElementCount,
    ...imageStats,
    extractedTokenEstimate: 0, // Markdown生成後に上書きする
    ...(geometryAreaRatios ?? {}),
  };
}

/** PruneHostElementのquerySelectorAllを、除去操作にも使えるよう戻り値を共変で狭めたもの。 */
interface AdapterElement extends PruneHostElement {
  outerHTML: string;
  querySelectorAll(selector: string): ArrayLike<{ remove(): void; textContent: string }>;
}

interface AdapterHostDocument {
  querySelector(selector: string): AdapterElement | null;
}

/** J7: アダプタのcontentSelectors候補を先頭から試し、最初に見つかった要素を返す。 */
function selectAdapterContent(document: AdapterHostDocument, selectors: string[]): AdapterElement | null {
  for (const selector of selectors) {
    const match = document.querySelector(selector);
    if (match) return match;
  }
  return null;
}

interface GeometryHostElement {
  outerHTML: string;
  getAttribute(name: string): string | null;
}

interface GeometryHostDocument {
  querySelectorAll(selector: string): ArrayLike<GeometryHostElement>;
}

/**
 * Phase 4: ジオメトリクラスタ(主コンテンツ領域と推定されたテキストブロック群)から、
 * 対応するDOM要素(data-amenbo-gid経由で再選択)のHTMLをクラスタ内の並び順で組み立てる。
 * クラスタの総テキスト量がReadabilityと同じ最低ラインに満たない場合はnullを返す
 * (ジオメトリでも本文らしきものが見つからなかった、という扱い)。
 */
function extractByGeometry(document: GeometryHostDocument, geometry: PageGeometrySnapshot): string | null {
  const cluster = selectMainContentCluster(geometry.textBlocks);
  if (!cluster || cluster.totalTextLength < MIN_READABILITY_TEXT_LENGTH) return null;

  const elementById = new Map<number, GeometryHostElement>();
  for (const el of Array.from(document.querySelectorAll("[data-amenbo-gid]"))) {
    const id = Number(el.getAttribute("data-amenbo-gid"));
    if (!Number.isNaN(id)) elementById.set(id, el);
  }

  const htmlParts = cluster.blockIds.map((id) => elementById.get(id)?.outerHTML).filter((part): part is string => Boolean(part));
  return htmlParts.length > 0 ? htmlParts.join("\n") : null;
}

/** HTML文字列をMarkdownへ変換する。 */
/** collectDataTables/救出が必要とするDOM要素の最小インターフェース(linkedom/ブラウザDOM双方と互換)。 */
interface TableCandidate {
  tagName: string;
  outerHTML: string;
  textContent: string;
  parentElement: TableCandidate | null;
  closest(selector: string): TableCandidate | null;
  querySelectorAll(selector: string): ArrayLike<TableCandidate>;
}

interface TableQueryHost {
  querySelectorAll(selector: string): ArrayLike<TableCandidate>;
}

/** 挿入先ノード(Readability出力を再パースした要素)の最小インターフェース。 */
interface InsertHostElement {
  textContent: string;
  insertAdjacentHTML(position: "afterend", html: string): void;
}

interface InsertHost {
  body: {
    innerHTML: string;
    querySelectorAll(selector: string): ArrayLike<InsertHostElement>;
  };
}

/** 救出対象のデータ表。位置復元のため直前の見出し/段落テキストをアンカーとして持つ。 */
export interface DroppedTable {
  /** turndownへ渡す正規化済みHTML(colspan/rowspan展開・多段ヘッダ結合後)。 */
  html: string;
  /** 元の表テキスト先頭。Readability出力に既にある表かの重複判定に使う(正規化前基準)。 */
  signature: string;
  /** 表の直前の見出し(優先)または近傍段落の正規化テキスト。位置復元のアンカー。無ければ空。 */
  anchor: string;
}

const ANCHOR_MAX_LENGTH = 80;
const ANCHOR_MIN_PARAGRAPH_LENGTH = 30;
const MAX_SPAN = 1000;

/** collapsed/rowspan/多段ヘッダを持つ表を正規化するためのDOM最小インターフェース。 */
interface NormCell {
  tagName: string;
  getAttribute(name: string): string | null;
  innerHTML: string;
}
interface NormRow {
  closest(selector: string): unknown;
  children: ArrayLike<NormCell>;
}
interface NormTable {
  querySelectorAll(selector: string): ArrayLike<NormRow>;
}
interface GridCell {
  html: string;
}

/** colspan/rowspan属性値を1以上MAX_SPAN以下の整数へ丸める(異常値ガード)。 */
function clampSpan(value: string | null): number {
  const n = Number.parseInt(value ?? "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_SPAN);
}

/**
 * turndownのGFMテーブル変換はcolspan/rowspan・多段ヘッダを扱えず列ズレや空セルを生む。
 * グリッドを再構築してspanを実セルへ展開し、先頭の連続ヘッダ行は1行へ結合してから
 * 全行同一列数の単純表を返す。救出経路の表のみに適用する(影響を局所化)。
 */
export function normalizeTableHtml(tableHtml: string): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${tableHtml}</body></html>`);
  const tableEl = document.querySelector("table");
  if (!tableEl) return tableHtml;
  const table = tableEl as unknown as NormTable;

  // 入れ子の表の行を巻き込まないよう、直接の行(closestが自表と一致)だけを対象にする。
  const rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === tableEl);
  const rowCount = rows.length;
  if (rowCount === 0) return tableHtml;

  const grid: Array<Array<GridCell | undefined>> = Array.from({ length: rowCount }, () => []);
  const isHeaderRow: boolean[] = [];

  for (let r = 0; r < rowCount; r++) {
    const cells = Array.from(rows[r]!.children).filter((el) => el.tagName === "TD" || el.tagName === "TH");
    isHeaderRow[r] = cells.length > 0 && cells.every((cell) => cell.tagName === "TH");
    let c = 0;
    for (const cell of cells) {
      while (grid[r]![c] !== undefined) c++;
      const colspan = clampSpan(cell.getAttribute("colspan"));
      const rowspan = clampSpan(cell.getAttribute("rowspan"));
      const filled: GridCell = { html: cell.innerHTML.trim() };
      for (let i = 0; i < rowspan && r + i < rowCount; i++) {
        for (let j = 0; j < colspan; j++) {
          grid[r + i]![c + j] = filled;
        }
      }
      c += colspan;
    }
  }

  const numCols = grid.reduce((max, row) => Math.max(max, row.length), 0);
  if (numCols === 0) return tableHtml;

  let headerCount = 0;
  while (headerCount < rowCount && isHeaderRow[headerCount]) headerCount++;

  const cellHtml = (r: number, c: number): string => grid[r]?.[c]?.html ?? "";
  const out: string[] = ["<table>"];
  const emitRow = (cells: string[], tag: "th" | "td"): void => {
    out.push(`<tr>${cells.map((h) => `<${tag}>${h}</${tag}>`).join("")}</tr>`);
  };

  if (headerCount >= 2) {
    // 多段ヘッダ: 列ごとに上→下のセルを重複除去して連結し、1行のヘッダへ畳む。
    const merged: string[] = [];
    for (let c = 0; c < numCols; c++) {
      const parts: string[] = [];
      for (let r = 0; r < headerCount; r++) {
        const h = cellHtml(r, c);
        if (h && parts[parts.length - 1] !== h) parts.push(h);
      }
      merged.push(parts.join(" "));
    }
    emitRow(merged, "th");
    for (let r = headerCount; r < rowCount; r++) {
      emitRow(Array.from({ length: numCols }, (_, c) => cellHtml(r, c)), "td");
    }
  } else {
    // ヘッダ0/1行: spanの展開のみ行い、行のth/tdは元の判定を踏襲する。
    for (let r = 0; r < rowCount; r++) {
      emitRow(Array.from({ length: numCols }, (_, c) => cellHtml(r, c)), isHeaderRow[r] ? "th" : "td");
    }
  }
  out.push("</table>");
  return out.join("");
}

/** テキストからタグを除きシグネチャ用に空白正規化する。 */
function normalizeForSignature(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * document順に並べた要素列から、tableIndexの表の直前アンカー(見出し優先・無ければ近傍段落)を求める。
 * 見出しは節の先頭に表を戻すのに最適。見出しが皆無なページ用に段落をフォールバックにする。
 */
function findTableAnchor(seq: TableCandidate[], tableIndex: number): string {
  let paragraph = "";
  for (let i = tableIndex - 1; i >= 0; i--) {
    const el = seq[i];
    if (!el || el.tagName === "TABLE") continue; // 別の表は飛ばす。
    const text = normalizeForSignature(el.textContent);
    if (/^H[1-6]$/.test(el.tagName)) {
      if (text.length > 0) return text.slice(0, ANCHOR_MAX_LENGTH); // 見出し優先。
    } else if (!paragraph && text.length >= ANCHOR_MIN_PARAGRAPH_LENGTH) {
      paragraph = text.slice(0, ANCHOR_MAX_LENGTH);
    }
  }
  return paragraph;
}

/**
 * Readabilityが取りこぼしがちなデータ表を、救出候補としてHTML文字列＋位置アンカーで採取する。
 * Readabilityのparseは渡したdocumentを破壊的に変更するため、必ずparse前に呼ぶこと。
 * 最外表のみ(入れ子の表は最外表のouterHTMLに含まれる)・2行以上かつ2列以上のものを
 * 「データ表」とみなす(1列や単一行はレイアウト/リスト相当なので対象外)。
 */
export function collectDataTables(body: TableQueryHost): DroppedTable[] {
  const result: DroppedTable[] = [];
  const seq = Array.from(body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, table"));
  for (let i = 0; i < seq.length; i++) {
    const table = seq[i];
    if (!table || table.tagName !== "TABLE") continue;
    // 入れ子の表は最外表側に含まれるので個別採取しない。
    if (table.parentElement?.closest("table")) continue;
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) continue;
    let maxCells = 0;
    for (const row of rows) {
      const cells = row.querySelectorAll("th, td").length;
      if (cells > maxCells) maxCells = cells;
    }
    if (maxCells < 2) continue;
    result.push({
      html: normalizeTableHtml(table.outerHTML),
      // 重複判定は正規化前の元テキスト基準にする(Readability保持時の照合を安定させる)。
      signature: normalizeForSignature(table.textContent).slice(0, ANCHOR_MAX_LENGTH),
      anchor: findTableAnchor(seq, i),
    });
  }
  return result;
}

/**
 * Readability出力に含まれない表だけを、可能なら元の位置(アンカー直後)へ、無理なら末尾へ再結合する。
 * アンカー(表の直前見出し/段落)がReadability出力に残っていれば、その要素の直後に挿入して
 * 「表が本来属していた節」へ戻す(記事構造=意味の保持)。残っていなければ末尾フォールバック。
 */
export function reinsertDroppedTables(contentHtml: string, tables: DroppedTable[]): { html: string; appended: number } {
  if (tables.length === 0) return { html: contentHtml, appended: 0 };

  // Readabilityが既に保持している表はシグネチャ(元テキスト先頭)で除外する。
  const contentText = normalizeForSignature(contentHtml);
  const missing = tables.filter((table) => table.signature.length > 0 && !contentText.includes(table.signature));
  if (missing.length === 0) return { html: contentHtml, appended: 0 };

  const { document } = parseHTML(`<!DOCTYPE html><html><body>${contentHtml}</body></html>`);
  const host = document as unknown as InsertHost;
  const anchorNodes = Array.from(host.body.querySelectorAll("h1, h2, h3, h4, h5, h6, p"));

  const tail: string[] = [];
  for (const table of missing) {
    const anchorNode = table.anchor
      ? anchorNodes.find((node) => normalizeForSignature(node.textContent).includes(table.anchor))
      : undefined;
    if (anchorNode) {
      anchorNode.insertAdjacentHTML("afterend", table.html);
    } else {
      tail.push(table.html); // アンカーが出力に無い表は末尾へ。
    }
  }

  const inserted = host.body.innerHTML;
  const html = tail.length > 0 ? `${inserted}\n${tail.join("\n")}` : inserted;
  return { html, appended: missing.length };
}

export function extractMarkdown(html: string, options: ExtractOptions = {}): ExtractResult {
  const url = options.url ?? "about:blank";
  const { document } = parseHTML(html);

  stripRubyAnnotations(document);
  removeConsentBanners(document as unknown as ConsentBannerHostDocument);

  // レンダリング可視テキストに近い統計を、プルーニング/selector適用前の元ドキュメントから採取する
  const qualityInput = collectQualityInput(document as unknown as { body: QualityHostElement | null }, options.geometry);

  let contentHtml: string;
  let title: string | null = document.title || null;
  let prunedBlockCount = 0;
  let adapterName: string | null = null;
  let extractionMethod: ExtractionMethod;

  if (options.selector) {
    const matched = Array.from(document.querySelectorAll(options.selector));
    if (matched.length === 0) {
      throw new ExtractionError(url, `selectorに一致する要素がありません: ${options.selector}`);
    }
    contentHtml = matched.map((el) => el.outerHTML).join("\n");
    extractionMethod = "selector";
  } else {
    const hostname = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    const adapter = hostname ? findAdapter(hostname) : null;
    const adapterElement = adapter ? selectAdapterContent(document as unknown as AdapterHostDocument, adapter.contentSelectors) : null;

    if (adapter && adapterElement) {
      for (const removeSelector of adapter.removeSelectors ?? []) {
        for (const el of Array.from(adapterElement.querySelectorAll(removeSelector))) {
          el.remove();
        }
      }
      prunedBlockCount = pruneLowValueBlocks(adapterElement);
      contentHtml = adapterElement.outerHTML;
      adapterName = adapter.name;
      extractionMethod = "adapter";
    } else {
      if (document.body) {
        prunedBlockCount = pruneLowValueBlocks(document.body);
      }

      // Readabilityはリンク密度の高いデータ表(各国人口ソート表等)を本文から丸ごと落とすことがある。
      // parseは渡したdocumentを破壊的に変更するため、parse前に救出候補の表を位置アンカー付きで採取しておく。
      const dataTables = document.body ? collectDataTables(document.body as unknown as TableQueryHost) : [];

      const article = new Readability(document).parse();
      const geometryHtml = options.geometry ? extractByGeometry(document as unknown as GeometryHostDocument, options.geometry) : null;

      if (article && article.content && (article.textContent ?? "").trim().length >= MIN_READABILITY_TEXT_LENGTH) {
        // Readabilityが取りこぼしたデータ表を、可能なら元の位置へ戻して本文へ再結合する。
        contentHtml = reinsertDroppedTables(article.content, dataTables).html;
        title = article.title || title;
        extractionMethod = "readability";
      } else if (geometryHtml) {
        // Phase 4: Readabilityが貧弱(かつアダプタ非該当)な場合、body全体ダンプの前に
        // ブラウザ昇格時のジオメトリ(bounding box)から主コンテンツ領域を推定する
        contentHtml = geometryHtml;
        extractionMethod = "geometry";
      } else if (document.body) {
        // Readability/ジオメトリいずれも本文を特定できない場合はbody全体にフォールバックする
        contentHtml = document.body.innerHTML;
        extractionMethod = "body-fallback";
      } else {
        throw new ExtractionError(url, "本文と判定できる要素がありません");
      }
    }
  }

  const turndown = createTurndownService();
  const rawMarkdown = turndown.turndown(contentHtml).trim();
  const markdown = normalizeCjkText(rawMarkdown);

  return {
    title,
    markdown,
    prunedBlockCount,
    qualityInput: { ...qualityInput, extractedTextLength: markdown.length, extractedTokenEstimate: estimateTokens(markdown) },
    adapterName,
    extractionMethod,
  };
}
