/**
 * Markdownのフェンスコードブロックの判定(CommonMark準拠)。outline(見出しの収集)・
 * tokens(ブロック分割)・jp/normalize(コードの保護)が同じ判定を共有する。
 *
 * フェンスは同じ文字(` か ~)を3つ以上並べた行で開き、開いたときと同じ文字で同じ長さ以上の
 * 行で閉じる。閉じられないフェンスは文書の終わりまで続く。
 */

interface OpenFence {
  char: string;
  length: number;
}

// 行頭の字下げは数えない(CommonMarkは3つまでだが、リストの中のコードはturndownが4つ以上
// 字下げする。入れ物の字下げを解かずに行だけで判定するため、上限を設けない)。
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * 行を先頭から順に渡すと、その行がフェンスの区切り行かフェンスの中ならtrueを返す関数を作る。
 * 状態を持つので、1つの文書の走査ごとに作り直す。
 */
export function createFenceScanner(): (line: string) => boolean {
  let open: OpenFence | null = null;
  return (line) => {
    if (open) {
      const fence = FENCE_CLOSE.exec(line)?.[1];
      if (fence && fence[0] === open.char && fence.length >= open.length) open = null;
      return true;
    }
    const match = FENCE_OPEN.exec(line);
    const fence = match?.[1];
    if (!match || !fence) return false;
    // バッククォートのフェンスの情報文字列はバッククォートを含めない(含めば行内のコード)。
    if (fence[0] === "`" && line.slice(match[0].length).includes("`")) return false;
    open = { char: fence[0] ?? "", length: fence.length };
    return true;
  };
}
