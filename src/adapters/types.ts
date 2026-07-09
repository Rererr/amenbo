/**
 * adapters/types.ts — J7 国内サイトアダプタの型定義。
 *
 * 宣言的なTSオブジェクトでドメイン→本文セレクタを定義する(plan.md記載は「宣言的YAML」だが、
 * 型チェック・IDE補完の恩恵と外部パーサ追加不要という理由からTSオブジェクトで実装する)。
 */
export interface SiteAdapter {
  /** メタデータ `adapter: <name>` に出力される識別名。 */
  name: string;
  /** ホスト名にマッチする正規表現。 */
  hostPattern: RegExp;
  /**
   * 本文として採用するCSSセレクタ候補(先頭から順に試し、最初に要素が見つかったものを使う)。
   * Readabilityより優先される。
   */
  contentSelectors: string[];
  /** 本文セレクタでマッチした要素の中から、さらに除去するCSSセレクタ(コメント欄・広告枠等)。 */
  removeSelectors?: string[];
  /** 補足メモ(保守用、実行時には使わない)。 */
  notes?: string;
}
