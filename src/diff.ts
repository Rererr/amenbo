/**
 * diff.ts — §3-3 差分応答。outline.tsの節分割(splitSections)を再利用し、
 * 旧Markdownと新Markdownを見出しテキスト単位で比較する。
 *
 * 設計判断: 節の対応付けはsection ID(連番)ではなく「見出しレベル+見出しテキスト」を
 * キーにする。IDは出現順の連番であり、節の追加/削除で後続IDが全てズレるため、
 * 位置ベースの比較では「たまたま同じ位置にある別内容」を誤って「変更」と判定してしまう。
 * 見出しテキストはページ改訂を跨いでも比較的安定した識別子として扱えるため、これをキーにする。
 */
import { splitSections, type MarkdownSection } from "./extract/outline.js";

export type SectionDiffType = "added" | "removed" | "changed";

export interface SectionDiff {
  type: SectionDiffType;
  level: number;
  heading: string;
  /** added/changed時の新しいMarkdown内容(見出し行を含む)。removed時は空文字。 */
  content: string;
}

export interface DiffResult {
  /** 差分として報告する節一覧(内容が同一の節は含まない)。 */
  sections: SectionDiff[];
  /**
   * true: 旧新間で内容が完全一致する節が1つも無い(実質的に全面書き換え)。
   * 呼び出し側はこの場合、差分応答ではなく通常の全文応答へフォールバックすべき
   * (plan.md「全節変更なら通常応答にフォールバック」)。
   */
  allSectionsChanged: boolean;
}

function sectionKey(section: Pick<MarkdownSection, "heading" | "level">): string {
  return `${section.level}::${section.heading}`;
}

/** 旧Markdownと新Markdownを節単位(見出しテキスト+レベルをキー)で比較する。 */
export function diffMarkdown(oldMarkdown: string, newMarkdown: string): DiffResult {
  const oldSections = splitSections(oldMarkdown);
  const newSections = splitSections(newMarkdown);

  const oldByKey = new Map(oldSections.map((section) => [sectionKey(section), section]));
  const newKeys = new Set(newSections.map((section) => sectionKey(section)));

  const sections: SectionDiff[] = [];
  let unchangedCount = 0;

  for (const section of newSections) {
    const previous = oldByKey.get(sectionKey(section));
    if (!previous) {
      sections.push({ type: "added", level: section.level, heading: section.heading, content: section.content });
    } else if (previous.ownContent !== section.ownContent) {
      // 比較にはownContent(子見出しを含まない直接の内容)を使う。contentは子節の変更でも
      // 変わってしまうため、子の変更が親にも伝播して誤ってchanged扱いになるのを防ぐ。
      sections.push({ type: "changed", level: section.level, heading: section.heading, content: section.content });
    } else {
      unchangedCount++;
    }
  }

  for (const section of oldSections) {
    if (!newKeys.has(sectionKey(section))) {
      sections.push({ type: "removed", level: section.level, heading: section.heading, content: "" });
    }
  }

  const allSectionsChanged = unchangedCount === 0 && (oldSections.length > 0 || newSections.length > 0);

  return { sections, allSectionsChanged };
}
