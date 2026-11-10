/**
 * J1-J3: 日本語Webページ向けの正規化処理。
 *
 * - stripRubyAnnotations: J2 ruby正規化(DOM段階で <rt>/<rp> を除去し、読み仮名の本文二重化を防ぐ)
 * - normalizeCjkText: J3 CJKテキスト正規化(全半角の統一・Turndownが挿入する
 *   CJK文字間の不要な空白/改行の除去)。Markdown化後の文字列に対して適用し、
 *   フェンスコードブロックとインラインコード(`...`)の中身は変更しない。
 */

import { createFenceScanner } from "../markdownFence.js";

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

// turndownが<br>に出す強制改行(行末の空白2つ以上+改行)。CJKに挟まれていても行の区切りとして残す
// (住所・電話番号・営業時間を<br>で並べる会社概要などで、行が連結されるのを防ぐ)。
const HARD_LINE_BREAK = /[ \t]{2,}\r?\n/;

// Turndownは<strong>/<em>等をCJKに隣接して変換する際、Markdownの曖昧性回避のため
// "とても **重要** です" のように装飾記号の前後へ空白を挿入することがある。
// 日本語の地の文では強調記号の前後に空白は不要なため、装飾記号(*_~)越しにCJKが
// 隣接している場合もその空白を除去する(Phase 2で残課題としていたJ3の拡張)。
const CJK_SPACE_BEFORE_MARKER = new RegExp(`(?<=[${CJK_CLASS}])[ \\t]+(?=[*_~]{1,3}[${CJK_CLASS}])`, "gu");
const CJK_SPACE_AFTER_MARKER = new RegExp(`(?<=[${CJK_CLASS}][*_~]{1,3})[ \\t]+(?=[${CJK_CLASS}])`, "gu");

// インラインコードを保護するためのパターン(フェンスコードブロックは行単位でcreateFenceScannerが判定する)
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;

interface TextSegment {
  isCode: boolean;
  text: string;
}

/** 地の文をインラインコード(保護対象)とそれ以外に分割して segments へ足す。 */
function pushProseSegments(segments: TextSegment[], prose: string): void {
  let lastIndex = 0;
  for (const match of prose.matchAll(INLINE_CODE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ isCode: false, text: prose.slice(lastIndex, index) });
    segments.push({ isCode: true, text: match[0] });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < prose.length) segments.push({ isCode: false, text: prose.slice(lastIndex) });
}

/** Markdown文字列をコード区間(保護対象)とそれ以外(正規化対象)に分割する。 */
function splitProtectingCode(markdown: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const inCode = createFenceScanner();
  const lines = markdown.split("\n");
  let start = 0;
  let startIsCode = false;
  let offset = 0;

  const flush = (end: number): void => {
    if (end <= start) return;
    const text = markdown.slice(start, end);
    if (startIsCode) segments.push({ isCode: true, text });
    else pushProseSegments(segments, text);
  };

  lines.forEach((line, i) => {
    const isCode = inCode(line);
    if (i === 0) startIsCode = isCode;
    else if (isCode !== startIsCode) {
      flush(offset);
      start = offset;
      startIsCode = isCode;
    }
    offset += line.length + 1;
  });
  flush(markdown.length);

  return segments;
}

// 全半角の統一の対象: 全角英数・記号と半角カナ(U+FF01-U+FFEE)、全角空白などの空白類。
// 文字列全体へのNFKCは使わない: 上付き・分数・単位記号・囲み文字などの互換文字まで
// 書き換え、意味を変える(m²→m2、10⁻³→10−3、㎡→m2、①→1)。
const WIDTH_VARIANTS = /[\u00a0\u2000-\u200a\u202f\u205f\u3000\uff01-\uffee]+/g;

/** 全半角を統一する。分解されたかなの合成(NFC)は全体にかける。 */
function unifyWidth(text: string): string {
  return text.normalize("NFC").replace(WIDTH_VARIANTS, (run) => run.normalize("NFKC"));
}

/** コード以外の地の文に対して 全半角の統一 + CJK隣接空白除去を適用する。 */
function normalizeProse(text: string): string {
  return unifyWidth(text)
    .replace(CJK_ADJACENT_WHITESPACE, (run) => (HARD_LINE_BREAK.test(run) ? run : ""))
    .replace(CJK_SPACE_BEFORE_MARKER, "")
    .replace(CJK_SPACE_AFTER_MARKER, "");
}

/**
 * J3: CJKテキスト正規化。
 * pre/code由来のフェンスコード・インラインコードの中身は変更せず、
 * それ以外の地の文にのみ全半角の統一(全角英数→半角・半角カナ→全角)と
 * CJK文字間の不要な空白・改行の除去を適用する。
 */
export function normalizeCjkText(markdown: string): string {
  return splitProtectingCode(markdown)
    .map((segment) => (segment.isCode ? segment.text : normalizeProse(segment.text)))
    .join("");
}
