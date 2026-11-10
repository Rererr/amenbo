import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMarkdown } from "../src/extract/markdown.js";
import { buildOutline } from "../src/extract/outline.js";

// docs基盤(Mintlify型)の構造を再現した合成ページ: 本文の容れ物のクラスに`banner`を含み、
// nav/header/footerを持ち、描画されない<template>にページ全体のJSON(本文の文を含む)を置き、
// 各見出しの先頭にゼロ幅空白だけを文字に持つパーマリンクを入れている。
const docsHtml = readFileSync(fileURLToPath(new URL("./fixtures/docs-platform.html", import.meta.url)), "utf-8");
const URL_ = "https://docs.example.com/relay";

const PARAGRAPHS = [
  "The relay daemon forwards queued messages to every registered worker in arrival order.",
  "Each worker acknowledges a message before the daemon removes it from the queue.",
  "Changing the file takes effect on the next restart and never interrupts running jobs.",
  "After the last attempt the message moves to the dead letter queue for manual review.",
  "Alerts fire when the oldest message stays in the queue for more than five minutes.",
];
const HEADINGS = ["Getting started", "Configure workers", "Retry policy", "Monitoring"];

describe("描画されないtemplateと見出しの書式文字(docs基盤の構造)", () => {
  it("既定の抽出で本文の段落がすべて残る", () => {
    const { markdown } = extractMarkdown(docsHtml, { url: URL_ });
    for (const paragraph of PARAGRAPHS) expect(markdown).toContain(paragraph);
  });

  it("見出しは1つずつだけ現れ、書式文字の付いた複製が並ばない", () => {
    const { markdown } = extractMarkdown(docsHtml, { url: URL_ });
    const headings = buildOutline(markdown).sections.map((section) => section.heading.replace(/\p{Cf}/gu, ""));
    for (const heading of HEADINGS) expect(headings.filter((h) => h === heading)).toHaveLength(1);
    expect(headings).toHaveLength(HEADINGS.length);
  });
});

describe("見出しの中のパーマリンクとブロック要素", () => {
  const paragraph = "<p>この段落は見出しの下に置いた本文で、抽出の経路によらず残ることを確かめるための文章です。</p>";

  it("中にdivとゼロ幅空白だけのリンクを持つ見出しが、selector経路でも1行の見出しになる", () => {
    const { markdown } = extractMarkdown(docsHtml, { url: URL_, selector: "#content" });
    const headings = buildOutline(markdown).sections.map((section) => section.heading);
    expect(headings).toEqual(HEADINGS);
  });

  it("Sphinxの`¶`リンクは見出しに残らない", () => {
    const html = `<!DOCTYPE html><html><body><main>
      <h2>9.1. A Word About Names<a class="headerlink" href="#a-word-about-names" title="Link to this heading">¶</a></h2>${paragraph}
      </main></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.org/classes.html", selector: "main" });
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["9.1. A Word About Names"]);
  });

  it("見出しの文字そのものがページ内リンクなら、文字は残す", () => {
    const html = `<!DOCTYPE html><html><body><main><h2><a href="#setup">Setup の手順</a></h2>${paragraph}</main></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.org/", selector: "main" });
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["Setup の手順"]);
  });

  it("見出しの外のページ内リンクはそのまま残す", () => {
    const html = `<!DOCTYPE html><html><body><main><h2>概要</h2><p>詳しくは<a href="#detail">詳細</a>を参照。</p>${paragraph}</main></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.org/", selector: "main" });
    expect(markdown).toContain("[詳細](#detail)");
  });
});
