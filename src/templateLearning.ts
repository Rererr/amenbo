/**
 * templateLearning.ts — Phase 4 テンプレート学習(同一ドメインの定型ブロック除去)。
 *
 * 同一ドメインの複数ページで共通して出現するブロック(段落/リスト単位。tokens.tsの
 * ブロック分割を再利用)は、ヘッダ・フッタ・定型ナビ等の「そのページ固有ではない」
 * 内容とみなし、表示用Markdownから取り除く。
 *
 * 判定方法(cache.ts側で保持): ドメイン毎に直近N ページ分のブロックハッシュ集合を記録し、
 * 直近N ページ全てに出現したハッシュを定型ブロックとみなす(cache.tsの
 * getTemplateBlockHashesを参照)。本モジュールはハッシュ計算とブロック除去の純関数のみを担う。
 */
import { hashContent } from "./cache.js";
import { splitIntoBlocks } from "./tokens.js";

/** Markdownをブロック分割し、各ブロックの内容ハッシュ一覧を返す(重複ブロックは1回のみ)。 */
export function computeBlockHashes(markdown: string): string[] {
  const hashes = new Set<string>();
  for (const block of splitIntoBlocks(markdown)) {
    hashes.add(hashContent(block.text.trim()));
  }
  return [...hashes];
}

export interface RemoveTemplateBlocksResult {
  markdown: string;
  removedCount: number;
}

/**
 * 定型ブロック(templateHashesに含まれるハッシュを持つブロック)をMarkdownから除去する。
 * templateHashesが空の場合は何もしない(呼び出し側で force_full 等により無効化するケース)。
 */
export function removeTemplateBlocks(markdown: string, templateHashes: ReadonlySet<string>): RemoveTemplateBlocksResult {
  if (templateHashes.size === 0) {
    return { markdown, removedCount: 0 };
  }

  const blocks = splitIntoBlocks(markdown);
  const kept: string[] = [];
  let removedCount = 0;

  for (const block of blocks) {
    if (templateHashes.has(hashContent(block.text.trim()))) {
      removedCount++;
      continue;
    }
    kept.push(block.text);
  }

  return { markdown: kept.join("\n\n"), removedCount };
}
