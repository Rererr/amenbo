import { describe, expect, it } from "vitest";
import { diffMarkdown } from "../src/diff.js";

const BASE = ["# 見出しA", "", "本文Aです。", "", "## 見出しB", "", "本文Bです。", "", "## 見出しC", "", "本文Cです。"].join("\n");

describe("diffMarkdown", () => {
  it("完全に同一なら差分は空、allSectionsChanged=false", () => {
    const result = diffMarkdown(BASE, BASE);
    expect(result.sections).toEqual([]);
    expect(result.allSectionsChanged).toBe(false);
  });

  it("1節だけ内容が変わった場合はその節のみchangedとして報告する", () => {
    const changed = BASE.replace("本文Bです。", "本文Bを更新しました。");
    const result = diffMarkdown(BASE, changed);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toMatchObject({ type: "changed", heading: "見出しB" });
    expect(result.allSectionsChanged).toBe(false);
  });

  it("節が追加された場合はaddedとして報告する", () => {
    const withNewSection = `${BASE}\n\n## 見出しD\n\n本文Dです。`;
    const result = diffMarkdown(BASE, withNewSection);
    expect(result.sections).toEqual([{ type: "added", level: 2, heading: "見出しD", content: expect.stringContaining("本文Dです。") }]);
  });

  it("節が削除された場合はremovedとして報告する(contentは空)", () => {
    const withoutC = ["# 見出しA", "", "本文Aです。", "", "## 見出しB", "", "本文Bです。"].join("\n");
    const result = diffMarkdown(BASE, withoutC);
    expect(result.sections).toEqual([{ type: "removed", level: 2, heading: "見出しC", content: "" }]);
  });

  it("見出しの並び順が変わっても見出しテキストで同一節と判定する(位置ずれの誤検知を防ぐ)", () => {
    const reordered = ["# 見出しA", "", "本文Aです。", "", "## 見出しC", "", "本文Cです。", "", "## 見出しB", "", "本文Bです。"].join("\n");
    const result = diffMarkdown(BASE, reordered);
    expect(result.sections).toEqual([]);
  });

  it("全節の内容が変わった場合はallSectionsChanged=true(呼び出し側は全文フォールバック)", () => {
    const rewritten = ["# 全く新しい見出し", "", "全く新しい本文です。"].join("\n");
    const result = diffMarkdown(BASE, rewritten);
    expect(result.allSectionsChanged).toBe(true);
  });

  it("見出しの無いページ同士は単一section(s1相当)の変更として扱う", () => {
    const result = diffMarkdown("旧バージョンの本文です。", "新バージョンの本文です。");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.type).toBe("changed");
    expect(result.allSectionsChanged).toBe(true);
  });

  it("空文字列同士は差分無し", () => {
    const result = diffMarkdown("", "");
    expect(result.sections).toEqual([]);
    expect(result.allSectionsChanged).toBe(false);
  });
});
