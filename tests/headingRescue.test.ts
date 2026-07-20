import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  collectDataTables,
  collectHeadings,
  extractMarkdown,
  reinsertDroppedHeadings,
  reinsertDroppedTables,
  type DroppedHeading,
} from "../src/extract/markdown.js";
import { buildOutline } from "../src/extract/outline.js";

type HeadingQueryHost = Parameters<typeof collectHeadings>[0];
type TableQueryHost = Parameters<typeof collectDataTables>[0];

function body(html: string): HeadingQueryHost {
  return parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`).document.body as unknown as HeadingQueryHost;
}

const LONG_PARAGRAPH = "これは三十文字を確実に超える十分な長さの段落テキストで、見出しのアンカーとして採用されます。";

describe("collectHeadings", () => {
  it("h2-h6を採取しh1は対象外にする(titleと二重化するため)", () => {
    const heads = collectHeadings(body(`<h1>記事タイトル</h1><h2>概要</h2><p>${LONG_PARAGRAPH}</p><h3>詳細</h3><p>${LONG_PARAGRAPH}</p>`));
    expect(heads.map((h) => h.text)).toEqual(["概要", "詳細"]);
    expect(heads.map((h) => h.level)).toEqual([2, 3]);
  });

  it("テキストが空の見出しは採取しない", () => {
    const heads = collectHeadings(body(`<h2></h2><h2>   </h2><h2>本物の見出し</h2><p>${LONG_PARAGRAPH}</p>`));
    expect(heads.map((h) => h.text)).toEqual(["本物の見出し"]);
  });

  it("見出し直後の短い段落は飛ばし、最初の十分長い段落をアンカーにする", () => {
    const heads = collectHeadings(body(`<h2>節</h2><p>短い</p><p>${LONG_PARAGRAPH}</p>`));
    expect(heads[0]?.anchors[0]).toEqual({ text: LONG_PARAGRAPH, kind: "paragraph" });
  });

  it("次の見出しまでに十分長い段落が無ければアンカーは空(復元不能)", () => {
    const heads = collectHeadings(body(`<h2>節A</h2><p>短い</p><h2>節B</h2><p>${LONG_PARAGRAPH}</p>`));
    expect(heads.find((h) => h.text === "節A")?.anchors).toEqual([]);
    expect(heads.find((h) => h.text === "節B")?.anchors[0]?.text).toBe(LONG_PARAGRAPH);
  });

  it("アンカーは先頭80字(ANCHOR_MAX_LENGTH)へ切り詰める", () => {
    const heads = collectHeadings(body(`<h2>節</h2><p>${"あ".repeat(100)}</p>`));
    expect(heads[0]?.anchors[0]?.text).toHaveLength(80);
  });

  it("子見出しを跨いで親見出しのアンカーを採取する(階層スコープ)", () => {
    // 親h2の直後に子h3が続く構造。子見出し(数値が大きい)は跨ぎ、親自身の段落までスコープを延ばす。
    const heads = collectHeadings(body(`<h2>親節</h2><h3>子節</h3><p>${LONG_PARAGRAPH}</p>`));
    expect(heads.find((h) => h.text === "親節")?.anchors[0]?.text).toBe(LONG_PARAGRAPH);
    expect(heads.find((h) => h.text === "子節")?.anchors[0]?.text).toBe(LONG_PARAGRAPH);
  });

  it("同レベル以下の見出しに達したらスコープを打ち切る(兄弟節の段落は拾わない)", () => {
    const heads = collectHeadings(body(`<h2>節A</h2><p>短い</p><h2>節B</h2><p>${LONG_PARAGRAPH}</p>`));
    // 節Aのスコープは同レベルの節Bで終端。間に十分長い段落が無いのでアンカーは空。
    expect(heads.find((h) => h.text === "節A")?.anchors).toEqual([]);
    expect(heads.find((h) => h.text === "節B")?.anchors[0]?.text).toBe(LONG_PARAGRAPH);
  });

  it("段落の無い表のみの節は表の先頭をブロックアンカーにする", () => {
    const table =
      "<table><tr><th>方角</th><th>接する対象</th></tr>" +
      "<tr><td>東</td><td>隣接する河川の東岸地域</td></tr><tr><td>西</td><td>隣接する山地の西側斜面</td></tr></table>";
    const heads = collectHeadings(body(`<h2>四至</h2>${table}`));
    // 段落が無いので表(正規化テキスト30字以上)の先頭をアンカーにする。
    expect(heads[0]?.anchors[0]?.kind).toBe("block");
    expect(heads[0]?.anchors[0]?.text).toContain("方角");
    expect(heads[0]?.anchors[0]?.text).toContain("隣接する河川");
  });

  it("アンカー候補は文書順(ブロック→最初の段落まで)に複数持つ", () => {
    const notice = "<ul><li>この図表は技術的な理由により旧版のため停用されており移行が必要です</li></ul>";
    const table =
      "<table><tr><th>年度</th><th>調査人口</th></tr>" +
      "<tr><td>2020</td><td>該当年度の調査人口の合計値</td></tr><tr><td>2021</td><td>翌年度の調査人口の合計値</td></tr></table>";
    const paragraph = "節の本文となる十分に長い段落テキストがこの位置に置かれている。";
    const heads = collectHeadings(body(`<h2>人口</h2>${notice}${table}<p>${paragraph}</p>`));
    const kinds = heads[0]?.anchors.map((a) => a.kind);
    // ノイズ通知(リスト)→データ表→最初の段落、の文書順。段落が入ったら打ち切り。
    expect(kinds).toEqual(["block", "block", "paragraph"]);
  });
});

describe("reinsertDroppedHeadings", () => {
  it("先頭候補(消失ブロック)が本文に無ければ、次候補の表の直前へ挿入する", () => {
    const heading: DroppedHeading = {
      level: 2,
      text: "人口",
      anchors: [
        { text: "この図表は技術的な理由により旧版のため停用されており移行が必要です", kind: "block" },
        { text: "年度 調査人口 2020 該当年度の調査人口の合計値", kind: "block" },
        { text: "節の本文となる十分に長い段落テキストがこの位置に置かれている。", kind: "paragraph" },
      ],
    };
    // 通知ブロックはReadabilityに落とされて本文に無い。表と段落は残っている。
    const content =
      "<table><tr><th>年度</th><th>調査人口</th></tr><tr><td>2020</td><td>該当年度の調査人口の合計値</td></tr></table>" +
      "<p>節の本文となる十分に長い段落テキストがこの位置に置かれている。</p>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.restored).toBe(1);
    // 見出しは(段落ではなく)第二候補である表の直前に立つ=表が節へ帰属する。
    expect(result.html.indexOf("<h2>人口</h2>")).toBeGreaterThan(-1);
    expect(result.html.indexOf("<h2>人口</h2>")).toBeLessThan(result.html.indexOf("<table"));
  });


  it("アンカーが本文に残っていれば段落の直前へ挿入しレベルを保つ", () => {
    const heading: DroppedHeading = { level: 3, text: "歴史", anchors: [{ text: "この節の最初の段落テキスト", kind: "paragraph" }] };
    const content = "<p>この節の最初の段落テキストがここにある。</p>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.restored).toBe(1);
    expect(result.html).toContain("<h3>歴史</h3>");
    // beforebegin挿入: 見出しは段落より前に来る。
    expect(result.html.indexOf("<h3>歴史")).toBeLessThan(result.html.indexOf("この節の最初"));
  });

  it("既に本文に同テキストの見出しがある場合は挿入しない(重複させない)", () => {
    const heading: DroppedHeading = { level: 2, text: "概要", anchors: [{ text: "概要節の段落テキスト内容", kind: "paragraph" }] };
    const content = "<h2>概要</h2><p>概要節の段落テキスト内容がある。</p>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.restored).toBe(0);
    expect(result.html).toBe(content);
  });

  it("アンカーが本文に無ければ復元しない(末尾フォールバックもしない)", () => {
    const heading: DroppedHeading = { level: 2, text: "歴史", anchors: [{ text: "本文に存在しないアンカーテキスト", kind: "paragraph" }] };
    const content = "<p>まったく無関係な本文だけがある。</p>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.restored).toBe(0);
    expect(result.html).toBe(content);
    expect(result.html).not.toContain("歴史");
  });

  it("アンカーが空の見出しは、テキストが地の文に一致しても復元しない", () => {
    const heading: DroppedHeading = { level: 2, text: "謝辞", anchors: [] };
    const content = "<p>謝辞という語が地の文に出てくるが、節本文が残っていないため復元はしない。</p>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.restored).toBe(0);
    expect(result.html).toBe(content);
  });

  it("同一テキストの見出しは最初の1件のみ扱う(アンカー取り違えを避ける)", () => {
    const headings: DroppedHeading[] = [
      { level: 2, text: "脚注", anchors: [{ text: "最初の脚注節の段落テキスト内容", kind: "paragraph" }] },
      { level: 2, text: "脚注", anchors: [{ text: "二番目の脚注節の段落テキスト内容", kind: "paragraph" }] },
    ];
    const content = "<p>最初の脚注節の段落テキスト内容がある。</p><p>二番目の脚注節の段落テキスト内容がある。</p>";
    const result = reinsertDroppedHeadings(content, headings);
    expect(result.restored).toBe(1);
    expect(result.html.match(/<h2>脚注<\/h2>/g)).toHaveLength(1);
  });

  it("見出しテキストのHTML特殊文字をエスケープして挿入する", () => {
    const heading: DroppedHeading = { level: 2, text: "研究 & 開発", anchors: [{ text: "研究開発節の段落テキスト内容がここ", kind: "paragraph" }] };
    const content = "<p>研究開発節の段落テキスト内容がここにある。</p>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.html).toContain("<h2>研究 &amp; 開発</h2>");
  });

  it("空リストは本文を変えない", () => {
    const result = reinsertDroppedHeadings("<p>x</p>", []);
    expect(result.restored).toBe(0);
    expect(result.html).toBe("<p>x</p>");
  });

  it("2回適用しても見出しが増えない(冪等)", () => {
    const heading: DroppedHeading = { level: 2, text: "概要", anchors: [{ text: "概要節の最初の段落テキスト内容", kind: "paragraph" }] };
    const content = "<p>概要節の最初の段落テキスト内容がある。</p>";
    const first = reinsertDroppedHeadings(content, [heading]);
    expect(first.restored).toBe(1);
    const second = reinsertDroppedHeadings(first.html, [heading]);
    expect(second.restored).toBe(0);
    expect(second.html).toBe(first.html);
  });

  it("同一アンカーを持つ親子見出しはdocument順の復元で親→子に並ぶ", () => {
    const anchor = "親子で共有される節の最初の段落テキスト内容";
    const headings: DroppedHeading[] = [
      { level: 2, text: "親節", anchors: [{ text: anchor, kind: "paragraph" }] },
      { level: 3, text: "子節", anchors: [{ text: anchor, kind: "paragraph" }] },
    ];
    const content = `<p>${anchor}がここにある。</p>`;
    const result = reinsertDroppedHeadings(content, headings);
    expect(result.restored).toBe(2);
    // 同じ段落の直前へdocument順(親→子)に挿入されるので、親h2→子h3→段落の並びになる。
    expect(result.html.indexOf("親節")).toBeLessThan(result.html.indexOf("子節"));
    expect(result.html.indexOf("子節")).toBeLessThan(result.html.indexOf("がここにある"));
  });

  it("block由来アンカーは空白がズレた正規化表(セル間空白なし)にも照合できる", () => {
    // 採取時のanchorは空白入り(生DOM)、本文側の表はnormalizeTableHtmlでセル間空白なし。
    // block由来のみ両辺の全空白を除去して照合するため命中する。
    const heading: DroppedHeading = { level: 2, text: "統計", anchors: [{ text: "国 人口 日本 一億二千万", kind: "block" }] };
    const content =
      "<table><thead><tr><th>国</th><th>人口</th></tr></thead><tbody><tr><td>日本</td><td>一億二千万</td></tr></tbody></table>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.restored).toBe(1);
    expect(result.html.indexOf("<h2>統計")).toBeLessThan(result.html.indexOf("<table"));
  });

  it("表の内側の段落へは挿入せず、見出しは表の直前へ置く", () => {
    const heading: DroppedHeading = { level: 2, text: "注記", anchors: [{ text: "セル内にある十分に長い段落テキスト内容", kind: "paragraph" }] };
    const content = "<table><tbody><tr><td><p>セル内にある十分に長い段落テキスト内容がここ。</p></td></tr></tbody></table>";
    const result = reinsertDroppedHeadings(content, [heading]);
    expect(result.restored).toBe(1);
    expect(result.html.indexOf("<h2>注記")).toBeLessThan(result.html.indexOf("<table"));
    // 見出しが表の内側(td)へ入り込まない。
    expect(result.html).not.toMatch(/<td[^>]*>\s*<h2/);
  });
});

// 統合: MediaWikiが見出しを`<div class="mw-heading">`+編集リンクで包む構造は、本文量が閾値を
// 超えるとReadabilityがh2-h6を丸ごと落とす(実機同型・計測で確認)。この経路で見出しが復元される
// ことと、見出し→表の順序で表の位置復元が効くことを固定する。
describe("extractMarkdown 見出し救出(Readability経路)", () => {
  const LONG =
    "この節ではテーマを詳しく説明します。読者が背景を理解できるように具体例を交えて丁寧に記述し、Readabilityが確実に本文と判定できるだけの文字数を確保しています。さらに補足事項にも触れます。";
  const wrapHeading = (text: string, level: number): string =>
    `<div class="mw-heading mw-heading${level}"><h${level}>${text}</h${level}><span class="mw-editsection"><a href="/edit">編集</a></span></div>`;
  const url = "https://ja.example.org/wiki/Test";

  it("Readabilityが剥いだラッパー見出しをoutlineへ復元し、階層(レベル)を保つ", () => {
    const html =
      `<!DOCTYPE html><html><head><title>タイトル無関係語</title></head><body><article><div class="mw-parser-output">` +
      `<p>導入部。${LONG}${LONG}</p>` +
      `${wrapHeading("概要", 2)}<p>概要の説明。${LONG}</p>` +
      `${wrapHeading("歴史", 2)}<p>歴史の説明。${LONG}</p>` +
      `${wrapHeading("近代史", 3)}<p>近代史の説明。${LONG}</p>` +
      `</div></article></body></html>`;
    const result = extractMarkdown(html, { url });
    expect(result.extractionMethod).toBe("readability");
    const sections = buildOutline(result.markdown).sections;
    expect(sections.map((s) => [s.level, s.heading])).toEqual([
      [2, "概要"],
      [2, "歴史"],
      [3, "近代史"],
    ]);
  });

  it("見出し→表の順序で、表アンカーが復元見出しにのみ一致するケースでも表が節内へ復元される", () => {
    // 「統計指標」は段落の地の文に含めない。表のアンカー(直前見出し)が復元見出しにしか一致しないため、
    // 見出し復元が表復元より先に走らなければ表は末尾へ落ちる=節内配置は見出し救出の順序に依存する。
    const table =
      "<table><tr><th>国</th><th>数値</th></tr><tr><td>日本</td><td>1.2億</td></tr><tr><td>中国</td><td>14億</td></tr></table>";
    const html =
      `<!DOCTYPE html><html><head><title>タイトル無関係語</title></head><body><article><div class="mw-parser-output">` +
      `<p>導入部。${LONG}${LONG}</p>` +
      `${wrapHeading("概要", 2)}<p>概要の説明。${LONG}</p>` +
      `${wrapHeading("統計指標", 2)}<p>各国の数値を並べる。${LONG}</p>${table}` +
      `${wrapHeading("結論", 2)}<p>結論の説明。${LONG}</p>` +
      `</div></article></body></html>`;
    const md = extractMarkdown(html, { url }).markdown;
    const idxHeading = md.indexOf("統計指標");
    const idxTable = md.search(/\|\s*国/);
    const idxNext = md.indexOf("結論");
    expect(idxHeading).toBeGreaterThan(-1);
    expect(idxTable).toBeGreaterThan(idxHeading);
    expect(idxTable).toBeLessThan(idxNext);
  });
});

// extractMarkdownの実順序(見出し復元→表復元→見出し復元)を実関数で合成し、Readabilityが
// 見出しも表も落としたデータ表のみの節が、表救出後の2回目の見出し復元で拾われることを固定する。
describe("見出し救出の二段実行(救出表をアンカーに持つ見出し)", () => {
  it("落ちて救出で戻ったデータ表を、2回目の見出し復元がアンカーに拾い表の直前へ見出しを立てる", () => {
    const table =
      "<table><tr><th>方角</th><th>接する対象</th></tr>" +
      "<tr><td>東</td><td>隣接する河川の東岸地域</td></tr><tr><td>西</td><td>隣接する山地の西側斜面</td></tr></table>";
    const source = `<h2>四至</h2>${table}`;
    const headings = collectHeadings(body(source));
    const tables = collectDataTables(parseHTML(`<!DOCTYPE html><html><body>${source}</body></html>`).document.body as unknown as TableQueryHost);

    // article.content: 対象節は見出しも表もReadabilityが落としている。
    const content = "<p>別の節の本文だけが残り、対象節は見出しも表も落ちている。</p>";
    const pass1 = reinsertDroppedHeadings(content, headings);
    expect(pass1.restored).toBe(0); // 表(=アンカー)が本文に無いので1回目では復元できない。

    const withTable = reinsertDroppedTables(pass1.html, tables);
    expect(withTable.appended).toBe(1);

    const pass2 = reinsertDroppedHeadings(withTable.html, headings);
    expect(pass2.restored).toBe(1); // 表が戻った後の2回目で復元。
    expect(pass2.html.indexOf("<h2>四至")).toBeLessThan(pass2.html.indexOf("<table"));
  });

  it("短く非一意な見出し(人口)の表は無関係段落へ吸着せず末尾+二段目で節として再構成される", () => {
    // Critical再現(zh.wikipedia 广东省): 表アンカーが短い見出し「人口」。別節「航空」の段落に
    // 「人口」が部分文字列で含まれても、表はそこへ吸着せず末尾へ回り、二段目の見出し復元で
    // 人口見出しが末尾の表の直前へ立つ=人口節が末尾に正しく再構成される。
    const popTable =
      "<table><tr><th>年次</th><th>総人口</th></tr>" +
      "<tr><td>2020年</td><td>一億二千万人規模の値</td></tr><tr><td>2010年</td><td>一億二千八百万規模の値</td></tr></table>";
    const source = `<h2>人口</h2>${popTable}`;
    const headings = collectHeadings(body(source));
    const tables = collectDataTables(parseHTML(`<!DOCTYPE html><html><body>${source}</body></html>`).document.body as unknown as TableQueryHost);

    // article.content: 人口節は見出しも表も落ち、別節に「人口」を部分文字列で含む段落がある。
    const content = "<h2>航空</h2><p>空港が広い人口カバー圏を持つことを説明する十分な長さの本文。</p><h2>参考文献</h2><p>文献一覧。</p>";
    const pass1 = reinsertDroppedHeadings(content, headings);
    expect(pass1.restored).toBe(0);

    const withTable = reinsertDroppedTables(pass1.html, tables);
    expect(withTable.appended).toBe(1);
    // 表は航空節の段落へ吸着せず末尾(参考文献より後)へ回る。
    expect(withTable.html.indexOf("総人口")).toBeGreaterThan(withTable.html.indexOf("参考文献"));

    const pass2 = reinsertDroppedHeadings(withTable.html, headings);
    expect(pass2.restored).toBe(1);
    // 末尾の表の直前へ人口見出しが立つ(人口節の再構成)。
    expect(pass2.html.indexOf("<h2>人口")).toBeLessThan(pass2.html.indexOf("<table"));
  });

  it("表が1つも戻らない(appended=0)ときはcontentが不変で二段目は不要になる", () => {
    // extractMarkdownはappended>0のときだけ二段目の見出し復元を回す。ここではその前提=
    // 救出表が無い(appended=0)ときreinsertDroppedTablesがcontentを変えないことを固定する
    // (一段目で見出しは復元済みなので、二段目を回しても結果は変わらない=一般ページで省ける)。
    const heading: DroppedHeading = { level: 2, text: "概要", anchors: [{ text: "概要節の最初の段落テキスト内容", kind: "paragraph" }] };
    const pass1 = reinsertDroppedHeadings("<p>概要節の最初の段落テキスト内容がある。</p>", [heading]);
    expect(pass1.restored).toBe(1);
    const tableStep = reinsertDroppedTables(pass1.html, []);
    expect(tableStep.appended).toBe(0);
    expect(tableStep.html).toBe(pass1.html);
  });
});
