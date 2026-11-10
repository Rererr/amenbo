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
