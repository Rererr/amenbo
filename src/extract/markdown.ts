/**
 * extract/markdown.ts — HTML→Markdown変換パイプライン。
 *
 * linkedomでパース → J2 ruby除去 → 品質スコア用統計の採取(元DOM全体)
 * → (selector指定時はDOM段階で絞り込み。それ以外はJ4 fit-pruningでナビ/広告等を除去してから
 * Readabilityで本文抽出) → turndown(GFM)でMarkdown化 → J3 CJK正規化。
 *
 * 設計判断:
 * - selectorは「抽出前にDOMへ適用」(plan.md)の記述に基づき、Readabilityの本文推定より優先する。
 *   selector指定時はユーザーが本文位置を明示しているとみなし、Readabilityおよび
 *   J4 fit-pruningの両方をスキップする(ユーザーが明示した要素をヒューリスティックで
 *   誤って削らないため)。
 * - 品質スコア用の統計(qualityInput)はプルーニング前・selector適用前の元ドキュメント全体から
 *   採取する。ページ全体が視覚情報に依存しているかどうかを判定したいため。
 */
import { Readability } from "@mozilla/readability";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { ExtractionError } from "../errors.js";
import { normalizeCjkText, stripRubyAnnotations } from "../jp/normalize.js";
import { type QualityScoreInput } from "./qualityScore.js";
import { pruneLowValueBlocks, type PruneHostElement } from "./pruning.js";

export interface ExtractOptions {
  url?: string;
  /** CSSセレクタでDOMを絞り込んでから変換する(指定時はReadability/J4 pruningをスキップ)。 */
  selector?: string;
}

export interface ExtractResult {
  title: string | null;
  markdown: string;
  /** J4 fit-pruningで除去したブロック数(selector指定時は常に0)。 */
  prunedBlockCount: number;
  /** 品質スコア(mode: autoでのスクリーンショット自動切替判定)の入力統計。 */
  qualityInput: QualityScoreInput;
}

const MIN_READABILITY_TEXT_LENGTH = 200;
const LEAF_ELEMENT_SELECTOR = "p, li, td, th, span, div, canvas, svg, img, h1, h2, h3, h4, h5, h6, a, blockquote";

function createTurndownService(): TurndownService {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  service.use(gfm);
  return service;
}

interface QualityHostElement extends PruneHostElement {
  cloneNode(deep: boolean): QualityHostElement;
  querySelectorAll(selector: string): ArrayLike<{ remove(): void; textContent: string }>;
}

/** 品質スコア判定用の統計を、元ドキュメント全体(script/style除く)から採取する。 */
function collectQualityInput(document: { body: QualityHostElement | null }): QualityScoreInput {
  const body = document.body;
  if (!body) {
    return { extractedTextLength: 0, visibleTextLength: 0, tableCellCount: 0, canvasCount: 0, svgCount: 0, totalLeafElementCount: 0 };
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

  return {
    extractedTextLength: 0, // Markdown生成後に上書きする
    visibleTextLength,
    tableCellCount,
    canvasCount,
    svgCount,
    totalLeafElementCount,
  };
}

/** HTML文字列をMarkdownへ変換する。 */
export function extractMarkdown(html: string, options: ExtractOptions = {}): ExtractResult {
  const url = options.url ?? "about:blank";
  const { document } = parseHTML(html);

  stripRubyAnnotations(document);

  // レンダリング可視テキストに近い統計を、プルーニング/selector適用前の元ドキュメントから採取する
  const qualityInput = collectQualityInput(document as unknown as { body: QualityHostElement | null });

  let contentHtml: string;
  let title: string | null = document.title || null;
  let prunedBlockCount = 0;

  if (options.selector) {
    const matched = Array.from(document.querySelectorAll(options.selector));
    if (matched.length === 0) {
      throw new ExtractionError(url, `selectorに一致する要素がありません: ${options.selector}`);
    }
    contentHtml = matched.map((el) => el.outerHTML).join("\n");
  } else {
    if (document.body) {
      prunedBlockCount = pruneLowValueBlocks(document.body);
    }

    const article = new Readability(document).parse();
    if (article && article.content && (article.textContent ?? "").trim().length >= MIN_READABILITY_TEXT_LENGTH) {
      contentHtml = article.content;
      title = article.title || title;
    } else if (document.body) {
      // Readabilityが本文を特定できない場合はbody全体にフォールバックする
      contentHtml = document.body.innerHTML;
    } else {
      throw new ExtractionError(url, "本文と判定できる要素がありません");
    }
  }

  const turndown = createTurndownService();
  const rawMarkdown = turndown.turndown(contentHtml).trim();
  const markdown = normalizeCjkText(rawMarkdown);

  return { title, markdown, prunedBlockCount, qualityInput: { ...qualityInput, extractedTextLength: markdown.length } };
}
