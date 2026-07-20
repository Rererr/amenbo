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

describe("extractMarkdown - 複雑表の正規化(全経路)", () => {
  // Readabilityが本文に保持する複雑表(colspan/rowspan・多段ヘッダ)。救出経路ではなく
  // 「保持された表」なので、turndown直前の共通パスで正規化されないと列ズレ・空セルになる。
  const readabilityComplex = `<!DOCTYPE html><html lang="ja"><head><title>料金プラン</title></head><body>
    <article>
      <h1>料金プランの比較</h1>
      <p>${"当サービスの各プランについて説明します。以下は代表的な項目です。".repeat(3)}</p>
      <h2>プラン別料金表</h2>
      <table>
        <tr><th rowspan="2">プラン</th><th colspan="2">国内</th></tr>
        <tr><th>月額</th><th>年額</th></tr>
        <tr><td>ベーシック</td><td>500円</td><td>5000円</td></tr>
        <tr><td>プロ</td><td>1500円</td><td>15000円</td></tr>
      </table>
      <p>${"以上が料金プランの概要です。詳細はお問い合わせください。".repeat(4)}</p>
    </article></body></html>`;

  it("Readability経路で保持された複雑表を列ズレなく単一の表へ正規化する", () => {
    const result = extractMarkdown(readabilityComplex, { url: "https://example.com/pricing" });
    expect(result.extractionMethod).toBe("readability");
    // 区切り行はちょうど1本(表が二重挿入されていない)。
    expect(result.markdown.match(/^\| --- \|/gm) ?? []).toHaveLength(1);
    // 多段ヘッダが列ごとに結合される。
    expect(result.markdown).toContain("国内月額");
    expect(result.markdown).toContain("国内年額");
    // 全表行が同一列数(=列ズレなし)。
    const rows = result.markdown.split("\n").filter((line) => line.trim().startsWith("|"));
    const colCounts = new Set(rows.map((line) => line.split("|").length));
    expect(colCounts.size).toBe(1);
  });

  // wikipedia-jaアダプタはReadabilityをバイパスするため、readability経路限定の正規化では
  // 日本語Wikipediaのrowspan表(実世界で最頻)を救えない。共通パス配置の回帰テスト。
  const wikipediaComplex = `<!DOCTYPE html><html lang="ja"><head><title>統計 - Wikipedia</title></head><body>
    <div class="mw-parser-output">
      <p>${"この記事は各年の統計をまとめたものである。".repeat(3)}</p>
      <table class="wikitable">
        <tr><th rowspan="2">年</th><th colspan="2">人口</th></tr>
        <tr><th>男</th><th>女</th></tr>
        <tr><td>2020</td><td>100</td><td>110</td></tr>
        <tr><td>2021</td><td>101</td><td>111</td></tr>
      </table>
    </div></body></html>`;

  it("アダプタ経路(wikipedia-ja/Readability非経由)で保持された複雑表も正規化する", () => {
    const result = extractMarkdown(wikipediaComplex, { url: "https://ja.wikipedia.org/wiki/統計" });
    expect(result.extractionMethod).toBe("adapter");
    expect(result.adapterName).toBe("wikipedia-ja");
    expect(result.markdown.match(/^\| --- \|/gm) ?? []).toHaveLength(1);
    expect(result.markdown).toContain("人口男");
    expect(result.markdown).toContain("人口女");
    const rows = result.markdown.split("\n").filter((line) => line.trim().startsWith("|"));
    expect(new Set(rows.map((line) => line.split("|").length)).size).toBe(1);
  });

  it("th無し・span無しの単純表(レイアウト相当)を正規化対象外として素通しする", () => {
    // th無し・単純セルのみの表はデータ表判定/多段ヘッダ判定に掛からず正規化対象外。
    const layoutHtml = `<!DOCTYPE html><html lang="ja"><head><title>会社概要</title></head><body>
      <article>
        <h1>会社概要</h1>
        <p>${"当社の基本情報を以下にまとめています。".repeat(4)}</p>
        <table>
          <tr><td>設立</td><td>2020年</td></tr>
          <tr><td>所在地</td><td>東京都</td></tr>
        </table>
        <p>${"以上が当社の概要です。お気軽にお問い合わせください。".repeat(4)}</p>
      </article></body></html>`;
    const result = extractMarkdown(layoutHtml, { url: "https://example.com/about" });
    expect(result.markdown).toContain("設立");
    expect(result.markdown).toContain("2020年");
    expect(result.markdown).toContain("所在地");
    expect(result.markdown).toContain("東京都");
  });

  it("全行がヘッダ(全セルth)の表でもデータ行を消失させない", () => {
    // 全ヘッダ表を多段ヘッダとして畳むと2行目以降が消えるリグレッションの回帰テスト。
    const allThHtml = `<!DOCTYPE html><html lang="ja"><head><title>担当表</title></head><body>
      <article>
        <h1>担当者一覧</h1>
        <p>${"以下は担当者の一覧表です。各行がメンバーを表します。".repeat(3)}</p>
        <table>
          <tr><th>名前</th><th>役割</th></tr>
          <tr><th>Alice</th><th>PM</th></tr>
          <tr><th>Bob</th><th>Dev</th></tr>
          <tr><th>Carol</th><th>QA</th></tr>
        </table>
        <p>${"以上が担当者の一覧です。".repeat(6)}</p>
      </article></body></html>`;
    const result = extractMarkdown(allThHtml, { url: "https://example.com/team" });
    for (const cell of ["Alice", "Bob", "Carol", "PM", "Dev", "QA"]) {
      expect(result.markdown).toContain(cell);
    }
  });

  it("複雑表のcaptionテキストを出力に残す", () => {
    const captionHtml = `<!DOCTYPE html><html lang="ja"><head><title>売上</title></head><body>
      <article>
        <h1>地域別売上</h1>
        <p>${"以下は地域別の売上をまとめた表です。".repeat(4)}</p>
        <table>
          <caption>2024年度地域別売上一覧</caption>
          <tr><th rowspan="2">地域</th><th colspan="2">売上</th></tr>
          <tr><th>上期</th><th>下期</th></tr>
          <tr><td>東日本</td><td>100</td><td>200</td></tr>
        </table>
        <p>${"以上が売上の概要です。".repeat(6)}</p>
      </article></body></html>`;
    const result = extractMarkdown(captionHtml, { url: "https://example.com/sales" });
    expect(result.markdown).toContain("2024年度地域別売上一覧");
    // 多段ヘッダは正しくヘッダ行として残る(captionでヘッダが降格していない)。
    expect(result.markdown).toContain("売上上期");
    expect(result.markdown).toContain("売上下期");
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
