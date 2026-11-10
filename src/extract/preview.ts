/**
 * extract/preview.ts — 機能B: 非HTMLコンテンツのハンドオフ応答用プレビュー整形。
 *
 * text/plain・Markdown・CSV/TSV・JSON・XML等のテキスト系コンテンツはプレビュー本文を、
 * それ以外(zip/xlsx等のバイナリ系)はメタデータのみを返す方針(server.tsの
 * formatHandoffResponseから利用される)。
 */
import { decodeHtmlBytes } from "../fetcher/http.js";
import { estimateTokens } from "../tokens.js";

/** プレビュー対象とみなすテキスト系content-type(charset等のパラメータは除いて判定)。 */
const TEXT_CONTENT_TYPE_RE = /^(text\/(plain|markdown|x-markdown|csv|tab-separated-values|xml)|application\/(json|xml))$/i;
const JSON_OR_XML_SUFFIX_RE = /\+(json|xml)$/i;

function mimeOnly(contentType: string | null): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** プレビュー可能なテキスト系content-typeかどうか(バイナリ系はfalse)。 */
export function isTextLikeContentType(contentType: string | null): boolean {
  const mime = mimeOnly(contentType);
  if (!mime) return false;
  return TEXT_CONTENT_TYPE_RE.test(mime) || JSON_OR_XML_SUFFIX_RE.test(mime);
}

function isDelimited(contentType: string | null): "csv" | "tsv" | null {
  const mime = mimeOnly(contentType);
  if (mime === "text/csv") return "csv";
  if (mime === "text/tab-separated-values") return "tsv";
  return null;
}

const CSV_TSV_PREVIEW_ROWS = 5;

export interface HandoffPreviewResult {
  /** プレビュー本文。 */
  body: string;
  /** 補足情報(CSV/TSVの行数注記や、max_tokens予算による打ち切りの注記)。無ければnull。 */
  note: string | null;
  /** 返したページ(1始まり。範囲外の要求は最寄りの有効ページへ丸める)。 */
  page: number;
  /** 取得範囲の本文をmax_tokens予算で区切ったページ数。 */
  totalPages: number;
}

/** テキストを先頭行=ヘッダ、続く最大5行=データ行としてプレビュー整形する(CSV/TSV共通)。 */
function buildTabularPreview(text: string): HandoffPreviewResult {
  const lines = text.split(/\r\n|\r|\n/);
  // 末尾の空行(ファイル末尾の改行由来)は行として数えない
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const header = lines[0] ?? "";
  const dataLines = lines.slice(1, 1 + CSV_TSV_PREVIEW_ROWS);
  const body = [header, ...dataLines].join("\n");
  const visibleDataRows = Math.max(lines.length - 1, 0);

  const note = `プレビュー範囲内で確認できたデータ行数: ${visibleDataRows}行中先頭${dataLines.length}行を表示(ファイル全体の行数ではありません。取得範囲の制約による部分プレビューです)`;
  return { body, note, page: 1, totalPages: 1 };
}

/**
 * max_tokens予算に収まる先頭の長さ(UTF-16の単位)を返す(J5 CJK対応トークン見積りを流用)。
 * 毎回テキスト全体を測ると、小さい予算で多数のページに区切るときに二次時間になるため、
 * 倍々に伸ばして上限を見つけてから二分探索する(1ページの長さに比例する手間で済む)。
 */
function prefixLengthWithinBudget(text: string, maxTokens: number): number {
  let within = 0;
  let probe = 1;
  while (probe < text.length && estimateTokens(text.slice(0, probe)) <= maxTokens) {
    within = probe;
    probe *= 2;
  }
  if (probe >= text.length) {
    if (estimateTokens(text) <= maxTokens) return text.length;
    probe = text.length;
  }

  let lo = within;
  let hi = probe - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // 予算が1文字分にも満たないと先へ進めず、同じページを返し続けてしまう。
  if (lo === 0) return 1;
  // 行の途中で切ると次のページが語の途中から始まるため、後半に改行があればそこで切る。
  const lastNewline = text.lastIndexOf("\n", lo - 1);
  if (lastNewline >= lo / 2) return lastNewline + 1;
  // サロゲートペアの間で切ると、両ページに壊れた文字が残る。
  const code = text.charCodeAt(lo - 1);
  return code >= 0xd800 && code <= 0xdbff && lo > 1 ? lo - 1 : lo;
}

/** テキストをmax_tokens予算ごとのページに区切る(連結すると元のテキストに戻る)。 */
function splitTextIntoPages(text: string, maxTokens: number): string[] {
  const pages: string[] = [];
  let rest = text;
  do {
    const length = prefixLengthWithinBudget(rest, maxTokens);
    pages.push(rest.slice(0, length));
    rest = rest.slice(length);
  } while (rest.length > 0);
  return pages;
}

/**
 * 非HTMLコンテンツのプレビューを整形する。バイナリ系content-typeの場合はnull
 * (呼び出し側はメタデータのみの応答にする)。
 *
 * @param sourceTruncated ネットワーク層のプレビュー上限(既定256KB)で本文取得自体を
 *   打ち切っていた場合true。表形式(CSV/TSV)は元々「先頭5行」しか見せない前提のため
 *   既存の注記で十分だが、非表形式(text/plain・JSON等)はmax_tokens予算に達していなくても
 *   「取得できたのはファイルの先頭部分のみ」という事実が伝わらないケースがあったため、
 *   その場合のみ専用の注記を追加する。
 * @param page 非表形式の本文をmax_tokens予算で区切ったときに返すページ(1始まり)。
 */
export function buildHandoffPreview(
  bytes: Uint8Array,
  contentType: string | null,
  maxTokens: number,
  sourceTruncated: boolean,
  page: number = 1,
): HandoffPreviewResult | null {
  if (!isTextLikeContentType(contentType)) return null;

  const decoded = decodeHtmlBytes(bytes, contentType);

  const delimited = isDelimited(contentType);
  if (delimited) {
    return buildTabularPreview(decoded.text);
  }

  const pages = splitTextIntoPages(decoded.text, Math.max(1, maxTokens));
  const totalPages = pages.length;
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const body = pages[clampedPage - 1] ?? "";
  const isLastPage = clampedPage === totalPages;
  if (!isLastPage) {
    return {
      body,
      note: `プレビューはmax_tokens予算で区切りました(続きは page: ${clampedPage + 1} で取得できます)`,
      page: clampedPage,
      totalPages,
    };
  }
  if (sourceTruncated) {
    return {
      body,
      note: "取得範囲の上限に達したため、ファイル先頭部分のみのプレビューです(ファイル全体はさらに続きがあります)",
      page: clampedPage,
      totalPages,
    };
  }
  return { body, note: null, page: clampedPage, totalPages };
}
