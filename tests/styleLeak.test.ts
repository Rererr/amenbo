import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { removeResidualNoscriptElements, removeStyleLeakElements, type StyleLeakHostDocument } from "../src/extract/markdown.js";

function documentOf(html: string): StyleLeakHostDocument {
  return parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`).document as unknown as StyleLeakHostDocument;
}

describe("removeStyleLeakElements", () => {
  it("style要素をどこにネストしていても除去する", () => {
    const doc = documentOf('<div><span class="mw-empty-elt"><style>.foo{color:red}</style></span>本文</div>');
    removeStyleLeakElements(doc);
    const html = (doc as unknown as { body: { innerHTML: string } }).body.innerHTML;
    expect(html).not.toContain("<style");
    expect(html).not.toContain("color:red");
    expect(html).toContain("本文");
  });

  it("table セル内の style も除去する(WikipediaのTemplateStyles相当)", () => {
    const doc = documentOf(
      '<table><tr><td><style data-mw-deduplicate="TemplateStyles:r1">.bar{display:flex}</style>実データ</td></tr></table>',
    );
    removeStyleLeakElements(doc);
    const html = (doc as unknown as { body: { innerHTML: string } }).body.innerHTML;
    expect(html).not.toContain("display:flex");
    expect(html).toContain("実データ");
  });

  it("scriptも除去する", () => {
    const doc = documentOf("<div><script>alert(1)</script>本文</div>");
    removeStyleLeakElements(doc);
    const html = (doc as unknown as { body: { innerHTML: string } }).body.innerHTML;
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("本文");
  });

  it("pre/code内のstyle/scriptはコード例とみなし対象外にする", () => {
    const doc = documentOf("<pre><code>&lt;style&gt;.x{color:red}&lt;/style&gt;</code></pre><pre><style>.y{color:blue}</style></pre>");
    removeStyleLeakElements(doc);
    const html = (doc as unknown as { body: { innerHTML: string } }).body.innerHTML;
    // エスケープされたテキストはそもそも要素ではないためそのまま残る。
    expect(html).toContain("&lt;style&gt;.x{color:red}&lt;/style&gt;");
    // pre直下の実要素としてのstyleも、コード例とみなし除去しない。
    expect(html).toContain(".y{color:blue}");
  });

  // Readability.parse()内の_unwrapNoscriptImages()が遅延読み込みプレースホルダimgをnoscript内の
  // 実画像へ差し替えるため、その処理より前にnoscriptを消してしまうと実画像URLが失われる。
  // removeStyleLeakElementsはReadability実行前(抽出処理全体の最初)に呼ばれるため、noscriptには
  // 触れてはならない。
  it("noscriptには触れない(Readabilityの画像復元より前に消えるのを防ぐ)", () => {
    const doc = documentOf('<img src="placeholder.gif"><noscript><img src="https://example.com/real-photo.jpg"></noscript>');
    removeStyleLeakElements(doc);
    const html = (doc as unknown as { body: { innerHTML: string } }).body.innerHTML;
    expect(html).toContain("<noscript");
    expect(html).toContain("real-photo.jpg");
  });
});

describe("removeResidualNoscriptElements", () => {
  it("noscriptをどこにネストしていても除去する", () => {
    const html = removeResidualNoscriptElements("<div><noscript>JS無効時の代替文</noscript>本文</div>");
    expect(html).not.toContain("<noscript");
    expect(html).not.toContain("JS無効時の代替文");
    expect(html).toContain("本文");
  });

  it("noscriptを含まないHTMLはそのまま返す", () => {
    const html = "<p>本文のみ</p>";
    expect(removeResidualNoscriptElements(html)).toBe(html);
  });

  it("pre/code内のnoscriptはコード例とみなし対象外にする", () => {
    const html = removeResidualNoscriptElements("<pre><noscript>.y{color:blue}</noscript></pre>");
    expect(html).toContain("<noscript");
  });
});
