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
  it("データ行のrowspanセルは起点にのみ内容を置き継続位置は空セルにする(複製しない)", () => {
    const normalized = normalizeTableHtml(
      "<table><tr><th>地域</th><th>値</th></tr><tr><td rowspan='2'>アジア</td><td>1</td></tr><tr><td>2</td></tr></table>",
    );
    // アジアは起点(2行目)に1回だけ。3行目の同じ列は空セルで、位置は占有されるが複製されない。
    expect(normalized.match(/アジア/g)?.length).toBe(1);
    expect(normalized).not.toContain("rowspan");
  });

  it("先頭の全幅単一th行(合計)はcaptionへ畳み複製しない", () => {
    const normalized = normalizeTableHtml(
      "<table><tr><th colspan='2'>合計</th></tr><tr><td>a</td><td>b</td></tr></table>",
    );
    // 単一セル全幅th行は列ヘッダではなく表題とみなしcaptionへ畳む(列ズレ・複製を生まない)。
    expect(normalized.match(/合計/g)?.length).toBe(1);
    expect(normalized).toContain("<caption>合計</caption>");
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

  it("データ行のcolspanセルは起点にのみ内容を置き継続位置は空セルにする(複製しない)", () => {
    // 列ヘッダ行だけがcolspanラベルを各列へ複製する。データ行は起点1回のみで重複を生まない。
    const normalized = normalizeTableHtml(
      "<table><tr><th>項目</th><th>値</th></tr><tr><td colspan='2'>お知らせ</td></tr>" +
        "<tr><td>価格</td><td>500円</td></tr></table>",
    );
    expect(normalized.match(/お知らせ/g)?.length).toBe(1);
    expect(normalized).not.toContain("colspan");
  });

  it("表中間の全幅単一th区切り行は列ヘッダへ結合せずデータ行として内容1回・空セルにする", () => {
    const normalized = normalizeTableHtml(
      "<table><tr><th>字</th><th>音</th></tr>" +
        "<tr><td>あ</td><td>a</td></tr>" +
        "<tr><th colspan='2'>区切り</th></tr>" +
        "<tr><td>い</td><td>i</td></tr></table>",
    );
    // 区切りは1回だけ。列ヘッダ行(字|音)への「字 区切り」的な縦結合は起きない。
    expect(normalized.match(/区切り/g)?.length).toBe(1);
    expect(normalized).not.toContain("colspan");
    expect(normalized).toContain("<thead><tr><th>字</th><th>音</th></tr></thead>");
  });

  it("先頭の全幅単一thラベル行をcaptionへ畳み、後続の列ヘッダ行をヘッダにする", () => {
    const normalized = normalizeTableHtml(
      "<table>" +
        "<tr><th colspan='3'>標音対照表</th></tr>" +
        "<tr><th>字</th><th>拼音</th><th>注音</th></tr>" +
        "<tr><td>阿</td><td>a</td><td>ㄚ</td></tr></table>",
    );
    expect(normalized).toContain("<caption>標音対照表</caption>");
    expect(normalized.match(/標音対照表/g)?.length).toBe(1);
    // 畳んだ後の先頭行が3列の列ヘッダになる(turndown-gfmが複雑表フォールバックへ落ちない)。
    expect(normalized).toContain("<thead><tr><th>字</th><th>拼音</th><th>注音</th></tr></thead>");
  });

  it("列ヘッダ行でない行はtdで出力する(再パース時にall-th行として列ヘッダへ誤認させない)", () => {
    const normalized = normalizeTableHtml(
      "<table><tr><th>字</th><th>音</th></tr><tr><th colspan='2'>声母</th></tr>" +
        "<tr><td>阿</td><td>a</td></tr></table>",
    );
    // 区切り行は<td>声母</td><td></td>になる。<th>のままだと空th兄弟を伴うall-th複数セル行として
    // 実体化し、二重適用時に多段ヘッダ結合へ巻き込まれて区切りラベルが消失する。
    expect(normalized).toContain("<td>声母</td><td></td>");
    expect(normalized).not.toContain("<th>声母</th>");
  });

  it("全行が全幅単一th行の退化表はcaptionへ畳まず全行を保持し、再適用しても不変(冪等)", () => {
    const allLabel = "<table><tr><th colspan='2'>ラベルA</th></tr><tr><th colspan='2'>ラベルB</th></tr></table>";
    const normalized = normalizeTableHtml(allLabel);
    expect(normalized).not.toContain("<caption>");
    expect(normalized).toContain("ラベルA");
    expect(normalized).toContain("ラベルB");
    expect(normalizeTableHtml(normalized)).toBe(normalized);
  });
});

describe("reinsertDroppedTables", () => {
  const table: DroppedTable = { html: DATA_TABLE, probes: ["国 人口 日本 1.2億"], anchor: "各国の人口" };

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

  it("プローブが本文に既にある表はスキップ(重複させない)", () => {
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

describe("reinsertDroppedTables プローブ多数決", () => {
  const LONG_TABLE =
    "<table><tr><th>指標</th><th>値</th></tr>" +
    "<tr><td>国内総生産の年間成長率</td><td>百分率で示した指標</td></tr>" +
    "<tr><td>消費者物価指数の変動幅</td><td>基準年比の割合</td></tr></table>";

  it("プローブの過半数が本文にあれば救出をスキップする(Readabilityが一部セルを刈っても)", () => {
    const [dropped] = collectDataTables(body(`<h2>統計</h2>${LONG_TABLE}`));
    // 3プローブ中2つが本文に残存(「百分率で示した指標」は刈られた想定)。過半数で「既存」と判定。
    const content = "<p>国内総生産の年間成長率について。</p><p>消費者物価指数の変動幅を示す。</p>";
    const result = reinsertDroppedTables(content, [dropped!]);
    expect(result.appended).toBe(0);
  });

  it("過半数のプローブが本文に無ければ救出する", () => {
    const [dropped] = collectDataTables(body(`<h2>統計</h2>${LONG_TABLE}`));
    // 3プローブ中1つしか残っていない → 過半数未満なので落とされた表とみなし再挿入する。
    const content = "<p>国内総生産の年間成長率だけが残る本文。</p>";
    const result = reinsertDroppedTables(content, [dropped!]);
    expect(result.appended).toBe(1);
  });

  it("プローブ2本の表は1本の偶然一致(50%)だけでは既存とみなさず救出する", () => {
    // 真の過半数(floor(n/2)+1)を要求する。n=2で1本一致を既存扱いにすると、地の文との
    // 偶然一致1本で本当に落ちた表がサイレント欠落する方向へ倒れるため。
    const twoProbe =
      "<table><tr><th>項目</th><th>値</th></tr>" +
      "<tr><td>八文字以上ある一つ目の項目</td><td>八文字以上ある二つ目の項目</td></tr></table>";
    const [dropped] = collectDataTables(body(twoProbe));
    expect(dropped?.probes).toHaveLength(2);
    const result = reinsertDroppedTables("<p>八文字以上ある一つ目の項目という語句だけが本文にある。</p>", [dropped!]);
    expect(result.appended).toBe(1);
  });
});

describe("救出→再結合→normalizeRetainedTablesの二重適用(実経路の冪等性)", () => {
  // collectDataTablesが正規化した表はreinsertDroppedTablesで本文へ挿入された後、
  // extractMarkdownの全経路共通パス(normalizeRetainedTables)をもう一度通る。
  // この二重適用で区切り行ラベルがヘッダへ結合・消失しないことを固定する(レビュー検出のCritical)。
  it("区切り行入りの表を救出挿入後にnormalizeRetainedTablesへ通してもラベルが消えない", () => {
    const table =
      "<table><tr><th>字</th><th>音</th></tr><tr><th colspan='2'>声母</th></tr>" +
      "<tr><td>阿</td><td>a</td></tr></table>";
    const [dropped] = collectDataTables(body(`<h2>標音</h2>${table}`));
    const { html, appended } = reinsertDroppedTables("<h2>標音</h2><p>本文。</p>", [dropped!]);
    expect(appended).toBe(1);
    const out = normalizeRetainedTables(html);
    expect(out.match(/声母/g)?.length).toBe(1);
    expect(out).toContain("<thead><tr><th>字</th><th>音</th></tr></thead>");
    // 声母は独立したデータ行として残る(ヘッダへの「字 声母」的な結合が起きない)。
    expect(out).toContain("<td>声母</td>");
  });
});

describe("collectDataTables probes", () => {
  it("長さ8字以上のセルを長い順に最大3本、プローブとして採取する", () => {
    const [dropped] = collectDataTables(
      body(
        "<table><tr><th>a</th><th>bb</th></tr>" +
          "<tr><td>八文字以上ある一つ目の項目</td><td>八文字以上ある二つ目の項目</td></tr>" +
          "<tr><td>八文字以上ある三つ目の項目</td><td>短い</td></tr></table>",
      ),
    );
    // 短いセル(a/bb/短い)は除外され、長い8字以上のセルだけがプローブになる。
    expect(dropped?.probes).toHaveLength(3);
    for (const probe of dropped!.probes) expect(probe.length).toBeGreaterThanOrEqual(8);
  });

  // フォールバック: 全セルが短く8字以上のプローブが作れない表は従来のouterHTML先頭を単一プローブに使う。
  it("セル間に空白の無い複雑表でも、その表がcontentに在れば救出をスキップする(重複させない)", () => {
    const inline =
      "<table><tr><th rowspan='2'>地域</th><th colspan='2'>人口</th></tr>" +
      "<tr><th>男</th><th>女</th></tr><tr><td>東</td><td>1</td><td>2</td></tr></table>";
    const [dropped] = collectDataTables(body(`<h2>統計</h2>${inline}`));
    expect(dropped?.probes).toHaveLength(1); // 全セル短文 → outerHTMLフォールバック。
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

  it("入れ子表は最外表として1回だけ正規化する(内側は二重処理せず複製もしない)", () => {
    const nested =
      "<table><tr><th colspan='2'>外</th></tr>" +
      "<tr><td>a</td><td><table><tr><th colspan='2'>内</th></tr><tr><td>x</td><td>y</td></tr></table></td></tr></table>";
    const out = normalizeRetainedTables(nested);
    // 外表の全幅単一th行はcaptionへ畳まれ「外」は1回だけ。内表はセル内にそのまま保持される。
    expect(out.match(/外/g)?.length).toBe(1);
    expect(out).toContain("<caption>外</caption>");
    expect(out).toContain("内");
  });
});
