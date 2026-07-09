import { describe, expect, it } from "vitest";
import { estimateTokens, paginateMarkdown } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("空文字列は0トークン", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("英語テキストはASCII係数(1トークン≒3.8文字)で見積もる", () => {
    const text = "a".repeat(38); // 38文字 / 3.8 = 10
    expect(estimateTokens(text)).toBe(10);
  });

  it("日本語テキストはCJK係数(1文字≒0.9トークン)で見積もる", () => {
    const text = "あ".repeat(10); // 10文字 * 0.9 = 9
    expect(estimateTokens(text)).toBe(9);
  });

  it("日本語テキストの方が同じ文字数の英語より高いトークン数になる", () => {
    const ja = "日".repeat(20);
    const en = "a".repeat(20);
    expect(estimateTokens(ja)).toBeGreaterThan(estimateTokens(en));
  });

  it("日英混在テキストを係数別に合算する", () => {
    const text = "あ".repeat(10) + "a".repeat(38); // 9 + 10 = 19
    expect(estimateTokens(text)).toBe(19);
  });

  it("空白文字はトークン計算に含めない", () => {
    expect(estimateTokens("   \n\t  ")).toBe(0);
  });
});

describe("paginateMarkdown", () => {
  it("予算内に収まる場合は1ページで全文を返す", () => {
    const markdown = "# 見出し\n\n本文です。";
    const result = paginateMarkdown(markdown, 1000, 1);
    expect(result.totalPages).toBe(1);
    expect(result.page).toBe(1);
    expect(result.content).toBe(markdown);
  });

  it("予算を超える長文は段落境界で複数ページに分割する", () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `段落${i}です。`.repeat(20));
    const markdown = paragraphs.join("\n\n");
    const result = paginateMarkdown(markdown, 50, 1);
    expect(result.totalPages).toBeGreaterThan(1);
    // 各ページの内容は元の段落の一部であり、途中で単語が切れていない(段落単位で分割)
    for (const paragraph of result.content.split("\n\n")) {
      expect(markdown).toContain(paragraph);
    }
  });

  it("pageカーソルで2ページ目以降を取得できる", () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `段落${i}の内容です。`.repeat(10));
    const markdown = paragraphs.join("\n\n");
    const page1 = paginateMarkdown(markdown, 30, 1);
    const page2 = paginateMarkdown(markdown, 30, 2);
    expect(page1.content).not.toBe(page2.content);
    expect(page2.page).toBe(2);
  });

  it("範囲外のページ番号は有効範囲へ丸める", () => {
    const markdown = "# 見出し\n\n本文です。";
    const result = paginateMarkdown(markdown, 1000, 99);
    expect(result.page).toBe(result.totalPages);
  });

  it("フェンスコードブロックは分割されない(表・コードを壊さない)", () => {
    const bigCode = "```\n" + "x = 1;\n".repeat(200) + "```";
    const markdown = `前置き文章。\n\n${bigCode}\n\n後書き文章。`;
    const result = paginateMarkdown(markdown, 20, 1);
    // 巨大コードブロックを含むページには、コードブロック全体がそのまま含まれる
    const codePage = [result, paginateMarkdown(markdown, 20, 2), paginateMarkdown(markdown, 20, 3)].find((p) =>
      p.content.includes("```"),
    );
    expect(codePage?.content).toContain(bigCode);
  });

  it("見出し直前で予算の60%を超えていれば改ページする", () => {
    const markdown = ["段落1です。".repeat(5), "# 次のセクション", "段落2です。"].join("\n\n");
    const result = paginateMarkdown(markdown, 15, 1);
    expect(result.content).not.toContain("# 次のセクション");
  });

  describe("N6: exceededBudget(単一ブロックがmax_tokens予算を超過した場合のフラグ)", () => {
    it("予算内に収まる通常の応答ではexceededBudgetはfalse", () => {
      const result = paginateMarkdown("# 見出し\n\n本文です。", 1000, 1);
      expect(result.exceededBudget).toBe(false);
    });

    it("単一ブロック(巨大なコードブロック)が予算を超える場合はexceededBudgetがtrueになる", () => {
      const bigCode = "```\n" + "x = 1;\n".repeat(200) + "```";
      const result = paginateMarkdown(bigCode, 20, 1);
      expect(result.tokens).toBeGreaterThan(20);
      expect(result.exceededBudget).toBe(true);
    });

    it("空文字列の場合はexceededBudgetはfalse", () => {
      const result = paginateMarkdown("", 1000, 1);
      expect(result.exceededBudget).toBe(false);
    });
  });
});
