import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { normalizeCjkText, stripRubyAnnotations } from "../src/jp/normalize.js";

describe("stripRubyAnnotations", () => {
  it("rt/rp要素を除去し、読み仮名が本文に混入しない", () => {
    const { document } = parseHTML(
      "<html><body><p>今日は<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>を読む</p></body></html>",
    );
    stripRubyAnnotations(document);
    expect(document.body.textContent).toBe("今日は漢字を読む");
  });

  it("rt/rpが存在しない場合は何もしない", () => {
    const { document } = parseHTML("<html><body><p>普通の文章です</p></body></html>");
    stripRubyAnnotations(document);
    expect(document.body.textContent).toBe("普通の文章です");
  });
});

describe("normalizeCjkText", () => {
  it("全角英数を半角へ正規化する(NFKC)", () => {
    expect(normalizeCjkText("ABCＡＢＣ１２３")).toBe("ABCABC123");
  });

  it("CJK文字間の空白を除去する(Turndownが挿入した半角スペース)", () => {
    expect(normalizeCjkText("これは テスト です。")).toBe("これはテストです。");
  });

  it("CJK文字間の単一改行を除去するが、段落区切りの空行(連続改行)は保持する", () => {
    const input = "これは\nテストです。\n\n次の段落です。";
    expect(normalizeCjkText(input)).toBe("これはテストです。\n\n次の段落です。");
  });

  it("フェンスコードブロック内は変更しない", () => {
    const input = "説明 文章です。\n\n```ts\nconst ｘ = 1;\nconsole.log( ｘ );\n```\n\n続き 文章。";
    const result = normalizeCjkText(input);
    expect(result).toContain("```ts\nconst ｘ = 1;\nconsole.log( ｘ );\n```");
    expect(result).toContain("説明文章です。");
    expect(result).toContain("続き文章。");
  });

  it("インラインコード内は変更しない", () => {
    const input = "変数 `全角 スペース` はそのまま。";
    const result = normalizeCjkText(input);
    expect(result).toContain("`全角 スペース`");
  });

  it("英数字と非CJKの空白はそのまま保持する(ASCII同士の間は対象外)", () => {
    expect(normalizeCjkText("Hello World")).toBe("Hello World");
  });
});
