/**
 * extract/markdown.ts — HTML→Markdown変換パイプライン。
 *
 * linkedomでパース → (selector指定時はDOM段階で絞り込み) → J2 ruby除去
 * → (selector未指定時のみ)Readabilityで本文抽出 → turndown(GFM)でMarkdown化
 * → J3 CJK正規化。
 *
 * 設計判断: selectorは「抽出前にDOMへ適用」(plan.md)の記述に基づき、
 * Readabilityの本文推定より優先する。selector指定時はユーザーが本文位置を
 * 明示しているとみなし、Readabilityのヒューリスティックをスキップする。
 */
import { Readability } from "@mozilla/readability";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { ExtractionError } from "../errors.js";
import { normalizeCjkText, stripRubyAnnotations } from "../jp/normalize.js";

export interface ExtractOptions {
  url?: string;
  /** CSSセレクタでDOMを絞り込んでから変換する(指定時はReadabilityをスキップ)。 */
  selector?: string;
}

export interface ExtractResult {
  title: string | null;
  markdown: string;
}

const MIN_READABILITY_TEXT_LENGTH = 200;

function createTurndownService(): TurndownService {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  service.use(gfm);
  return service;
}

/** HTML文字列をMarkdownへ変換する。 */
export function extractMarkdown(html: string, options: ExtractOptions = {}): ExtractResult {
  const url = options.url ?? "about:blank";
  const { document } = parseHTML(html);

  stripRubyAnnotations(document);

  let contentHtml: string;
  let title: string | null = document.title || null;

  if (options.selector) {
    const matched = Array.from(document.querySelectorAll(options.selector));
    if (matched.length === 0) {
      throw new ExtractionError(url, `selectorに一致する要素がありません: ${options.selector}`);
    }
    contentHtml = matched.map((el) => el.outerHTML).join("\n");
  } else {
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

  return { title, markdown };
}
