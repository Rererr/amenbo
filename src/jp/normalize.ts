/**
 * J1-J3: 日本語Webページ向けの正規化処理。
 *
 * - stripRubyAnnotations: J2 ruby正規化(DOM段階で <rt>/<rp> を除去し、読み仮名の本文二重化を防ぐ)
 * - normalizeCjkText: J3 CJKテキスト正規化(NFKC・全角英数→半角・Turndownが挿入する
 *   CJK文字間の不要な空白/改行の除去)。Markdown化後の文字列に対して適用し、
 *   フェンスコードブロック(```)とインラインコード(`...`)の中身は変更しない。
 */

/** DOM要素の最小インターフェース(linkedom/ブラウザDOM双方と構造的に互換)。 */
interface RemovableElement {
  remove(): void;
}

/** ruby要素の除去対象を検索できる最小限のDocument互換インターフェース。 */
export interface RubyHostDocument {
  querySelectorAll(selectors: string): ArrayLike<RemovableElement> | Iterable<RemovableElement>;
}

/**
 * J2: DOM上の <rt>(読み仮名)・<rp>(括弧等の補助表示)要素を除去する。
 * Markdown変換前のDOM段階で行うことで、「漢字かんじ」のような読み仮名の
 * 本文への混入(トークン浪費・検索性劣化)を防ぐ。
 */
export function stripRubyAnnotations(document: RubyHostDocument): void {
  const nodes = Array.from(document.querySelectorAll("rt, rp") as Iterable<RemovableElement>);
  for (const node of nodes) {
    node.remove();
  }
}

// CJK文字クラス(tokens.ts の isCjkCodePoint と同じ範囲。全角/CJK記号のスペース(U+3000/U+FF00)は除く)
const CJK_CLASS = "\\u3040-\\u309f\\u30a0-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3001-\\u303f\\uff01-\\uffef";

// CJK文字同士の間にある空白・単一改行(段落区切りの空行は除く)を除去する
const CJK_ADJACENT_WHITESPACE = new RegExp(
  `(?<=[${CJK_CLASS}])(?:[ \\t]|\\r?\\n(?!\\r?\\n))+(?=[${CJK_CLASS}])`,
  "gu",
);

// Markdownのフェンスコードブロック / インラインコードを保護するためのパターン
const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;

interface TextSegment {
  isCode: boolean;
  text: string;
}

/** Markdown文字列をコード区間(保護対象)とそれ以外(正規化対象)に分割する。 */
function splitProtectingCode(markdown: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const match of markdown.matchAll(CODE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ isCode: false, text: markdown.slice(lastIndex, index) });
    }
    segments.push({ isCode: true, text: match[0] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < markdown.length) {
    segments.push({ isCode: false, text: markdown.slice(lastIndex) });
  }

  return segments;
}

/** コード以外の地の文に対して NFKC正規化 + CJK隣接空白除去を適用する。 */
function normalizeProse(text: string): string {
  const nfkc = text.normalize("NFKC");
  return nfkc.replace(CJK_ADJACENT_WHITESPACE, "");
}

/**
 * J3: CJKテキスト正規化。
 * pre/code由来のフェンスコード・インラインコードの中身は変更せず、
 * それ以外の地の文にのみ NFKC正規化(全角英数→半角を含む)と
 * CJK文字間の不要な空白・改行の除去を適用する。
 */
export function normalizeCjkText(markdown: string): string {
  return splitProtectingCode(markdown)
    .map((segment) => (segment.isCode ? segment.text : normalizeProse(segment.text)))
    .join("");
}
