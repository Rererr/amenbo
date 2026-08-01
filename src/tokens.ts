/**
 * J5: 文字クラス別のトークン見積り。
 *
 * 文字クラス別係数:
 *   - ラテン文字系(半角英数記号・ラテン拡張): 1トークン ≒ 3.8文字
 *   - 非ラテン文字(キリル/ギリシャ/ヘブライ/アラビア/デーヴァナーガリー/タイ等): 1文字 ≒ 0.5トークン
 *   - CJK・ハングル(かな/カナ/漢字/全角記号/ハングル): 1文字 ≒ 0.9トークン
 *
 * 係数はo200k_base(GPT-4o)での実測に、既存係数と同程度(約1.15倍)の安全側マージンを乗せた値。
 * 実測(1文字あたりトークン数): 英4.78文字/token、日0.79、韓0.75、中0.80、露0.29、
 * 아0.35、希0.38、印0.40、泰0.44、希伯来0.47。
 *
 * 当初はASCII/CJKの二区分のみで、ハングルを含む非ラテン文字を全てASCII係数で近似していたが、
 * 韓国語で実トークン量の約1/3にしか見積もれず、max_tokens予算が大きく超過していた
 * (言語による不公平は本ツールでは不具合として扱う)。
 */

const LATIN_CHARS_PER_TOKEN = 3.8;
const CJK_TOKENS_PER_CHAR = 0.9;
const NON_LATIN_TOKENS_PER_CHAR = 0.5;

/** ラテン文字・ASCII記号の範囲(基本ラテン〜ラテン文字拡張B)。 */
const LATIN_MAX_CODE_POINT = 0x024f;

/**
 * 1文字あたりのトークン消費が大きい表記のコードポイントか判定する。
 * ひらがな・カタカナ・漢字(統合漢字+拡張A/B+互換)・CJK記号(全角スペースを除く)・
 * 全角英数/記号・半角カタカナ・ハングル(音節+字母)を対象とする。
 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x309f) || // ひらがな
    (cp >= 0x30a0 && cp <= 0x30ff) || // カタカナ
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK統合漢字拡張A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK統合漢字
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK互換漢字
    (cp >= 0x20000 && cp <= 0x2fa1f) || // CJK統合漢字拡張B以降
    (cp >= 0x3001 && cp <= 0x303f) || // CJK記号(0x3000の全角スペースは除く)
    (cp >= 0xff01 && cp <= 0xffef) || // 全角英数/記号・半角カタカナ(0xFF00の全角スペースは除く)
    (cp >= 0xac00 && cp <= 0xd7a3) || // ハングル音節
    (cp >= 0x1100 && cp <= 0x11ff) || // ハングル字母
    (cp >= 0x3130 && cp <= 0x318f) // ハングル互換字母
  );
}

interface CharClassCounts {
  cjk: number;
  nonLatin: number;
  latin: number;
}

/** テキストを文字クラス別に数える(空白はトークンをほぼ消費しないため数えない)。 */
function countByClass(text: string): CharClassCounts {
  const counts: CharClassCounts = { cjk: 0, nonLatin: 0, latin: 0 };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || /\s/u.test(ch)) continue;
    if (isCjkCodePoint(cp)) {
      counts.cjk++;
    } else if (cp > LATIN_MAX_CODE_POINT) {
      counts.nonLatin++;
    } else {
      counts.latin++;
    }
  }
  return counts;
}

/** テキストの概算トークン数を返す(文字クラス別係数)。 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const { cjk, nonLatin, latin } = countByClass(text);
  const tokens = cjk * CJK_TOKENS_PER_CHAR + nonLatin * NON_LATIN_TOKENS_PER_CHAR + latin / LATIN_CHARS_PER_TOKEN;
  return Math.ceil(tokens);
}

/** Markdownの1ブロック(見出し/段落/リスト項目/表/コードフェンス等)。 */
export interface Block {
  text: string;
  isHeading: boolean;
}

/**
 * Markdownをブロック単位(空行区切り)に分割する。
 * フェンスコードブロック(```)内の空行はブロック境界として扱わない。
 * templateLearning.ts(Phase 4定型ブロック除去)からも再利用される共通処理。
 */
export function splitIntoBlocks(markdown: string): Block[] {
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
  /** N6: 単一ブロックがmax_tokens予算を超過しており、分割できずそのまま返した場合true。 */
  exceededBudget: boolean;
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
    return { content: "", page: 1, totalPages: 1, tokens: 0, exceededBudget: false };
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
  const tokens = estimateTokens(content);

  return {
    content,
    page: clampedPage,
    totalPages,
    tokens,
    // N6: 単一ブロックが予算超過でもページを割らずそのまま返す(paginateMarkdownの仕様)ため、
    // その場合はここでtokens > budgetとなる。呼び出し側(server.ts)が明示的にユーザーへ伝える。
    exceededBudget: tokens > budget,
  };
}
