/**
 * fetcher/index.ts — 二段フェッチ。
 *
 * まず素のHTTP GET(fetcher/http.ts)を行い、SPA判定(ヒューリスティック)に該当した
 * 場合のみheadless Chromium(fetcher/browser.ts)へ昇格する。
 * 大半の静的/SSRページはHTTP GETのみで完結し、先方負荷・自機資源を最小化する。
 */
import { parseHTML } from "linkedom";
import { UnsupportedContentError } from "../errors.js";
import type { PageGeometrySnapshot } from "../extract/geometry.js";
import { fetchWithBrowser } from "./browser.js";
import { httpGetRouted, type HttpGetOptions } from "./http.js";

export type FetchTier = "http" | "browser";

export interface FetchResult {
  finalUrl: string;
  html: string;
  tier: FetchTier;
  status: number;
  /** HTTP tierのみ有効な値(ブラウザ tier はレンダリング結果がUTF-8文字列として得られるため常にUTF-8)。 */
  encoding: string;
  /** キャッシュ再検証用のバリデータ(HTTP tierのみ)。 */
  etag: string | null;
  lastModified: string | null;
  /** SPA判定でブラウザへ昇格した場合、その理由。 */
  escalationReason: string | null;
  /** Phase 4 ジオメトリ抽出用データ。browser tierのみ非null。 */
  geometry: PageGeometrySnapshot | null;
}

export interface NotModifiedResult {
  notModified: true;
  finalUrl: string;
}

/** 機能B: HTML/PDF以外のコンテンツタイプのハンドオフ応答用データ(メタデータ+プレビュー用バイト列)。 */
export interface HandoffResult {
  handoff: true;
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** プレビュー用に読み取ったボディ(既定256KB上限。ファイル全体ではない)。 */
  bytes: Uint8Array;
  /** Content-Lengthヘッダ由来の宣言サイズ(無ければnull)。 */
  declaredSize: number | null;
  /** プレビュー上限で本文を打ち切った場合true(ファイル全体は取得していない)。 */
  truncated: boolean;
}

// ---- SPA判定ヒューリスティック ----

const SPA_ROOT_IDS = ["root", "app", "__next", "__nuxt"];
const MIN_HTML_LENGTH_FOR_RATIO_CHECK = 2000;
const TEXT_TO_HTML_RATIO_THRESHOLD = 0.02;
const MIN_VISIBLE_TEXT_LENGTH = 200;

export function detectSpaSignals(html: string): { escalate: boolean; reason: string | null } {
  const { document } = parseHTML(html);

  for (const id of SPA_ROOT_IDS) {
    const el = document.getElementById(id);
    if (el && el.textContent.replace(/\s+/g, "").length < 10) {
      return { escalate: true, reason: `SPAルートコンテナ(#${id})が空です` };
    }
  }

  // noscriptWarningの判定はnoscriptのテキストを読むため、除去前に先に採取する。
  const noscriptWarning = Array.from(document.querySelectorAll("noscript")).some((el) =>
    /javascript|有効に|enable/i.test(el.textContent ?? ""),
  );
  if (noscriptWarning) {
    return { escalate: true, reason: "noscriptにJavaScript要求の警告があります" };
  }

  // script/style/noscriptを除去してから可視テキスト量を測る(extract/markdown.tsの
  // collectQualityInputと同じ除去対象に揃える)。noscriptを除去しないと、GTM等の
  // <noscript><iframe>フォールバックや長文注記を持つSPAで、noscriptのテキスト長が
  // 閾値を満たしてしまいブラウザ昇格が誤ってスキップされる。
  for (const tag of Array.from(document.querySelectorAll("script, style, noscript"))) {
    tag.remove();
  }
  const visibleText = (document.body?.textContent ?? "").replace(/\s+/g, "");

  if (html.length > MIN_HTML_LENGTH_FOR_RATIO_CHECK && visibleText.length / html.length < TEXT_TO_HTML_RATIO_THRESHOLD) {
    return { escalate: true, reason: "抽出テキスト量/HTMLサイズ比が低いです" };
  }

  if (html.length > MIN_HTML_LENGTH_FOR_RATIO_CHECK && visibleText.length < MIN_VISIBLE_TEXT_LENGTH) {
    return { escalate: true, reason: "可視テキスト量が閾値未満です" };
  }

  return { escalate: false, reason: null };
}

export interface FetchPageOptions extends HttpGetOptions {
  /** trueの場合、SPA判定を行わず常にブラウザで取得する(将来のmode指定等で利用)。 */
  forceBrowser?: boolean;
  /** MCP progress notifications用。headlessブラウザへ昇格する直前にのみ呼ばれる。 */
  onProgress?: ((message: string) => void) | undefined;
}

/** 二段フェッチ本体。条件付きGETでstatus 304が返った場合はNotModifiedResultを返す。 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchResult | NotModifiedResult | HandoffResult> {
  const routed = await httpGetRouted(url, options);

  if (routed.kind === "notModified") {
    return { notModified: true, finalUrl: routed.finalUrl };
  }

  if (routed.kind === "handoff") {
    // PDFの既存処理フロー(server.tsのURL拡張子判定 → handlePdfFetch)は変更しない。
    // URL拡張子で検出できなかったPDF(content-typeのみで判明するケース)は、
    // 機能B以前と同じくUnsupportedContentErrorのままにする(バイナリをテキストとして
    // プレビューしてしまう回帰を避けるため)。
    if (routed.contentType && /application\/pdf/i.test(routed.contentType)) {
      throw new UnsupportedContentError(routed.finalUrl, routed.contentType);
    }
    return {
      handoff: true,
      finalUrl: routed.finalUrl,
      status: routed.status,
      contentType: routed.contentType,
      bytes: routed.bytes,
      declaredSize: routed.declaredSize,
      truncated: routed.truncated,
    };
  }

  const spaSignals = options.forceBrowser ? { escalate: true, reason: "forceBrowser指定" } : detectSpaSignals(routed.html);

  if (!spaSignals.escalate) {
    return {
      finalUrl: routed.finalUrl,
      html: routed.html,
      tier: "http",
      status: routed.status,
      encoding: routed.encoding,
      etag: routed.headers.get("etag"),
      lastModified: routed.headers.get("last-modified"),
      escalationReason: null,
      geometry: null,
    };
  }

  options.onProgress?.("ブラウザで再取得しています…");
  const browserResult = await fetchWithBrowser(routed.finalUrl, options.timeoutMs);
  return {
    finalUrl: browserResult.finalUrl,
    html: browserResult.html,
    tier: "browser",
    status: browserResult.status,
    encoding: "UTF-8",
    etag: null,
    lastModified: null,
    escalationReason: spaSignals.reason,
    geometry: browserResult.geometry,
  };
}
