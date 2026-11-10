import { describe, expect, it } from "vitest";
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

  it("正規化: 長いフェンスの中の ``` の後ろもコードとして保護し、フェンスの外は正規化する", () => {
    const result = normalizeCjkText(["説明 です。", "", NESTED_FENCE, "", "続き です。"].join("\n"));
    expect(result).toContain(NESTED_FENCE);
    expect(result).toContain("説明です。");
    expect(result).toContain("続きです。");
  });
});
