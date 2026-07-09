/**
 * J5: CJK対応トークン見積り。
 *
 * 文字クラス別係数(plan.md §2 J5):
 *   - ASCII等(半角英数記号): 1トークン ≒ 3.8文字
 *   - CJK(かな/カナ/漢字/全角記号等): 1文字 ≒ 0.9トークン
 *
 * 設計判断: plan.mdはASCII/CJKの二区分のみを定義しているため、絵文字・キリル文字等の
 * その他多バイト文字はASCII側の係数で近似する(Phase 1のスコープでは十分な精度と判断)。
 */

const ASCII_CHARS_PER_TOKEN = 3.8;
const CJK_TOKENS_PER_CHAR = 0.9;

/**
 * コードポイントがCJK(日本語表記に使われる文字)かどうかを判定する。
 * ひらがな・カタカナ・漢字(統合漢字+拡張A)・CJK記号(全角スペースを除く)・
 * 全角英数/記号(半角スペースに相当する全角スペースを除く)・半角カタカナを対象とする。
 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x309f) || // ひらがな
    (cp >= 0x30a0 && cp <= 0x30ff) || // カタカナ
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK統合漢字拡張A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK統合漢字
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK互換漢字
    (cp >= 0x3001 && cp <= 0x303f) || // CJK記号(0x3000の全角スペースは除く)
    (cp >= 0xff01 && cp <= 0xffef) // 全角英数/記号・半角カタカナ(0xFF00の全角スペースは除く)
  );
}

/** テキストのCJK文字数と非CJK文字数を数える。 */
function countByClass(text: string): { cjk: number; other: number } {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isCjkCodePoint(cp)) {
      cjk++;
    } else if (!/\s/u.test(ch)) {
      // 空白は係数計算に含めない(トークンをほぼ消費しないため)
      other++;
    }
  }
  return { cjk, other };
}

/** テキストの概算トークン数を返す(CJK文字クラス別係数)。 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const { cjk, other } = countByClass(text);
  const tokens = cjk * CJK_TOKENS_PER_CHAR + other / ASCII_CHARS_PER_TOKEN;
  return Math.ceil(tokens);
}

/** Markdownの1ブロック(見出し/段落/リスト項目/表/コードフェンス等)。 */
interface Block {
  text: string;
  isHeading: boolean;
}

/**
 * Markdownをブロック単位(空行区切り)に分割する。
 * フェンスコードブロック(```)内の空行はブロック境界として扱わない。
 */
function splitIntoBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.join("\n").replace(/\n+$/, "");
    if (text.trim().length > 0) {
      blocks.push({ text, isHeading: /^#{1,6}\s/.test(current[0] ?? "") });
    }
    current = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  return blocks;
}

export interface PaginatedResult {
  /** 要求されたページ(範囲外の場合は最寄りの有効ページへ丸められる)の本文。 */
  content: string;
  /** 実際に返したページ番号(1始まり)。 */
  page: number;
  /** 総ページ数。 */
  totalPages: number;
  /** このページの概算トークン数。 */
  tokens: number;
}

const MIN_TOKENS_PER_PAGE = 1;
/** 見出し直前で改ページを優先する閾値(予算に対する充填率)。 */
const HEADING_BREAK_FILL_RATIO = 0.6;

/**
 * J5: max_tokens予算で見出し/段落境界を優先してページ分割する。
 *
 * アルゴリズム:
 *   1. 空行(フェンスコード内を除く)でMarkdownをブロックに分割
 *   2. ブロックを先頭から貪欲に詰め、予算超過前に新しいページへ切り替える
 *   3. 見出しブロックの手前では、既に予算の60%以上を使っていれば先に改ページする
 *      (見出しがページ末尾に孤立するのを避けるため)
 *   4. 単一ブロックが予算を超える場合(巨大な表/コード等)は、表・コードを
 *      壊さないためブロックを割らずそのページ単独で返す
 */
export function paginateMarkdown(markdown: string, maxTokens: number, page: number): PaginatedResult {
  const budget = Math.max(MIN_TOKENS_PER_PAGE, maxTokens);
  const blocks = splitIntoBlocks(markdown);

  if (blocks.length === 0) {
    return { content: "", page: 1, totalPages: 1, tokens: 0 };
  }

  const pages: string[][] = [];
  let currentBlocks: string[] = [];
  let currentTokens = 0;

  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text);
    const wouldExceed = currentTokens + blockTokens > budget;
    const shouldBreakBeforeHeading =
      block.isHeading && currentBlocks.length > 0 && currentTokens >= budget * HEADING_BREAK_FILL_RATIO;

    if (currentBlocks.length > 0 && (wouldExceed || shouldBreakBeforeHeading)) {
      pages.push(currentBlocks);
      currentBlocks = [];
      currentTokens = 0;
    }

    currentBlocks.push(block.text);
    currentTokens += blockTokens;
  }
  if (currentBlocks.length > 0) {
    pages.push(currentBlocks);
  }

  const totalPages = pages.length;
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const selected = pages[clampedPage - 1] ?? [];
  const content = selected.join("\n\n");

  return {
    content,
    page: clampedPage,
    totalPages,
    tokens: estimateTokens(content),
  };
}
