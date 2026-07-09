/**
 * adapters/index.ts — J7 国内サイトアダプタの初期セット。
 *
 * plan.md指定の初期セット(Qiita/Zenn/note/はてなブログ系/Yahoo!ニュース/PR TIMES)を実装する。
 * 各セレクタは実際に対象サイトのHTMLを取得して確認済み(2026-07時点)。
 * サイトのマークアップ変更で機能しなくなった場合は、contentSelectorsが1件もヒットせず
 * 通常のReadabilityパスへフォールバックする(extract/markdown.ts側の挙動)ため、
 * アダプタの陳腐化が抽出失敗に直結しない設計になっている。
 *
 * 設計判断: plan.mdは「e-Gov等」にも触れているが、e-Govは法令検索という性質上
 * ページ構造がクエリ毎に大きく異なり単一セレクタでの決定的抽出が難しいため、
 * Phase 3の初期セットからは見送り、確認が取れた6サイトのみを実装する。
 */
import type { SiteAdapter } from "./types.js";

export const SITE_ADAPTERS: SiteAdapter[] = [
  {
    name: "qiita",
    hostPattern: /(^|\.)qiita\.com$/i,
    contentSelectors: [".it-MdContent", "article"],
    notes: "記事本文。.it-MdContentはQiita記法のレンダリング結果。",
  },
  {
    name: "zenn",
    hostPattern: /(^|\.)zenn\.dev$/i,
    contentSelectors: [".znc", "article"],
    notes: "記事本文。.zncはZenn Markdownのレンダリング結果。",
  },
  {
    name: "note",
    hostPattern: /(^|\.)note\.com$/i,
    contentSelectors: [".note-common-styles__textnote-body", ".p-article__body", "article"],
    notes: "note記事本文。textnote-bodyが本文のみに最も絞られたコンテナ。",
  },
  {
    name: "hatenablog",
    hostPattern: /(^|\.)hatenablog\.com$|(^|\.)hateblo\.jp$/i,
    contentSelectors: [".entry-content", "article"],
    removeSelectors: [".hatena-module-ad", ".advertisement-unit"],
    notes: "はてなブログの記事本文(*.hatenablog.com / *.hateblo.jp)。",
  },
  {
    name: "yahoo-news",
    hostPattern: /(^|\.)news\.yahoo\.co\.jp$/i,
    contentSelectors: [".article_body", "article#uamods", "article"],
    notes: "Yahoo!ニュース個別記事の本文。",
  },
  {
    name: "prtimes",
    hostPattern: /(^|\.)prtimes\.jp$/i,
    contentSelectors: ["#press-release-body", "article"],
    notes: "PR TIMESリリース本文。",
  },
];

/** ホスト名(document.location.hostname相当)に一致するアダプタを探す。無ければnull。 */
export function findAdapter(hostname: string): SiteAdapter | null {
  return SITE_ADAPTERS.find((adapter) => adapter.hostPattern.test(hostname)) ?? null;
}
