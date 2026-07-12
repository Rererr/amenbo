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

/**
 * `${level}::${heading}` の基本キーに、同一キーの中での出現順インデックスを付与した
 * 一意キーを一覧生成する。
 *
 * レビュー指摘対応: 「## お知らせ」「### Q」のように同一level+heading見出しが複数回
 * 出現するページ(FAQ・更新履歴等、日本語Webで頻出)では、基本キーだけでは全て同じキーに
 * 潰れてしまい、Mapが後勝ちで1つを残す他は消えてしまう。同名見出し同士は出現位置で
 * 対応付けるのが妥当なため、出現順(0-indexed)をキーへ含めて位置的に対応付ける。
 */
function buildOccurrenceKeys(sections: readonly MarkdownSection[]): string[] {
  const occurrence = new Map<string, number>();
  return sections.map((section) => {
    const base = sectionKey(section);
    const index = occurrence.get(base) ?? 0;
    occurrence.set(base, index + 1);
    return `${base}::${index}`;
  });
}

/** 旧Markdownと新Markdownを節単位(見出しテキスト+レベル+出現順をキー)で比較する。 */
export function diffMarkdown(oldMarkdown: string, newMarkdown: string): DiffResult {
  const oldSections = splitSections(oldMarkdown);
  const newSections = splitSections(newMarkdown);

  const oldKeys = buildOccurrenceKeys(oldSections);
  const newKeys = buildOccurrenceKeys(newSections);

  const oldByKey = new Map(oldSections.map((section, i) => [oldKeys[i], section]));
  const newKeySet = new Set(newKeys);

  const sections: SectionDiff[] = [];
  let unchangedCount = 0;

  newSections.forEach((section, i) => {
    const previous = oldByKey.get(newKeys[i] ?? "");
    if (!previous) {
      sections.push({ type: "added", level: section.level, heading: section.heading, content: section.content });
    } else if (previous.ownContent !== section.ownContent) {
      // 比較にはownContent(子見出しを含まない直接の内容)を使う。contentは子節の変更でも
      // 変わってしまうため、子の変更が親にも伝播して誤ってchanged扱いになるのを防ぐ。
      sections.push({ type: "changed", level: section.level, heading: section.heading, content: section.content });
    } else {
      unchangedCount++;
    }
  });

  oldSections.forEach((section, i) => {
    if (!newKeySet.has(oldKeys[i] ?? "")) {
      sections.push({ type: "removed", level: section.level, heading: section.heading, content: "" });
    }
  });

  const allSectionsChanged = unchangedCount === 0 && (oldSections.length > 0 || newSections.length > 0);

  return { sections, allSectionsChanged };
}
