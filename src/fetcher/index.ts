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
import { httpGet, type HttpGetOptions } from "./http.js";

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

// ---- SPA判定ヒューリスティック ----

const SPA_ROOT_IDS = ["root", "app", "__next", "__nuxt"];
const MIN_HTML_LENGTH_FOR_RATIO_CHECK = 2000;
const TEXT_TO_HTML_RATIO_THRESHOLD = 0.02;
const MIN_VISIBLE_TEXT_LENGTH = 200;

function detectSpaSignals(html: string): { escalate: boolean; reason: string | null } {
  const { document } = parseHTML(html);

  for (const tag of Array.from(document.querySelectorAll("script, style"))) {
    tag.remove();
  }
  const visibleText = (document.body?.textContent ?? "").replace(/\s+/g, "");

  for (const id of SPA_ROOT_IDS) {
    const el = document.getElementById(id);
    if (el && el.textContent.replace(/\s+/g, "").length < 10) {
      return { escalate: true, reason: `SPAルートコンテナ(#${id})が空です` };
    }
  }

  const noscriptWarning = Array.from(document.querySelectorAll("noscript")).some((el) =>
    /javascript|有効に|enable/i.test(el.textContent ?? ""),
  );
  if (noscriptWarning) {
    return { escalate: true, reason: "noscriptにJavaScript要求の警告があります" };
  }

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
}

/** 二段フェッチ本体。条件付きGETでstatus 304が返った場合はNotModifiedResultを返す。 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchResult | NotModifiedResult> {
  const httpResult = await httpGet(url, options);

  if (httpResult.status === 304) {
    return { notModified: true, finalUrl: httpResult.finalUrl };
  }

  const contentType = httpResult.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new UnsupportedContentError(httpResult.finalUrl, contentType);
  }

  const spaSignals = options.forceBrowser ? { escalate: true, reason: "forceBrowser指定" } : detectSpaSignals(httpResult.html);

  if (!spaSignals.escalate) {
    return {
      finalUrl: httpResult.finalUrl,
      html: httpResult.html,
      tier: "http",
      status: httpResult.status,
      encoding: httpResult.encoding,
      etag: httpResult.headers.get("etag"),
      lastModified: httpResult.headers.get("last-modified"),
      escalationReason: null,
      geometry: null,
    };
  }

  const browserResult = await fetchWithBrowser(httpResult.finalUrl, options.timeoutMs);
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
