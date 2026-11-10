import { describe, expect, it } from "vitest";
import { extractMarkdown } from "../src/extract/markdown.js";
import { buildOutline } from "../src/extract/outline.js";
import { normalizeCjkText } from "../src/jp/normalize.js";
import { splitIntoBlocks } from "../src/tokens.js";

// コードの中に ``` を含むブロックは、それより長いフェンスで囲まれる(turndownの出力も同じ)。
const NESTED_FENCE = ["````markdown", "```bash", "# install the tool", "", "npm i -g ｔｏｏｌ", "```", "````"].join("\n");

describe("フェンスコードブロックの判定(CommonMark準拠)", () => {
  it("outline: 長いフェンスの中の ``` で状態が反転せず、コードのコメントを節にしない", () => {
    const markdown = ["## Example", "", NESTED_FENCE, "", "## Next", "", "Done."].join("\n");
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["Example", "Next"]);
  });

  it("outline: チルダのフェンスの中の # も見出しにしない", () => {
    const markdown = ["## Example", "", "~~~", "# comment", "~~~", "", "## Next"].join("\n");
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["Example", "Next"]);
  });

  it("outline: 開いたフェンスより短いフェンスや別の文字では閉じない", () => {
    const markdown = ["## Example", "", "````", "```", "~~~~", "# still code", "````", "", "## Next"].join("\n");
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["Example", "Next"]);
  });

  it("outline: 情報文字列にバッククォートを含む行はフェンスでなく、後ろの見出しを隠さない", () => {
    const markdown = ["## Example", "", "``` inline `code` ```", "", "## Next"].join("\n");
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["Example", "Next"]);
  });

  it("ブロック分割: 長いフェンスの中の空行でブロックを分けない", () => {
    const blocks = splitIntoBlocks(["前の段落。", "", NESTED_FENCE, "", "後の段落。"].join("\n"));
    expect(blocks.map((block) => block.text)).toEqual(["前の段落。", NESTED_FENCE, "後の段落。"]);
  });

  it("リストの中で4字以上字下げされたフェンスもコードとして保護する(全角の英数を変えない)", () => {
    const html = "<html><body><main><ol><li><p>手順です。</p><pre><code>ＡＢＣ = 1\n\nprint(ＡＢＣ)\n</code></pre></li></ol></main></body></html>";
    const { markdown } = extractMarkdown(html, { selector: "main" });
    expect(markdown).toMatch(/^ {4,}```$/m);
    expect(markdown).toContain("ＡＢＣ = 1");
    expect(markdown).toContain("print(ＡＢＣ)");
  });

  it("フェンスの文字の後ろに別の文字が続く行では閉じない", () => {
    const markdown = ["## Example", "", "```", "# a", "``` not a closing fence", "# b", "```", "", "## Next"].join("\n");
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["Example", "Next"]);
  });

  it.each(["～～～～～", "｀｀｀"])("全角の区切り線「%s」は幅の統一の後もフェンスにならず、後ろの見出しを隠さない", (separator) => {
    const html = `<html><body><main><h2>はじめに</h2><p>前の段落です。</p><p>${separator}</p><h2>次の節</h2><p>本文です。</p><h2>最後の節</h2><p>おわりです。</p></main></body></html>`;
    const { markdown } = extractMarkdown(html, { selector: "main" });
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["はじめに", "次の節", "最後の節"]);
    expect(splitIntoBlocks(markdown)).toHaveLength(7);
  });

  it("正規化: 行の途中から始まる地の文の「～～～」はエスケープしない", () => {
    expect(normalizeCjkText("値は `x` ～～～です")).toBe("値は `x` ~~~です");
  });

  it("正規化: 長いフェンスの中の ``` の後ろもコードとして保護し、フェンスの外は正規化する", () => {
    const result = normalizeCjkText(["説明 です。", "", NESTED_FENCE, "", "続き です。"].join("\n"));
    expect(result).toContain(NESTED_FENCE);
    expect(result).toContain("説明です。");
    expect(result).toContain("続きです。");
  });
});
