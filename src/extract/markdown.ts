/**
 * extract/markdown.ts — HTML→Markdown変換パイプライン。
 *
 * linkedomでパース → J2 ruby除去 → J8 同意バナー除去 → 品質スコア用統計の採取(元DOM全体)
 * → 本文抽出(優先順: selector指定 > J7サイトアダプタ > J4 fit-pruning+Readability)
 * → turndown(GFM)でMarkdown化 → J3 CJK正規化。
 *
 * 設計判断:
 * - selectorは「抽出前にDOMへ適用」(plan.md)の記述に基づき、アダプタ・Readabilityの
 *   両方より優先する。selector指定時はユーザーが本文位置を明示しているとみなし、
 *   J7アダプタ・Readability・J4 fit-pruningの全てをスキップする(ユーザーが明示した要素を
 *   ヒューリスティックで誤って削らないため)。
 * - J7サイトアダプタは自動判定(ユーザー指定ではない)なので、選択した要素の中にも
 *   J4 fit-pruningを適用する(アダプタのセレクタがコメント欄等まで含んでしまうケースの保険)。
 * - 品質スコア用の統計(qualityInput)はプルーニング/バナー除去後・selector適用前の
 *   ドキュメント全体から採取する。バナーは常にノイズなので統計からは除外し、
 *   ページ全体が視覚情報に依存しているかどうかを判定したい。
 */
import { Readability } from "@mozilla/readability";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { findAdapter } from "../adapters/index.js";
import { ExtractionError } from "../errors.js";
import { normalizeCjkText, stripRubyAnnotations } from "../jp/normalize.js";
import { removeConsentBanners, type ConsentBannerHostDocument } from "../jp/consentBanner.js";
import { type QualityScoreInput } from "./qualityScore.js";
import { pruneLowValueBlocks, type PruneHostElement } from "./pruning.js";

export interface ExtractOptions {
  url?: string;
  /** CSSセレクタでDOMを絞り込んでから変換する(指定時はアダプタ/Readability/J4 pruningをスキップ)。 */
  selector?: string;
}

export interface ExtractResult {
  title: string | null;
  markdown: string;
  /** J4 fit-pruningで除去したブロック数(selector指定時は常に0)。 */
  prunedBlockCount: number;
  /** 品質スコア(mode: autoでのスクリーンショット自動切替判定)の入力統計。 */
  qualityInput: QualityScoreInput;
  /** J7サイトアダプタが適用された場合、その識別名(selector指定時・未一致時はnull)。 */
  adapterName: string | null;
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
function collectQualityInput(document: { body: QualityHostElement | null }): QualityScoreInput {
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

  return {
    extractedTextLength: 0, // Markdown生成後に上書きする
    visibleTextLength,
    tableCellCount,
    canvasCount,
    svgCount,
    totalLeafElementCount,
    ...imageStats,
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

/** HTML文字列をMarkdownへ変換する。 */
export function extractMarkdown(html: string, options: ExtractOptions = {}): ExtractResult {
  const url = options.url ?? "about:blank";
  const { document } = parseHTML(html);

  stripRubyAnnotations(document);
  removeConsentBanners(document as unknown as ConsentBannerHostDocument);

  // レンダリング可視テキストに近い統計を、プルーニング/selector適用前の元ドキュメントから採取する
  const qualityInput = collectQualityInput(document as unknown as { body: QualityHostElement | null });

  let contentHtml: string;
  let title: string | null = document.title || null;
  let prunedBlockCount = 0;
  let adapterName: string | null = null;

  if (options.selector) {
    const matched = Array.from(document.querySelectorAll(options.selector));
    if (matched.length === 0) {
      throw new ExtractionError(url, `selectorに一致する要素がありません: ${options.selector}`);
    }
    contentHtml = matched.map((el) => el.outerHTML).join("\n");
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
  }

  const turndown = createTurndownService();
  const rawMarkdown = turndown.turndown(contentHtml).trim();
  const markdown = normalizeCjkText(rawMarkdown);

  return {
    title,
    markdown,
    prunedBlockCount,
    qualityInput: { ...qualityInput, extractedTextLength: markdown.length },
    adapterName,
  };
}
