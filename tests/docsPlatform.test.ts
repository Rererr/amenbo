import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readability } from "@mozilla/readability";
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

describe("ユーティリティクラスの値とReadabilityのclass名の採点", () => {
  it("overflow-hidden・md:overflow-y-scrollを持つ容れ物の中の手順も本文に残る", () => {
    const intro = Array.from(
      { length: 4 },
      (_, i) => `<p>Paragraph ${i} explains how the relay daemon delivers messages, why workers acknowledge them, and what happens on failure.</p>`,
    ).join("");
    const step = (n: number, utility: string, title: string, body: string): string =>
      `<div role="listitem" class="step relative flex items-start pb-5"><div class="absolute py-2">${n}</div>` +
      `<div class="w-full ${utility} pl-8 pr-px"><p class="mt-2 font-semibold">${title}</p><div class="prose"><span>${body}</span></div></div></div>`;
    const html = `<!DOCTYPE html><html><body><article><h1>Relay guide</h1>${intro}<h2>Set up</h2><div role="list" class="steps ml-3">${step(
      1,
      "overflow-hidden",
      "Install the daemon",
      "Run the installer once per machine.",
    )}${step(2, "md:overflow-y-scroll", "Start the workers", "Each worker connects on start.")}</div>${intro}</article></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.com/relay" });
    expect(markdown).toContain("Install the daemon");
    expect(markdown).toContain("Each worker connects on start.");
  });
});

describe("codeを子に持たないpre(Sphinx型)", () => {
  it("フェンスで囲み、中の# コメントを見出しにせず、記号もエスケープしない", () => {
    const pre = '<div class="highlight"><pre><span></span><span class="k">def</span> <span class="nf">do_local</span>():\n    <span class="c1"># spam = local</span>\n    return 1\n</pre></div>';
    const html = `<!DOCTYPE html><html><body><main><h2>Scopes</h2><p>This is an example:</p>${pre}<p>Done.</p></main></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.org/classes.html", selector: "main" });
    expect(markdown).toContain("```\ndef do_local():\n    # spam = local\n    return 1\n```");
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["Scopes"]);
  });

  const preMarkdown = (inner: string): string =>
    extractMarkdown(`<html><body><main><h2>例</h2>${inner}<h2>次</h2><p>後の段落です。</p></main></body></html>`, { selector: "main" }).markdown;

  it.each([
    ["codeの無いpreの<br>", "<pre>一行目<br>二行目</pre>", "一行目\n二行目"],
    ["<pre><code>の<br>", "<pre><code>a = 1<br>b = 2</code></pre>", "a = 1\nb = 2"],
    ["Prettifyのlinenums(行ごとの<li>)", '<pre class="prettyprint linenums"><ol><li>int a = 1;</li><li>int b = 2;</li></ol></pre>', "int a = 1;\nint b = 2;"],
    ["行ごとの<div>", '<pre><code><div class="line">x = 1</div><div class="line">y = 2</div></code></pre>', "x = 1\ny = 2"],
    ["行ごとの<p>", "<pre><p>first line</p><p>second line</p></pre>", "first line\nsecond line"],
  ])("%sの改行を消さない", (_label, inner, code) => {
    expect(preMarkdown(inner)).toContain(`\`\`\`\n${code}\n\`\`\``);
  });

  it.each([
    ["codeの無いpre", '<div class="highlight"><pre><span></span>1. step\n   ```bash\n   npm i\n   ```\n</pre></div>'],
    ["<pre><code>", "<pre><code>1. step\n   ```bash\n   npm i\n   ```\n</code></pre>"],
  ])("%sの中の字下げした```で外側のフェンスが閉じず、後ろの見出しが残る", (_label, inner) => {
    const markdown = preMarkdown(inner);
    expect(markdown).toContain("````\n1. step");
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["例", "次"]);
  });

  it("<pre><code>の言語の指定はフェンスに残す", () => {
    expect(preMarkdown('<pre><code class="language-ts">const a = 1;</code></pre>')).toContain("```ts\nconst a = 1;\n```");
  });
});

describe("コードブロックの容れ物とReadabilityの負の語", () => {
  it("スクロール領域の部品名(scroll)を持つ容れ物の中のコードブロックがフェンスで残る", () => {
    // Mintlify型のコードグループ。スクロール領域の部品名がclassに残る(言語のタブの側と本体の側)。
    const scrollArea = "size-full rounded-[inherit] [--scroll-area-fade-size:32px] base-ui-disable-scrollbar";
    const codeGroup =
      `<div class="code-group mt-5 mb-8 not-prose rounded-2xl"><div class="flex items-center"><div class="min-w-0 flex-1"><div class="${scrollArea} overflow-y-hidden!">` +
      '<div role="tablist" class="text-xs flex"><button type="button">bash</button></div></div></div></div>' +
      `<div class="flex flex-1"><div role="tabpanel" class="w-full min-w-full relative"><div class="${scrollArea} py-3.5 px-4">` +
      '<div class="font-mono whitespace-pre"><pre class="shiki"><code>relayd --config /etc/relayd.toml --workers 4</code></pre></div></div></div></div></div>';
    const intro = Array.from(
      { length: 5 },
      (_, i) => `<p>Paragraph ${i} explains how the relay daemon delivers messages, why workers acknowledge them, and what happens on failure.</p>`,
    ).join("");
    const html = `<!DOCTYPE html><html><body><article><h1>Relay guide</h1>${intro}<h2>Run</h2><p>Start the daemon with the configuration file:</p>${codeGroup}${intro}</article></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.com/relay" });
    expect(markdown).toContain("```\nrelayd --config /etc/relayd.toml --workers 4\n```");
  });

  describe("短いコードを含む部品", () => {
    const page = (inner: string): string => {
      const body = (n: number, word: string): string =>
        Array.from({ length: n }, (_, i) => `<p>${word} paragraph ${i}. This article explains how the relay daemon delivers messages and what happens when a delivery fails.</p>`).join("");
      const html = `<html><body><div class="wrap"><article class="post"><h1>Title</h1>${body(6, "Body")}${inner}${body(3, "Tail")}</article></div></body></html>`;
      return extractMarkdown(html, { url: "https://blog.example.com/relay" }).markdown;
    };
    const code = "<pre><code>npm install relay-daemon --save-dev</code></pre>";
    const count = (markdown: string, needle: string): number => markdown.split(needle).length - 1;

    it.each([
      ["コメント欄", `<div class="comment"><p>Try this:</p>${code}</div>`, "Try this"],
      ["サイドバー", '<div class="sidebar-widget"><p>Install</p><pre><code>brew install relay</code></pre></div>', "brew install"],
    ])("%sは、コードを含んでも本文に入らない", (_label, inner, needle) => {
      expect(count(page(inner), needle)).toBe(0);
    });

    it("画面幅ごとに出し分ける同じコード(hidden md:blockとmd:hidden)は1つだけ出す", () => {
      expect(count(page(`<div class="hidden md:block">${code}</div><div class="md:hidden">${code}</div>`), "npm install relay")).toBe(1);
    });

    it("隠れたタブ(hidden)のコードは出さない", () => {
      const tabs = `<div class="tabs"><div class="tab-panel">${code}</div><div class="tab-panel hidden"><pre><code>pnpm add relay-daemon -D</code></pre></div></div>`;
      const markdown = page(tabs);
      expect(count(markdown, "npm install relay")).toBe(1);
      expect(count(markdown, "pnpm add")).toBe(0);
    });
  });

  it("コード以外の文字を多く持つ祖先(コメント欄)の負の語は外さない", () => {
    const article = Array.from({ length: 8 }, (_, i) => `<p>Body paragraph ${i}. This article explains how the relay daemon delivers messages and what happens when a delivery fails.</p>`).join("");
    const comment = (i: number): string =>
      `<div class="comment-body"><p>Reader ${i} says the guide helped and shares the command that worked on their machine after a long search.</p><pre><code>relayd --workers ${i}</code></pre></div>`;
    const html = `<!DOCTYPE html><html><body><div><article><h1>Relay guide</h1>${article}</article><div class="comment-list">${Array.from(
      { length: 4 },
      (_, i) => comment(i),
    ).join("")}</div></div></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://blog.example.com/relay" });
    expect(markdown).toContain("Body paragraph 0");
    expect(markdown).not.toContain("Reader 0 says");
  });
});

describe("ユーティリティクラスの値でない名前(scroll-container)", () => {
  it("scroll-containerの関連記事の一覧は本文に混ざらない", () => {
    const body = Array.from(
      { length: 8 },
      (_, i) => `<p>Body paragraph ${i}. This article explains how the relay daemon delivers messages, why workers acknowledge them, and what happens when a delivery fails.</p>`,
    ).join("");
    const card = (i: number): string =>
      `<div class="card"><p>Teaser ${i}: another post about scheduling, retries, and queues, with a short summary of what the reader will learn there.</p></div>`;
    const html = `<html><body><div class="mx-auto max-w-5xl"><div class="post-body"><h1>Title</h1>${body}</div><div class="scroll-container">${Array.from(
      { length: 4 },
      (_, i) => card(i),
    ).join("")}</div></div></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://blog.example.com/post" });
    expect(markdown).toContain("Body paragraph 0");
    expect(markdown).not.toContain("Teaser 0");
  });
});

describe("見出しから作ったidとReadabilityの「本文らしくない名前」", () => {
  const section = (n: number, title: string): string =>
    `<section id="section-${n}"><h2>${n}. ${title}</h2>` +
    Array.from({ length: 3 }, (_, i) => `<p>Section ${n} paragraph ${i} defines how a cache stores, reuses, and validates responses for ${title}.</p>`).join("") +
    "</section>";
  const html =
    `<!DOCTYPE html><html><body><article>${section(1, "Introduction")}${section(2, "Overview")}` +
    `<div id="header.field.definitions">${section(3, "Field Definitions")}</div>${section(4, "Security")}</article>` +
    `<div id="sidebar"><p>Sidebar links and a short note about this site.</p></div></body></html>`;

  it("章を包む要素のidが判定の語(header)を含んでも、その章は本文に残る", () => {
    const { markdown } = extractMarkdown(html, { url: "https://www.example.org/rfc/rfc0000.html" });
    expect(markdown).toMatch(/^## 3\\?\. Field Definitions$/m);
    expect(markdown).toContain("Section 3 paragraph 2 defines");
  });

  it("本文に比べて小さいサイドバーは従来どおり落ちる", () => {
    const { markdown } = extractMarkdown(html, { url: "https://www.example.org/rfc/rfc0000.html" });
    expect(markdown).not.toContain("Sidebar links");
  });

  it("表だけを包む要素のidが判定の語を含んでも、その節(見出し・段落・表)は元の位置に残る", () => {
    // xml2rfc型: 節番号と節名を自己リンクにした見出し、段落末の¶、表を包むidだけのdiv。
    const para = (id: string, text: string): string => `<p id="${id}">${text}<a href="#${id}" class="pilcrow">¶</a></p>`;
    const rfcSection = (n: number, title: string): string =>
      `<section id="section-${n}"><h2 id="name-${n}"><a href="#section-${n}" class="selfRef">${n}. </a><a href="#name-${n}" class="selfRef">${title}</a></h2>` +
      Array.from({ length: 3 }, (_, i) => para(`section-${n}-${i}`, `Section ${n} paragraph ${i} defines how a cache stores, reuses, and validates responses for ${title}.`)).join("") +
      "</section>";
    const rows = ["Age", "Cache-Control", "Expires", "Pragma", "Warning"]
      .map((name, i) => `<tr><td>${name}</td><td>permanent</td><td><a href="#field.${i}" class="xref">5.${i + 1}</a></td><td></td></tr>`)
      .join("");
    const table = `<table id="table-1"><caption><a href="#table-1" class="selfRef">Table 1</a></caption><thead><tr><th>Field Name</th><th>Status</th><th>Section</th><th>Comments</th></tr></thead><tbody>${rows}</tbody></table>`;
    const iana =
      `<section id="section-8"><h2 id="name-iana"><a href="#section-8" class="selfRef">8. </a><a href="#name-iana" class="selfRef">IANA Considerations</a></h2>` +
      para("section-8-1", "The change controller for the following registrations is the task force.") +
      `<div id="field.name.registration"><section id="section-8.1"><h3 id="name-fnr"><a href="#section-8.1" class="selfRef">8.1. </a><a href="#name-fnr" class="selfRef">Field Name Registration</a></h3>` +
      para(
        "section-8.1-1",
        `IANA has updated the "Field Name Registry" at <span>&lt;<a href="https://registry.example.org/fields">https://registry.example.org/fields</a>&gt;</span>, as described in <span><a href="https://www.example.org/rfc/rfc0001#section-18" class="relref">Section 18</a> of [<a href="#HTTP" class="xref">HTTP</a>]</span>, with the field names listed in the table below:`,
      ) +
      `<div id="iana.header.registration.table">${table}</div></section></div>` +
      `<div id="cache.directive.registration"><section id="section-8.2"><h3 id="name-cdr"><a href="#section-8.2" class="selfRef">8.2. </a><a href="#name-cdr" class="selfRef">Cache Directive Registration</a></h3>` +
      para("section-8.2-1", "IANA has updated the cache directive registry with the registration procedure and the directives defined in this document.") +
      "</section></div></section>";
    const page = `<!DOCTYPE html><html><body><article>${rfcSection(1, "Introduction")}${rfcSection(2, "Overview")}${rfcSection(3, "Storing")}${iana}${rfcSection(9, "References")}</article></body></html>`;
    const { markdown } = extractMarkdown(page, { url: "https://www.example.org/rfc/rfc0000.html" });
    const headingAt = markdown.indexOf("Field Name Registration");
    expect(headingAt).toBeGreaterThan(-1);
    expect(markdown.indexOf("| Age |")).toBeGreaterThan(headingAt);
    expect(markdown.indexOf("| Age |")).toBeLessThan(markdown.indexOf("Cache Directive Registration"));
  });

  it("idが判定の語に当たるコメント欄は、本文より長くても本文に混ざらない", () => {
    const post = (i: number): string =>
      `<li class="item"><p>読者${i}さんの投稿です。とても参考になりました。私も同じ問題で困っていたので、手順どおりに試してみたところ、うまく動きました。</p></li>`;
    const article = Array.from({ length: 20 }, (_, i) => `<p>本文の段落${i}です。この記事では、日本語のブログで本文を抽出するときに、コメント欄が混ざらないかを確かめます。</p>`).join("");
    const page = `<html><body><div id="wrap"><div id="main"><div class="entry"><h1>題名</h1>${article}</div></div><div id="comments"><h2>みんなの反応</h2><ul>${Array.from(
      { length: 30 },
      (_, i) => post(i),
    ).join("")}</ul></div></div></body></html>`;
    const { markdown } = extractMarkdown(page, { url: "https://blog.example.jp/entry/1" });
    expect(markdown).toContain("本文の段落0");
    expect(markdown).not.toContain("読者0さん");
  });

  it("名前の判定はReadabilityの同じ版から借りている(版の更新で消えたらここで気づく)", () => {
    const regexps = (Readability.prototype as unknown as { REGEXPS?: Record<string, unknown> }).REGEXPS;
    expect(regexps?.unlikelyCandidates).toBeInstanceOf(RegExp);
    expect(regexps?.negative).toBeInstanceOf(RegExp);
  });

  it("Readabilityの版が変わって名前の判定を借りられなくても、抽出は失敗しない", () => {
    const prototype = Readability.prototype as unknown as { REGEXPS?: unknown };
    const saved = prototype.REGEXPS;
    // 本体はインスタンス経由で同じ表を引くので、プロトタイプから直接引いたときだけ無いことにする。
    Object.defineProperty(prototype, "REGEXPS", {
      configurable: true,
      get(this: unknown) {
        return this === prototype ? undefined : saved;
      },
    });
    try {
      expect(extractMarkdown(html, { url: "https://www.example.org/rfc/rfc0000.html" }).markdown).toContain("Section 1 paragraph 0");
    } finally {
      Object.defineProperty(prototype, "REGEXPS", { configurable: true, writable: true, value: saved });
    }
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

  it("見出しの中のページ内リンクがalt付きの画像だけを持つなら、画像は残す", () => {
    const html = `<!DOCTYPE html><html><body><main><h2><a href="#logo"><img alt="製品ロゴ" src="https://docs.example.org/logo.png"></a> 製品紹介</h2>${paragraph}</main></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.org/", selector: "main" });
    expect(markdown).toContain("![製品ロゴ](https://docs.example.org/logo.png)");
  });

  it("中身が空の見出しは`## `だけの行として出さない", () => {
    const html = `<!DOCTYPE html><html><body><main><h2> </h2>${paragraph}<h2><a href="#x">​</a></h2>${paragraph}<h2>次の節</h2>${paragraph}</main></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.org/", selector: "main" });
    expect(markdown).not.toMatch(/^#{1,6}\s*$/m);
    expect(buildOutline(markdown).sections.map((section) => section.heading)).toEqual(["(冒頭)", "次の節"]);
  });

  it("見出しの外のページ内リンクはそのまま残す", () => {
    const html = `<!DOCTYPE html><html><body><main><h2>概要</h2><p>詳しくは<a href="#detail">詳細</a>を参照。</p>${paragraph}</main></body></html>`;
    const { markdown } = extractMarkdown(html, { url: "https://docs.example.org/", selector: "main" });
    expect(markdown).toContain("[詳細](#detail)");
  });
});
