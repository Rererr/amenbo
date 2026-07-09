/**
 * @joplin/turndown-plugin-gfm には型定義が同梱されておらず、公式の@types/*パッケージも
 * 存在しないため、実際のAPI(表・打消し線・タスクリスト・シンタックスハイライト付き
 * コードブロックのTurndownプラグイン群)に合わせた最小限のアンビエント宣言を用意する。
 */
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  type TurndownPlugin = (turndownService: TurndownService) => void;

  export const gfm: TurndownPlugin;
  export const highlightedCodeBlock: TurndownPlugin;
  export const strikethrough: TurndownPlugin;
  export const tables: TurndownPlugin;
  export const taskListItems: TurndownPlugin;
}
