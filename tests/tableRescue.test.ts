import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { collectDataTables, normalizeTableHtml, reinsertDroppedTables, type DroppedTable } from "../src/extract/markdown.js";

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
