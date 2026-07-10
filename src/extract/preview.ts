/**
 * extract/preview.ts — 機能B: 非HTMLコンテンツのハンドオフ応答用プレビュー整形。
 *
 * text/plain・CSV/TSV・JSON・XML等のテキスト系コンテンツはプレビュー本文を、
 * それ以外(zip/xlsx等のバイナリ系)はメタデータのみを返す方針(server.tsの
 * formatHandoffResponseから利用される)。
 */
import { decodeHtmlBytes } from "../fetcher/http.js";
import { estimateTokens } from "../tokens.js";

/** プレビュー対象とみなすテキスト系content-type(charset等のパラメータは除いて判定)。 */
const TEXT_CONTENT_TYPE_RE = /^(text\/(plain|csv|tab-separated-values|xml)|application\/(json|xml))$/i;
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
  return { body, note };
}

/** max_tokens予算に収まる最大長までテキストを切り詰める(J5 CJK対応トークン見積りを流用)。 */
function capTextByTokenBudget(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { text: text.slice(0, lo), truncated: true };
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
 */
export function buildHandoffPreview(
  bytes: Uint8Array,
  contentType: string | null,
  maxTokens: number,
  sourceTruncated: boolean,
): HandoffPreviewResult | null {
  if (!isTextLikeContentType(contentType)) return null;

  const decoded = decodeHtmlBytes(bytes, contentType);

  const delimited = isDelimited(contentType);
  if (delimited) {
    return buildTabularPreview(decoded.text);
  }

  const capped = capTextByTokenBudget(decoded.text, maxTokens);
  if (capped.truncated) {
    return { body: capped.text, note: "プレビューはmax_tokens予算に達したため打ち切りました(取得範囲内でのさらなる切り詰めです)" };
  }
  if (sourceTruncated) {
    return {
      body: capped.text,
      note: "取得範囲の上限に達したため、ファイル先頭部分のみのプレビューです(ファイル全体はさらに続きがあります)",
    };
  }
  return { body: capped.text, note: null };
}
