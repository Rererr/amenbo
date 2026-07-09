import { describe, expect, it } from "vitest";
import { hashContent } from "../src/cache.js";
import { computeBlockHashes, removeTemplateBlocks } from "../src/templateLearning.js";

describe("computeBlockHashes", () => {
  it("空行区切りのブロック毎にハッシュを計算する", () => {
    const markdown = "# 見出し\n\n段落1です。\n\n段落2です。";
    const hashes = computeBlockHashes(markdown);
    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(3); // 全て異なるハッシュ
  });

  it("同一内容のブロックは重複除去される", () => {
    const markdown = "共通ブロック\n\n共通ブロック\n\nユニークな段落";
    const hashes = computeBlockHashes(markdown);
    expect(hashes).toHaveLength(2);
  });

  it("空文字列はハッシュ0件", () => {
    expect(computeBlockHashes("")).toEqual([]);
  });
});

describe("removeTemplateBlocks", () => {
  it("templateHashesが空なら何も除去しない", () => {
    const markdown = "段落1\n\n段落2";
    const result = removeTemplateBlocks(markdown, new Set());
    expect(result.markdown).toBe(markdown);
    expect(result.removedCount).toBe(0);
  });

  it("templateHashesに一致するブロックを除去する", () => {
    const markdown = "ホーム | 会社概要 | お問い合わせ\n\n本文の段落です。十分な長さがあります。\n\nコピーライト表記です。";
    const navHash = hashContent("ホーム | 会社概要 | お問い合わせ");
    const footerHash = hashContent("コピーライト表記です。");
    const result = removeTemplateBlocks(markdown, new Set([navHash, footerHash]));
    expect(result.removedCount).toBe(2);
    expect(result.markdown).toBe("本文の段落です。十分な長さがあります。");
  });

  it("一致しないブロックは残す", () => {
    const markdown = "段落A\n\n段落B\n\n段落C";
    const hashA = hashContent("段落A");
    const result = removeTemplateBlocks(markdown, new Set([hashA]));
    expect(result.removedCount).toBe(1);
    expect(result.markdown).toBe("段落B\n\n段落C");
  });

  it("全ブロックが定型と判定された場合は空文字列になる", () => {
    const markdown = "ナビ\n\nフッタ";
    const hashes = new Set([hashContent("ナビ"), hashContent("フッタ")]);
    const result = removeTemplateBlocks(markdown, hashes);
    expect(result.markdown).toBe("");
    expect(result.removedCount).toBe(2);
  });
});
