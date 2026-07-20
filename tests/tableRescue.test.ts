import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  collectDataTables,
  normalizeRetainedTables,
  normalizeTableHtml,
  reinsertDroppedTables,
  type DroppedTable,
} from "../src/extract/markdown.js";

type TableQueryHost = Parameters<typeof collectDataTables>[0];

function body(html: string): TableQueryHost {
  return parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`).document.body as unknown as TableQueryHost;
}

const DATA_TABLE = "<table><tr><th>国</th><th>人口</th></tr><tr><td>日本</td><td>1.2億</td></tr></table>";

describe("collectDataTables", () => {
  it("2行2列以上のデータ表をouterHTMLで採取する", () => {
    const tables = collectDataTables(body(DATA_TABLE));
    expect(tables).toHaveLength(1);
    expect(tables[0]?.html).toContain("人口");
  });

  it("1列の表(リスト相当)は採取しない", () => {
    const tables = collectDataTables(body("<table><tr><td>項目A</td></tr><tr><td>項目B</td></tr></table>"));
    expect(tables).toHaveLength(0);
  });

  it("1行だけの表は採取しない", () => {
    const tables = collectDataTables(body("<table><tr><td>A</td><td>B</td></tr></table>"));
    expect(tables).toHaveLength(0);
  });

  it("入れ子の表は最外表のみ採取する(二重採取しない)", () => {
    const tables = collectDataTables(
      body(
        "<table><tr><th>外1</th><th>外2</th></tr><tr><td><table><tr><th>内1</th><th>内2</th></tr><tr><td>x</td><td>y</td></tr></table></td><td>z</td></tr></table>",
      ),
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]?.html).toContain("外1");
  });

  it("表の直前見出しをアンカーとして採取する(位置復元用)", () => {
    const tables = collectDataTables(body(`<h2>各国の人口</h2><p>説明文。</p>${DATA_TABLE}`));
    expect(tables[0]?.anchor).toBe("各国の人口");
  });

  it("見出しが無ければ直前の十分長い段落をアンカーにする", () => {
    const tables = collectDataTables(
      body(`<p>これは三十文字を確実に超える十分な長さの直前段落テキストで、アンカーとして使えます。</p>${DATA_TABLE}`),
    );
    expect(tables[0]?.anchor).toContain("十分な長さの直前段落");
  });
});

describe("normalizeTableHtml", () => {
  it("rowspanセルを下の行へ展開する", () => {
    const normalized = normalizeTableHtml(
      "<table><tr><th>地域</th><th>値</th></tr><tr><td rowspan='2'>アジア</td><td>1</td></tr><tr><td>2</td></tr></table>",
    );
    // アジアが2行目・3行目の両方に現れる(rowspan展開)。
    expect(normalized.match(/アジア/g)?.length).toBe(2);
    expect(normalized).not.toContain("rowspan");
  });

  it("colspanセルを右の列へ展開する", () => {
    const normalized = normalizeTableHtml(
      "<table><tr><th colspan='2'>合計</th></tr><tr><td>a</td><td>b</td></tr></table>",
    );
    expect(normalized.match(/合計/g)?.length).toBe(2);
    expect(normalized).not.toContain("colspan");
  });

  it("多段ヘッダを1行へ結合する(親ヘッダ+サブヘッダ)", () => {
    const normalized = normalizeTableHtml(
      "<table>" +
        "<tr><th>国</th><th colspan='2'>最新版</th></tr>" +
        "<tr><th>国</th><th>版</th><th>日付</th></tr>" +
        "<tr><td>X</td><td>1.0</td><td>2026</td></tr>" +
        "</table>",
    );
    // ヘッダ行は1行に畳まれ、親「最新版」とサブ「版」「日付」が列ごとに結合される。
    expect(normalized).toContain("<th>最新版 版</th>");
    expect(normalized).toContain("<th>最新版 日付</th>");
    // 重複する「国」は縦方向で重複除去され1つになる。
    expect(normalized).toContain("<th>国</th>");
  });

  it("span無し単純表は構造を保つ(データ行も残る)", () => {
    const normalized = normalizeTableHtml(DATA_TABLE);
    expect(normalized).toContain("人口");
    expect(normalized).toContain("日本");
    expect(normalized).toContain("1.2億");
  });

  it("全行がヘッダ(全セルth)の表を1行へ潰さず全行を残す", () => {
    const allTh =
      "<table><tr><th>名前</th><th>役割</th></tr><tr><th>Alice</th><th>PM</th></tr>" +
      "<tr><th>Bob</th><th>Dev</th></tr></table>";
    const normalized = normalizeTableHtml(allTh);
    // 多段ヘッダ結合(データ行が消える)は起きず、各行のセルがそのまま残る。
    for (const cell of ["名前", "役割", "Alice", "PM", "Bob", "Dev"]) {
      expect(normalized).toContain(cell);
    }
    // "名前 Alice Bob" のような縦結合が起きていない。
    expect(normalized).not.toContain("名前 Alice");
  });

  it("captionを再構築後の表の先頭へ復元する", () => {
    const normalized = normalizeTableHtml(
      "<table><caption>2024年度売上</caption>" +
        "<tr><th rowspan='2'>地域</th><th colspan='2'>売上</th></tr>" +
        "<tr><th>上期</th><th>下期</th></tr><tr><td>東</td><td>10</td><td>20</td></tr></table>",
    );
    expect(normalized).toContain("<caption>2024年度売上</caption>");
    expect(normalized.indexOf("<caption>")).toBeLessThan(normalized.indexOf("<tr>"));
  });

  it("レイアウト目的のcolspan(データ行)はセルへ複製する(救出経路の既存挙動と同一・許容)", () => {
    // 多段ヘッダ結合が横方向の複製に依存するため、データ行のcolspanも同じ規則で複製する。
    // 情報欠落ではなく重複に留まり列ズレは生じない、という現行仕様を固定する。
    const normalized = normalizeTableHtml(
      "<table><tr><th>項目</th><th>値</th></tr><tr><td colspan='2'>お知らせ</td></tr>" +
        "<tr><td>価格</td><td>500円</td></tr></table>",
    );
    expect(normalized.match(/お知らせ/g)?.length).toBe(2);
  });
});

describe("reinsertDroppedTables", () => {
  const table: DroppedTable = { html: DATA_TABLE, signature: "国 人口 日本 1.2億", anchor: "各国の人口" };

  it("アンカー見出しがReadability出力に残っていれば、その直後へ挿入する", () => {
    const content = "<h2>各国の人口</h2><p>説明文。</p><h2>次の節</h2><p>別の話。</p>";
    const result = reinsertDroppedTables(content, [table]);
    expect(result.appended).toBe(1);
    // 表がアンカー見出しの直後・「次の節」より前に入る(位置復元)。
    const idxTable = result.html.indexOf("人口</th>");
    const idxNext = result.html.indexOf("次の節");
    expect(idxTable).toBeGreaterThan(-1);
    expect(idxTable).toBeLessThan(idxNext);
  });

  it("アンカーが出力に無ければ末尾へフォールバックする", () => {
    const content = "<p>アンカーに一致しない本文だけ。</p>";
    const result = reinsertDroppedTables(content, [table]);
    expect(result.appended).toBe(1);
    expect(result.html.indexOf("人口")).toBeGreaterThan(result.html.indexOf("本文だけ"));
  });

  it("シグネチャが本文に既にある表はスキップ(重複させない)", () => {
    const result = reinsertDroppedTables(`<div>${DATA_TABLE}</div>`, [table]);
    expect(result.appended).toBe(0);
    expect(result.html).toBe(`<div>${DATA_TABLE}</div>`);
  });

  it("空リストは本文を変えない", () => {
    const result = reinsertDroppedTables("<p>x</p>", []);
    expect(result.appended).toBe(0);
    expect(result.html).toBe("<p>x</p>");
  });
});

describe("collectDataTables signature", () => {
  // signatureはouterHTML基準(タグ→空白)なので、ソースのセル間空白の有無に依らず
  // reinsertDroppedTablesのcontentHtml側照合と一致し、重複挿入を起こさない。
  it("セル間に空白の無い複雑表でも、その表がcontentに在れば救出をスキップする(重複させない)", () => {
    const inline =
      "<table><tr><th rowspan='2'>地域</th><th colspan='2'>人口</th></tr>" +
      "<tr><th>男</th><th>女</th></tr><tr><td>東</td><td>1</td><td>2</td></tr></table>";
    const [dropped] = collectDataTables(body(`<h2>統計</h2>${inline}`));
    const result = reinsertDroppedTables(`<div><h2>統計</h2>${inline}</div>`, [dropped!]);
    expect(result.appended).toBe(0);
  });
});

describe("normalizeRetainedTables", () => {
  const COMPLEX =
    "<table><tr><th rowspan='2'>地域</th><th colspan='2'>人口</th></tr>" +
    "<tr><th>男</th><th>女</th></tr><tr><td>東</td><td>1</td><td>2</td></tr></table>";

  it("colspan/rowspan・多段ヘッダを持つ複雑表を正規化する", () => {
    const out = normalizeRetainedTables(`<p>説明</p>${COMPLEX}`);
    expect(out).not.toContain("colspan");
    expect(out).not.toContain("rowspan");
    expect(out).toContain("<th>人口 男</th>");
    expect(out).toContain("<th>人口 女</th>");
  });

  it("2回適用しても結果が変わらない(冪等)", () => {
    const once = normalizeRetainedTables(`<p>説明</p>${COMPLEX}`);
    expect(normalizeRetainedTables(once)).toBe(once);
  });

  it("救出経路で正規化済み(normalizeTableHtml出力)の表を通しても壊さない", () => {
    const normalized = normalizeTableHtml(COMPLEX);
    const html = `<div>${normalized}</div>`;
    expect(normalizeRetainedTables(html)).toBe(html);
  });

  it("span無し単純表は変更しない(差分最小・turndownに委ねる)", () => {
    const html = `<div>${DATA_TABLE}</div>`;
    expect(normalizeRetainedTables(html)).toBe(html);
  });

  it("span無しの全ヘッダ表(スタイル目的のth)は対象外で素通しする", () => {
    // 全行thの表を多段ヘッダとして畳むとデータ行が消えるため、正規化対象から除外する。
    const allTh =
      "<table><tr><th>名前</th><th>役割</th></tr><tr><th>Alice</th><th>PM</th></tr>" +
      "<tr><th>Bob</th><th>Dev</th></tr></table>";
    expect(normalizeRetainedTables(allTh)).toBe(allTh);
  });

  it("レイアウト目的の1列表・1行表は触らない", () => {
    const oneCol = "<table><tr><td>メニューA</td></tr><tr><td>メニューB</td></tr></table>";
    expect(normalizeRetainedTables(oneCol)).toBe(oneCol);
    const oneRow = "<table><tr><td>A</td><td>B</td></tr></table>";
    expect(normalizeRetainedTables(oneRow)).toBe(oneRow);
  });

  it("表を含まない本文はそのまま返す", () => {
    expect(normalizeRetainedTables("<p>本文のみ</p>")).toBe("<p>本文のみ</p>");
  });

  it("入れ子表は最外表として1回だけ正規化する(内側は二重処理しない)", () => {
    const nested =
      "<table><tr><th colspan='2'>外</th></tr>" +
      "<tr><td>a</td><td><table><tr><th colspan='2'>内</th></tr><tr><td>x</td><td>y</td></tr></table></td></tr></table>";
    const out = normalizeRetainedTables(nested);
    // 外表のcolspanは展開され「外」が2列に並ぶ。内表はセル内にそのまま保持される。
    expect(out.match(/外/g)?.length).toBe(2);
    expect(out).toContain("内");
  });
});
