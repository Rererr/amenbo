import { describe, expect, it } from "vitest";
import { buildOutline, extractSection, findSection, formatBreadcrumb } from "../src/extract/outline.js";

const SAMPLE_MARKDOWN = [
  "# 大見出し",
  "",
  "導入部の文章です。ここから記事が始まります。",
  "",
  "## 小見出し1",
  "",
  "小見出し1の本文です。",
  "",
  "### さらに深い見出し",
  "",
  "深い見出しの本文です。",
  "",
  "## 小見出し2",
  "",
  "小見出し2の本文です。二文目もあります。",
].join("\n");

describe("buildOutline", () => {
  it("h1-h4の見出しをすべてsectionとして抽出する", () => {
    const outline = buildOutline(SAMPLE_MARKDOWN);
    expect(outline.sections.map((s) => s.heading)).toEqual(["大見出し", "小見出し1", "さらに深い見出し", "小見出し2"]);
  });

  it("sectionには連番のIDが振られる", () => {
    const outline = buildOutline(SAMPLE_MARKDOWN);
    expect(outline.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("各sectionの冒頭1文をexcerptとして抜き出す(見出し行自体は含まない)", () => {
    const outline = buildOutline(SAMPLE_MARKDOWN);
    const first = outline.sections[0];
    expect(first?.excerpt).toBe("導入部の文章です。");
  });

  it("親sectionのトークン数はネストした子sectionの内容も含む", () => {
    const outline = buildOutline(SAMPLE_MARKDOWN);
    const parent = outline.sections.find((s) => s.heading === "小見出し1");
    const child = outline.sections.find((s) => s.heading === "さらに深い見出し");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parent!.tokens).toBeGreaterThan(child!.tokens);
  });

  it("h5/h6は見出しツリーに現れないが、親sectionの内容には含まれる", () => {
    const markdownWithH5 = `${SAMPLE_MARKDOWN}\n\n##### 深すぎる見出し\n\nさらに深い本文。`;
    const outline = buildOutline(markdownWithH5);
    expect(outline.sections.some((s) => s.heading === "深すぎる見出し")).toBe(false);
    const lastSection = outline.sections.find((s) => s.heading === "小見出し2");
    const content = extractSection(markdownWithH5, lastSection!.id);
    expect(content).toContain("深すぎる見出し");
  });

  it("見出しが1つも無いページは単一のsection s1として扱う", () => {
    const outline = buildOutline("見出しの無いただの文章です。");
    expect(outline.sections).toHaveLength(1);
    expect(outline.sections[0]?.id).toBe("s1");
  });

  it("空文字列はsectionを持たない", () => {
    const outline = buildOutline("");
    expect(outline.sections).toHaveLength(0);
  });

  it("レビュー指摘対応: excerptからMarkdownリンク記法を除去しテキストのみ残す", () => {
    const markdown = [
      "# 見出し",
      "",
      "[臭腺](//ja.wikipedia.org/wiki/臭腺?action=edit)から分泌される。",
    ].join("\n");
    const outline = buildOutline(markdown);
    expect(outline.sections[0]?.excerpt).toBe("臭腺から分泌される。");
    expect(outline.sections[0]?.excerpt).not.toContain("http");
    expect(outline.sections[0]?.excerpt).not.toContain("(");
  });

  it("画像記法![alt](url)はaltテキストのみ残す", () => {
    const markdown = ["# 見出し", "", "![説明図](https://example.com/img.png)を参照。"].join("\n");
    const outline = buildOutline(markdown);
    expect(outline.sections[0]?.excerpt).toBe("説明図を参照。");
  });

  it("フェンスコードブロック内の#はheadingとして扱わない", () => {
    const markdown = "# 本物の見出し\n\n```\n# これはコード内のコメント\n```\n\n本文。";
    const outline = buildOutline(markdown);
    expect(outline.sections).toHaveLength(1);
    expect(outline.sections[0]?.heading).toBe("本物の見出し");
  });
});

describe("extractSection", () => {
  it("指定したsection IDの内容(ネストした子見出しを含む)を返す", () => {
    const content = extractSection(SAMPLE_MARKDOWN, "s2");
    expect(content).toContain("## 小見出し1");
    expect(content).toContain("### さらに深い見出し");
    expect(content).toContain("深い見出しの本文です。");
    expect(content).not.toContain("## 小見出し2");
  });

  it("存在しないsection IDはnullを返す", () => {
    expect(extractSection(SAMPLE_MARKDOWN, "s999")).toBeNull();
  });
});

describe("findSection / breadcrumb", () => {
  it("深い子節は上位見出しの連なりをancestorsとして持つ", () => {
    const section = findSection(SAMPLE_MARKDOWN, "s3"); // さらに深い見出し(h3)
    expect(section?.heading).toBe("さらに深い見出し");
    expect(section?.ancestors.map((a) => a.heading)).toEqual(["大見出し", "小見出し1"]);
  });

  it("トップレベル節のancestorsは空", () => {
    const section = findSection(SAMPLE_MARKDOWN, "s1");
    expect(section?.ancestors).toEqual([]);
  });

  it("formatBreadcrumbは祖先見出しを › 区切りで連結し、祖先無しはnull", () => {
    const child = findSection(SAMPLE_MARKDOWN, "s3");
    expect(formatBreadcrumb(child!.ancestors)).toBe("大見出し › 小見出し1");
    const top = findSection(SAMPLE_MARKDOWN, "s1");
    expect(formatBreadcrumb(top!.ancestors)).toBeNull();
  });

  it("見出しなしページの単一節はancestorsを持たない", () => {
    const section = findSection("見出しの無いただの文章です。", "s1");
    expect(section?.ancestors).toEqual([]);
  });

  it("breadcrumbは祖先見出しのMarkdownリンク記法を除去する(MDN等のアンカー付き見出し対策)", () => {
    const markdown = [
      "# [Types of caches](#types_of_caches)",
      "",
      "本文。",
      "",
      "## [Shared cache](#shared_cache)",
      "",
      "共有キャッシュの本文。",
    ].join("\n");
    const child = findSection(markdown, "s2");
    expect(formatBreadcrumb(child!.ancestors)).toBe("Types of caches");
    expect(formatBreadcrumb(child!.ancestors)).not.toContain("(");
  });
});
