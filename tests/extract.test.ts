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
});
