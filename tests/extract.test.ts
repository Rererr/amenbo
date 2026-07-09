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

  it("アダプタ非対応サイトはadapterName=null", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.adapterName).toBeNull();
  });

  it("extractionMethodはReadability成功時'readability'になる", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article" });
    expect(result.extractionMethod).toBe("readability");
  });

  it("selector指定時はextractionMethod='selector'になる", () => {
    const result = extractMarkdown(articleHtml, { url: "https://example.com/article", selector: "table" });
    expect(result.extractionMethod).toBe("selector");
  });
});

describe("extractMarkdown - Phase 4 ジオメトリ抽出", () => {
  // Readabilityが本文を特定できない(全体で31文字しかなくMIN_READABILITY_TEXT_LENGTH未満)、
  // 最小限のdiv soupページ。data-amenbo-gid付きの要素はブラウザ側が実際に付与するのと同じ形。
  const minimalHtml = `<!DOCTYPE html><html lang="ja"><head><title>会社案内</title></head><body>
    <div>短い。</div>
    <div data-amenbo-gid="1">段落1のテキストです。</div>
    <div data-amenbo-gid="2">段落2のテキストです。</div>
  </body></html>`;

  it("geometry未指定時はReadability失敗後body全体にフォールバックする(既存挙動)", () => {
    const result = extractMarkdown(minimalHtml, { url: "https://example.com/old-site" });
    expect(result.extractionMethod).toBe("body-fallback");
    expect(result.markdown).toContain("段落1のテキストです");
    expect(result.markdown).toContain("段落2のテキストです");
  });

  it("geometry指定時、Readability失敗時はクラスタ化された領域を抽出する(extraction: geometry)", () => {
    const geometry = {
      textBlocks: [
        { id: 1, x: 100, y: 0, width: 400, height: 20, textLength: 150 },
        { id: 2, x: 100, y: 30, width: 400, height: 20, textLength: 150 },
      ],
      visualElements: [],
      pageWidth: 1280,
      pageHeight: 800,
    };
    const result = extractMarkdown(minimalHtml, { url: "https://example.com/old-site", geometry });
    expect(result.extractionMethod).toBe("geometry");
    expect(result.markdown).toContain("段落1のテキストです");
    expect(result.markdown).toContain("段落2のテキストです");
    // クラスタ外(タグ付けされていない)要素の内容は含まれない
    expect(result.markdown).not.toContain("短い。");
  });

  it("geometryが指定されてもクラスタの合計テキスト量が閾値未満ならbody-fallbackする", () => {
    const geometry = {
      textBlocks: [
        { id: 1, x: 100, y: 0, width: 400, height: 20, textLength: 5 },
        { id: 2, x: 100, y: 30, width: 400, height: 20, textLength: 5 },
      ],
      visualElements: [],
      pageWidth: 1280,
      pageHeight: 800,
    };
    const result = extractMarkdown(minimalHtml, { url: "https://example.com/old-site", geometry });
    expect(result.extractionMethod).toBe("body-fallback");
  });

  it("selector指定時はgeometryが与えられていても無視される(selectorが最優先)", () => {
    const geometry = {
      textBlocks: [{ id: 1, x: 100, y: 0, width: 400, height: 20, textLength: 150 }],
      visualElements: [],
      pageWidth: 1280,
      pageHeight: 800,
    };
    const result = extractMarkdown(minimalHtml, { url: "https://example.com/old-site", selector: "body > div:first-child", geometry });
    expect(result.extractionMethod).toBe("selector");
    expect(result.markdown).toContain("短い。");
  });

  it("アダプタが一致する場合はgeometryより優先される", () => {
    const qiitaHtmlMinimal = `<!DOCTYPE html><html lang="ja"><head><title>T</title></head><body>
      <div class="it-MdContent"><p>${"Qiitaの本文です。".repeat(20)}</p></div>
      <div data-amenbo-gid="1">無関係な段落です。</div>
    </body></html>`;
    const geometry = {
      textBlocks: [{ id: 1, x: 100, y: 0, width: 400, height: 20, textLength: 999 }],
      visualElements: [],
      pageWidth: 1280,
      pageHeight: 800,
    };
    const result = extractMarkdown(qiitaHtmlMinimal, { url: "https://qiita.com/x/items/y", geometry });
    expect(result.extractionMethod).toBe("adapter");
    expect(result.adapterName).toBe("qiita");
  });
});

describe("extractMarkdown - J7 サイトアダプタ", () => {
  const qiitaHtml = `<!DOCTYPE html>
    <html lang="ja"><head><title>Qiitaテスト記事</title></head>
    <body>
      <nav>グローバルナビゲーション</nav>
      <div class="it-MdContent">
        <h1>Qiita記事の見出し</h1>
        <p>これはQiitaのアダプタが正しく本文セレクタ(.it-MdContent)を検出できるかを確認するための、十分な長さの本文段落です。もっと長く。もっと長く。もっと長く。</p>
      </div>
      <div class="p-items_sideStock">サイドバーの関連記事一覧</div>
      <footer>フッターのコピーライト</footer>
    </body></html>`;

  it("qiita.comではadapterName='qiita'になり、.it-MdContentのみを抽出する", () => {
    const result = extractMarkdown(qiitaHtml, { url: "https://qiita.com/someone/items/abc123" });
    expect(result.adapterName).toBe("qiita");
    expect(result.markdown).toContain("Qiita記事の見出し");
    expect(result.markdown).not.toContain("グローバルナビゲーション");
    expect(result.markdown).not.toContain("サイドバーの関連記事一覧");
  });

  const hatenaHtml = `<!DOCTYPE html>
    <html lang="ja"><head><title>はてなブログテスト</title></head>
    <body>
      <nav>ナビゲーション</nav>
      <article class="entry">
        <div class="entry-content">
          <p>これははてなブログのアダプタが.entry-contentを正しく検出できるかを確認するテスト段落です。もっと長く。もっと長く。もっと長く。</p>
        </div>
        <div class="hatena-module-ad">広告モジュール</div>
      </article>
    </body></html>`;

  it("*.hatenablog.comではadapterName='hatenablog'になり、広告モジュールを除去する", () => {
    const result = extractMarkdown(hatenaHtml, { url: "https://example.hatenablog.com/entry/2026/01/01/000000" });
    expect(result.adapterName).toBe("hatenablog");
    expect(result.markdown).toContain("はてなブログのアダプタ");
    expect(result.markdown).not.toContain("広告モジュール");
  });

  it("selector指定時はアダプタより優先される", () => {
    const result = extractMarkdown(qiitaHtml, { url: "https://qiita.com/someone/items/abc123", selector: "footer" });
    expect(result.adapterName).toBeNull();
    expect(result.markdown).toContain("フッターのコピーライト");
  });

  it("アダプタのcontentSelectors(article含む)が1つも一致しない場合はReadabilityへフォールバックする", () => {
    const htmlWithoutAdapterClass = `<html><head><title>Qiita風だが構造が違うページ</title></head><body><div class="page"><p>${"本文段落です。".repeat(40)}</p></div></body></html>`;
    const result = extractMarkdown(htmlWithoutAdapterClass, { url: "https://qiita.com/someone/items/xyz" });
    expect(result.adapterName).toBeNull();
    expect(result.markdown).toContain("本文段落です");
  });

  // Phase 4追加: MediaWikiは見出しを<div class="mw-heading">でラップし編集リンクを併記するため、
  // Readabilityが記事中の全見出しを剥がしてしまうことを実機検証で確認済み(実URLで再現)。
  // アダプタでReadabilityを完全にバイパスすることで見出し構造を保つ。
  const wikipediaHtml = `<!DOCTYPE html>
    <html lang="ja"><head><title>日本語 - Wikipedia</title></head>
    <body>
      <div class="mw-parser-output">
        <p>日本語は日本国内や日本人同士の間で使用されている言語である。</p>
        <div class="mw-heading mw-heading2"><h2 id="特徴">特徴</h2><span class="mw-editsection">[<a href="#">編集</a>]</span></div>
        <p>${"日本語の音韻的特徴について説明する文章です。".repeat(5)}</p>
        <div class="mw-heading mw-heading3"><h3 id="音韻">音韻</h3><span class="mw-editsection">[<a href="#">編集</a>]</span></div>
        <p>${"母音・子音の体系について説明する文章です。".repeat(5)}</p>
        <div class="navbox">関連項目のナビゲーションボックス</div>
      </div>
    </body></html>`;

  it("ja.wikipedia.orgではadapterName='wikipedia-ja'になり、見出し構造を保持する(Readabilityは見出しを剥がすため)", () => {
    const result = extractMarkdown(wikipediaHtml, { url: "https://ja.wikipedia.org/wiki/日本語" });
    expect(result.adapterName).toBe("wikipedia-ja");
    const headingLines = result.markdown.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    expect(headingLines).toEqual(["## 特徴", "### 音韻"]);
  });

  it("ja.wikipedia.orgでは編集リンク・navboxを除去する", () => {
    const result = extractMarkdown(wikipediaHtml, { url: "https://ja.wikipedia.org/wiki/日本語" });
    expect(result.markdown).not.toContain("編集");
    expect(result.markdown).not.toContain("関連項目のナビゲーションボックス");
  });
});
