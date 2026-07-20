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

  // アダプタ経路はReadabilityをバイパスするため、readability経路限定の正規化では
  // アダプタが保持した複雑表を救えない。共通パス配置の回帰テスト(zennアダプタで検証)。
  const adapterComplex = `<!DOCTYPE html><html lang="ja"><head><title>統計まとめ</title></head><body>
    <div class="znc">
      <p>${"この記事は各年の統計をまとめたものである。".repeat(3)}</p>
      <table>
        <tr><th rowspan="2">年</th><th colspan="2">人口</th></tr>
        <tr><th>男</th><th>女</th></tr>
        <tr><td>2020</td><td>100</td><td>110</td></tr>
        <tr><td>2021</td><td>101</td><td>111</td></tr>
      </table>
    </div></body></html>`;

  it("アダプタ経路(Readability非経由)で保持された複雑表も正規化する", () => {
    const result = extractMarkdown(adapterComplex, { url: "https://zenn.dev/someone/articles/abc123" });
    expect(result.extractionMethod).toBe("adapter");
    expect(result.adapterName).toBe("zenn");
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

  // Wikipediaアダプタは置かない方針(サイト固有対応をしない)。MediaWiki風の見出しラッパー構造は
  // Readability経路+汎用見出し救出で扱い、言語を問わず見出し構造が残ることをここで固定する。
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

  it("wikipedia風構造はアダプタ非適用でreadability経路になり、見出し構造が残る", () => {
    const result = extractMarkdown(wikipediaHtml, { url: "https://ja.wikipedia.org/wiki/日本語" });
    expect(result.adapterName).toBeNull();
    expect(result.extractionMethod).toBe("readability");
    const headingLines = result.markdown.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    expect(headingLines).toEqual(["## 特徴", "### 音韻"]);
  });

  const zhWikipediaHtml = `<!DOCTYPE html>
    <html lang="zh"><head><title>广东省 - 维基百科</title></head>
    <body>
      <div class="mw-parser-output">
        <p>${"广东省是中华人民共和国的省级行政区之一。".repeat(3)}</p>
        <div class="mw-heading mw-heading2"><h2 id="历史">历史</h2><span class="mw-editsection">[<a href="#">编辑</a>]</span></div>
        <p>${"广东历史悠久，是岭南文化的重要发源地。".repeat(5)}</p>
        <div class="mw-heading mw-heading3"><h3 id="地理">地理</h3></div>
        <p>${"广东省地处中国大陆最南部。".repeat(5)}</p>
      </div>
    </body></html>`;

  it("zh版の同構造でも見出し構造が残る(言語対称性)", () => {
    const result = extractMarkdown(zhWikipediaHtml, { url: "https://zh.wikipedia.org/wiki/广东省" });
    expect(result.adapterName).toBeNull();
    const headingLines = result.markdown.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    expect(headingLines).toEqual(["## 历史", "### 地理"]);
  });

  const koWikipediaHtml = `<!DOCTYPE html>
    <html lang="ko"><head><title>서울특별시 - 위키백과</title></head>
    <body>
      <div class="mw-parser-output">
        <p>${"서울특별시는 대한민국의 수도이자 최대 도시이다. ".repeat(3)}</p>
        <div class="mw-heading mw-heading2"><h2 id="역사">역사</h2><span class="mw-editsection">[<a href="#">편집</a>]</span></div>
        <p>${"서울은 한강 유역에 위치한 오랜 역사를 지닌 도시이다. ".repeat(5)}</p>
        <div class="mw-heading mw-heading3"><h3 id="지리">지리</h3></div>
        <p>${"서울은 한반도의 중앙부에 자리잡고 있다. ".repeat(5)}</p>
      </div>
    </body></html>`;

  it("ko版の同構造でも見出し構造が残る(言語対称性)", () => {
    const result = extractMarkdown(koWikipediaHtml, { url: "https://ko.wikipedia.org/wiki/서울특별시" });
    expect(result.adapterName).toBeNull();
    const headingLines = result.markdown.split("\n").filter((line) => /^#{1,6}\s/.test(line));
    expect(headingLines).toEqual(["## 역사", "### 지리"]);
  });
});

// WikipediaのTemplateStyles(<style>が本文中のspan/table内に直接埋まる構造)を模した回帰テスト。
// 実測(ko/zh.wikipedia.org)で発覚したCSSリーク: turndownにstyle/script/noscriptを除外する
// ルールが無いため、Readabilityの本文選定より前に採取される救出表や、Readabilityを経由しない
// アダプタ経路では、CSSテキストがそのまま地の文へ混入していた。
describe("extractMarkdown - CSSリーク除去(style/script/noscript)", () => {
  const readabilityLeakHtml = `<!DOCTYPE html>
    <html lang="ko"><head><title>서울특별시 - Wikipedia</title></head>
    <body>
      <article>
        <h1>서울특별시</h1>
        <p>서울特別市<span class="mw-empty-elt"><style data-mw-deduplicate="TemplateStyles:r1">.mw-parser-output .hatnote{font-size:90%}.mw-parser-output div.hatnote{padding-left:1.6em}</style></span>은 대한민국의 수도이다.</p>
        <p>${"서울은 한반도 중앙에 위치한 도시로 오랜 역사를 가지고 있다.".repeat(6)}</p>
      </article>
    </body></html>`;

  it("Readability経路: spanに包まれたTemplateStyles相当のstyleを除去し地の文への吸収を防ぐ", () => {
    const result = extractMarkdown(readabilityLeakHtml, { url: "https://ko.wikipedia.org/wiki/서울특별시" });
    expect(result.extractionMethod).toBe("readability");
    expect(result.markdown).not.toContain("mw-parser-output");
    expect(result.markdown).not.toContain("hatnote");
    expect(result.markdown).toContain("서울特別市");
    expect(result.markdown).toContain("대한민국의 수도이다");
  });

  const adapterLeakHtml = `<!DOCTYPE html>
    <html lang="ja"><head><title>記事タイトル</title></head>
    <body>
      <div class="znc">
        <style>.znc .info-box{border:1px solid #a2a9b1}</style>
        <p>日本語は日本国内や日本人同士の間で使用されている言語である。</p>
        <h2 id="特徴">特徴</h2>
        <p>${"日本語の音韻的特徴について説明する文章です。".repeat(5)}</p>
      </div>
    </body></html>`;

  it("アダプタ経路(Readability非経由)でもstyleを除去する", () => {
    const result = extractMarkdown(adapterLeakHtml, { url: "https://zenn.dev/someone/articles/abc123" });
    expect(result.adapterName).toBe("zenn");
    expect(result.markdown).not.toContain("info-box");
    expect(result.markdown).not.toContain("border:1px");
    expect(result.markdown).toContain("日本語は日本国内や日本人同士の間で使用されている言語である");
  });

  it("script/noscriptも同様に除去する", () => {
    const html = `<!DOCTYPE html><html><body><article><h1>見出し</h1>
      <script>trackPageView();</script>
      <noscript>JavaScriptを有効にしてください</noscript>
      <p>${"本文の段落です。".repeat(20)}</p>
    </article></body></html>`;
    const result = extractMarkdown(html, { url: "https://example.com/article" });
    expect(result.markdown).not.toContain("trackPageView");
    expect(result.markdown).not.toContain("JavaScriptを有効にしてください");
  });

  it("adapter経路に残るnoscriptテキストも除去する(Readability非経由)", () => {
    const html = `<!DOCTYPE html>
      <html lang="ja"><head><title>記事タイトル</title></head>
      <body>
        <div class="znc">
          <noscript>JavaScriptを有効にしてください</noscript>
          <p>日本語は日本国内や日本人同士の間で使用されている言語である。</p>
          <h2 id="特徴">特徴</h2>
          <p>${"日本語の音韻的特徴について説明する文章です。".repeat(5)}</p>
        </div>
      </body></html>`;
    const result = extractMarkdown(html, { url: "https://zenn.dev/someone/articles/abc123" });
    expect(result.adapterName).toBe("zenn");
    expect(result.markdown).not.toContain("JavaScriptを有効にしてください");
  });

  // 【最優先の回帰テスト】noscriptを抽出処理より前に除去すると、Readability.parse()内の
  // _unwrapNoscriptImages(遅延読み込みプレースホルダimgをnoscript内の実画像へ差し替える処理)が
  // 機能する前に対象が消え、劣化したプレースホルダ画像しか残らなくなる。noscriptの除去は
  // Readability.parse()実行後(turndown直前の最終段)まで遅らせる必要がある。
  it("Readability経路: 遅延読み込みプレースホルダをnoscript内の実画像URLへ差し替える(Readability本来の機能を壊さない)", () => {
    const html = `<!DOCTYPE html><html><body><article><h1>見出し</h1>
      <p>${"本文の段落です。".repeat(15)}</p>
      <img src="placeholder.gif"><noscript><img src="https://example.com/real-photo.jpg"></noscript>
      <p>${"続きの本文です。".repeat(15)}</p>
    </article></body></html>`;
    const result = extractMarkdown(html, { url: "https://example.com/article" });
    expect(result.extractionMethod).toBe("readability");
    expect(result.markdown).toContain("real-photo.jpg");
    expect(result.markdown).not.toContain("placeholder.gif");
    expect(result.markdown).not.toContain("<noscript");
  });

  // Readability.parse()は結果を使わない場合(body-fallback採用時)でも、渡されたdocumentへ
  // 常に破壊的に適用される。そのため画像復元はbody-fallback/geometry経路でも同様に効く。
  it("body-fallback経路でもReadability.parse()の画像復元が先に効く(常にparse()が呼ばれるため)", () => {
    const html = `<!DOCTYPE html><html><body>
      <div>短い。</div>
      <img src="placeholder.gif"><noscript><img src="https://example.com/real-photo.jpg"></noscript>
    </body></html>`;
    const result = extractMarkdown(html, { url: "https://example.com/old-site" });
    expect(result.extractionMethod).toBe("body-fallback");
    expect(result.markdown).toContain("real-photo.jpg");
    expect(result.markdown).not.toContain("placeholder.gif");
  });

  // Readability自体が_prepDocumentで<style>をpre/code文脈を問わず無条件除去するため(サードパーティ
  // 挙動でありこの修正のスコープ外)、selector経路(Readability非経由)でこの保護を検証する。
  it("pre/code内に実要素として置かれたCSS/JSコード例は本文として保持する", () => {
    const html = `<!DOCTYPE html><html><body>
      <pre><style>.example{color:red}</style></pre>
    </body></html>`;
    const result = extractMarkdown(html, { url: "https://example.com/article", selector: "pre" });
    expect(result.markdown).toContain(".example{color:red}");
  });

  // 実測(zh.wikipedia.org/广东省)で発覚した副作用の回帰テスト: collectDataTablesはReadability解析
  // 前のouterHTMLからシグネチャを作るため、styleが残ったままだとReadability出力側(style除去済み)
  // とシグネチャが一致せず「表が見つからない」と誤判定し、同じ表を重複挿入していた。
  it("表セル内にstyleがあっても表を重複挿入しない", () => {
    const html = `<!DOCTYPE html><html><body><article><h1>広東省</h1>
      <p>${"広東省は中華人民共和国の省の一つである。".repeat(6)}</p>
      <table><tr><th>坐標</th></tr><tr><td><style>.geo-default{display:inline}</style>23.4°N 113.5°E</td></tr></table>
      <p>${"広東省の概要について続けて説明する文章です。".repeat(6)}</p>
    </article></body></html>`;
    const result = extractMarkdown(html, { url: "https://zh.wikipedia.org/wiki/广东省" });
    expect(result.markdown).not.toContain("display:inline");
    expect(result.markdown.match(/23\.4°N 113\.5°E/g)?.length).toBe(1);
  });
});

describe("extractMarkdown - Readability経路のノイズ除去", () => {
  // 専用アダプタ撤去に伴い「編集リンク・navbox除去」をアダプタ設定へ頼らず、readability経路の
  // 汎用ヒューリスティック(pruning/Readabilityのリンク密度判定)で落ちることを固定する。
  // 実物同様に多数の<a>を含むリンク密度の高いnavbox風リンク集が本文へ混入しないことをロックする。
  it("リンク密度の高いnavbox風リンク集が本文へ混入しない", () => {
    const para = "本文の段落です。読者に必要な情報を十分な分量で提供し、Readabilityが本文と判定できるだけの文字数を確保します。具体例や背景説明も交えて丁寧に述べます。";
    const links = Array.from({ length: 40 }, (_, i) => `<li><a href="/related/${i}">関連項目リンク番号${i}</a></li>`).join("");
    const navbox = `<div class="navbox"><ul>${links}</ul></div>`;
    const html = `<!DOCTYPE html><html lang="ja"><head><title>本文の記事タイトル</title></head><body>
      <article>
        <h2>本編の見出し</h2>
        <p>${para}</p><p>${para}</p><p>${para}</p>
        ${navbox}
      </article></body></html>`;
    const result = extractMarkdown(html, { url: "https://example.com/article" });
    expect(result.extractionMethod).toBe("readability");
    // 本編は残る。
    expect(result.markdown).toContain("本編の見出し");
    // リンク密度の高いリンク集は本文へ混入しない。
    expect(result.markdown).not.toContain("関連項目リンク番号");
    expect(result.markdown).not.toContain("/related/");
  });
});
