/**
 * extract/dataSources.ts — 機能C: data_sourcesヒント(構造化データへの出口)。
 *
 * fetch応答(markdown/auto経路)の末尾に、ページ内リンクのうち構造化データ
 * (CSV/ZIP/JSON等のオープンデータ)らしきものを検出した場合のみ、最大5件のヒントを付与する。
 * 検出ロジックはlinks.tsのページ内リンク抽出(extractPageLinks)を再利用する
 * (sitemap/RSSは対象外。あくまで通常のfetch応答への軽量な付加情報)。
 *
 * 実機検証での修正: 拡張子一致(.csv等、意図がほぼ確実)を語彙一致(誤検出しやすい)より
 * 常に優先する。厚労省ページ実測で「点字ダウンロード」(無関係な視覚障害者向けページ)や
 * 「オープンデータ(デジタル庁)」(他ドメインへの説明リンク)が誤検出され、本命の
 * jigyosho_*.csv が5枠から溢れる問題があったため。
 */
import { extractPageLinks, type LinkEntry } from "../links.js";

/** 拡張子ベースの検出対象(パス末尾一致、大文字小文字を区別しない)。 */
const STRUCTURED_EXTENSIONS = [".csv", ".tsv", ".zip", ".json", ".xlsx", ".xls"];

/**
 * ドメインを問わず一致させてよい、意図が強く明確な語彙のみに絞る(単独の「ダウンロード」は
 * 「点字ダウンロード」等の無関係なリンクまで拾ってしまうため除外し、「一括ダウンロード」
 * のような強いシグナルのみを対象にする)。
 */
const GENERIC_VOCAB_KEYWORDS = ["一括ダウンロード", "API", "sitemap.xml", "RSS"];

/**
 * 「オープンデータ」は単独では説明文・他省庁ポータルへのリンク等でも頻出するため、
 * リンク先が起点ページと同一ドメインの場合のみ構造化データへの導線とみなす。
 */
const SAME_DOMAIN_VOCAB_KEYWORDS = ["オープンデータ"];

const MAX_HINTS = 5;

function matchedExtension(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  return STRUCTURED_EXTENSIONS.find((ext) => pathname.endsWith(ext)) ?? null;
}

function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).hostname === new URL(baseUrl).hostname;
  } catch {
    return false;
  }
}

function matchesVocab(entry: LinkEntry, baseUrl: string): boolean {
  const haystack = `${entry.title ?? ""} ${entry.url}`.toLowerCase();

  if (GENERIC_VOCAB_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
    return true;
  }
  if (SAME_DOMAIN_VOCAB_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
    return isSameDomain(entry.url, baseUrl);
  }
  return false;
}

interface DataSourceGroup {
  entries: LinkEntry[];
  /** 拡張子一致による集約グループの場合のみ非null(links filter提案に使う)。 */
  extension: string | null;
}

/** 代表リンク1件+集約件数を1行に整形する(links.tsのformatLinksResponseと同形式)。 */
function formatHintLine(group: DataSourceGroup): string {
  const rep = group.entries[0];
  if (!rep) return "";
  const base = rep.title ? `- ${rep.title} — ${rep.url}` : `- ${rep.url}`;
  if (group.entries.length <= 1) return base;

  const extra = group.entries.length - 1;
  const filterSuffix = group.extension ? `、links filter:'*${group.extension}' で列挙可` : "";
  return `${base}(ほか${extra}件${filterSuffix})`;
}

/**
 * HTMLから構造化データっぽいリンクを検出し、最大5件のヒント行(links形式)を返す。
 * 検出ゼロの場合は空配列(呼び出し側はdata_sourcesセクション自体を出力しない)。
 *
 * 優先順位: (1) 拡張子一致(.csv等)を常に優先し、5枠のうち埋まる分だけ使う。
 * (2) 拡張子一致で埋まらなかった残り枠のみ、語彙一致(オープンデータ/一括ダウンロード等)
 * のリンクで埋める。同一拡張子のリンクは1グループに集約し、代表1件+「ほかN件」で表す
 * (例: 年度違いのCSVが20本 → 代表1本+ほか19件)。
 */
export function detectDataSources(html: string, baseUrl: string): string[] {
  const links = extractPageLinks(html, baseUrl);

  const extensionGroups = new Map<string, DataSourceGroup>();
  const extensionOrder: string[] = [];
  const vocabGroups = new Map<string, DataSourceGroup>();
  const vocabOrder: string[] = [];

  for (const link of links) {
    const extension = matchedExtension(link.url);
    if (extension !== null) {
      let group = extensionGroups.get(extension);
      if (!group) {
        group = { entries: [], extension };
        extensionGroups.set(extension, group);
        extensionOrder.push(extension);
      }
      group.entries.push(link);
      continue;
    }

    if (matchesVocab(link, baseUrl)) {
      const key = `url:${link.url}`;
      let group = vocabGroups.get(key);
      if (!group) {
        group = { entries: [], extension: null };
        vocabGroups.set(key, group);
        vocabOrder.push(key);
      }
      group.entries.push(link);
    }
  }

  const extensionHints = extensionOrder.map((key) => extensionGroups.get(key)!).map(formatHintLine);
  const remainingSlots = Math.max(MAX_HINTS - extensionHints.length, 0);
  const vocabHints = vocabOrder
    .slice(0, remainingSlots)
    .map((key) => vocabGroups.get(key)!)
    .map(formatHintLine);

  return [...extensionHints, ...vocabHints].slice(0, MAX_HINTS);
}
