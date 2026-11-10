/**
 * fetcher/agentResources.ts — ページが知らせる「LLM向けの資源」の在りかを読む。
 *
 * llms.txt の提案(llmstxt.org)とドキュメント基盤(Mintlify 等)は、HTMLの応答に次の印を付ける:
 *   - ページのMarkdown版: `Link: <...>; rel="alternate"; type="text/markdown"` か、同じ内容の `<link>` 要素
 *   - サイトの llms.txt: `Link: <...>; rel="llms-txt"` か `X-Llms-Txt: <URL>` ヘッダ(`<link rel="llms-txt">` も同様)
 * amenboは在りかを応答に示すだけで、自分では取りに行かない(どれを読むかは呼び出し元が決める)。
 */
import { parseHTML } from "linkedom";

export interface AgentResources {
  /** ページのMarkdown版のURL(知らされていなければnull)。 */
  markdownAlternate: string | null;
  /** サイトの llms.txt のURL(知らされていなければnull)。 */
  llmsTxt: string | null;
}

export const NO_AGENT_RESOURCES: AgentResources = { markdownAlternate: null, llmsTxt: null };

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);

interface LinkValue {
  target: string;
  /** 属性名(小文字) → 値(引用符を外したもの)。 */
  params: Map<string, string>;
}

/** 引用符の外にある区切り文字の位置を返す(無ければ文字列の長さ)。 */
function indexOfUnquoted(text: string, separator: string, from: number): number {
  let inQuotes = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === separator && !inQuotes) return i;
  }
  return text.length;
}

function parseParams(text: string): Map<string, string> {
  const params = new Map<string, string>();
  let start = 0;
  while (start < text.length) {
    const end = indexOfUnquoted(text, ";", start);
    const part = text.slice(start, end);
    const eq = part.indexOf("=");
    if (eq !== -1) {
      const name = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim().replace(/^"(.*)"$/s, "$1");
      if (name && !params.has(name)) params.set(name, value);
    }
    start = end + 1;
  }
  return params;
}

/**
 * RFC 8288 の Link ヘッダを読む。正規表現の入れ子の繰り返しを避け、1文字ずつ進める
 * (外部入力のヘッダなので、長い値で時間が爆発しない形にする)。
 */
export function parseLinkHeader(value: string): LinkValue[] {
  const links: LinkValue[] = [];
  let position = 0;
  while (position < value.length) {
    const open = value.indexOf("<", position);
    if (open === -1) break;
    const close = value.indexOf(">", open + 1);
    if (close === -1) break;
    const end = indexOfUnquoted(value, ",", close + 1);
    links.push({ target: value.slice(open + 1, close).trim(), params: parseParams(value.slice(close + 1, end)) });
    position = end + 1;
  }
  return links;
}

/**
 * HTMLの `<link>` 要素を取り出す(`</head>` までを見る)。属性の読み取りを正規表現で書くと、
 * 閉じない引用符や長い属性名を含む細工されたHTMLで二次時間になるため、HTMLパーサに任せる。
 */
function htmlLinkElements(html: string): LinkValue[] {
  const headEnd = html.search(/<\/head\s*>/i);
  const { document } = parseHTML(headEnd === -1 ? html : html.slice(0, headEnd));
  const links: LinkValue[] = [];
  for (const element of Array.from(document.querySelectorAll("link"))) {
    // linkedomは属性名の大文字小文字をそのまま残す(HTMLでは区別しないので、ここで揃える)。
    const params = new Map<string, string>();
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!params.has(name)) params.set(name, attribute.value);
    }
    const href = params.get("href");
    if (href) links.push({ target: href, params });
  }
  return links;
}

function relTokens(link: LinkValue): string[] {
  return (link.params.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function isMarkdownAlternate(link: LinkValue): boolean {
  const type = link.params.get("type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return relTokens(link).includes("alternate") && MARKDOWN_TYPES.has(type);
}

function isLlmsTxt(link: LinkValue): boolean {
  return relTokens(link).includes("llms-txt");
}

/** http(s)の絶対URLへ解決する。解決できない・http(s)以外ならnull。 */
function resolveHttpUrl(target: string, baseUrl: string): string | null {
  try {
    const url = new URL(target, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function firstResolved(candidates: Array<string | null | undefined>, baseUrl: string): string | null {
  for (const candidate of candidates) {
    const resolved = candidate ? resolveHttpUrl(candidate, baseUrl) : null;
    if (resolved) return resolved;
  }
  return null;
}

export interface AgentResourceSources {
  /** 応答の Link ヘッダ(無ければnull)。 */
  linkHeader: string | null;
  /** 応答の X-Llms-Txt ヘッダ(無ければnull)。 */
  llmsTxtHeader: string | null;
  html: string;
  /** 相対URLの基準(最終的に着いたURL)。 */
  baseUrl: string;
}

/** 応答ヘッダとHTMLから、Markdown版と llms.txt の在りかを読む(ヘッダの印を先に見る)。 */
export function findAgentResources(sources: AgentResourceSources): AgentResources {
  const headerLinks = sources.linkHeader ? parseLinkHeader(sources.linkHeader) : [];
  const documentLinks = htmlLinkElements(sources.html);
  const links = [...headerLinks, ...documentLinks];
  return {
    markdownAlternate: firstResolved(links.filter(isMarkdownAlternate).map((link) => link.target), sources.baseUrl),
    llmsTxt: firstResolved([...headerLinks.filter(isLlmsTxt).map((link) => link.target), sources.llmsTxtHeader, ...documentLinks.filter(isLlmsTxt).map((link) => link.target)], sources.baseUrl),
  };
}

/** キャッシュのメタデータから読み戻す(古いキャッシュには無いので、形が合わなければ無しとして扱う)。 */
export function agentResourcesFromMetadata(value: unknown): AgentResources {
  if (typeof value !== "object" || value === null) return NO_AGENT_RESOURCES;
  const record = value as Record<string, unknown>;
  return {
    markdownAlternate: typeof record.markdownAlternate === "string" ? record.markdownAlternate : null,
    llmsTxt: typeof record.llmsTxt === "string" ? record.llmsTxt : null,
  };
}
