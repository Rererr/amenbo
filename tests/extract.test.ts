import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMarkdown } from "../src/extract/markdown.js";

const fixturePath = fileURLToPath(new URL("./fixtures/article.html", import.meta.url));
const articleHtml = readFileSync(fixturePath, "utf-8");

describe("extractMarkdown", () => {
  it("タイトルを抽出する", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.title).toContain("日本語");
  });

  it("ナビゲーション/広告枠等の非本文要素を除去する(Readability)", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.markdown).not.toContain("ランキング広告枠");
    expect(result.markdown).not.toContain("フッターのコピーライト");
  });

  it("ruby(読み仮名)の重複混入を除去する(J2)", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.markdown).not.toContain("ぎじゅつ");
    expect(result.markdown).toContain("技術");
  });

  it("表(table)をMarkdownテーブルとして保持する", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.markdown).toMatch(/\|\s*項目\s*\|\s*値\s*\|/);
    expect(result.markdown).toContain("アメンボ");
  });

  it("コードブロックをフェンス付きで保持する", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.markdown).toContain("```");
    expect(result.markdown).toContain('const greeting: string = "こんにちは";');
  });

  it("強調・リンク等のインライン要素を保持する", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.markdown).toContain("強調されたテキスト");
    expect(result.markdown).toContain("[リンク](https://example.com)");
  });

  it("selector指定時はその要素のみを抽出しReadabilityをスキップする", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article", selector: "table" });
    expect(result.markdown).toContain("アメンボ");
    expect(result.markdown).not.toContain("強調されたテキスト");
  });

  it("selectorが一致しない場合はExtractionErrorを投げる", () => {
    expect(() => extractMarkdown(articleHtml, { url: "https://example.com/article", selector: ".no-such-class" })).toThrow(
      /selectorに一致する要素がありません/,
    );
  });
});
