import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { appendDroppedTables, collectDataTables } from "../src/extract/markdown.js";

type TableQueryHost = Parameters<typeof collectDataTables>[0];

function body(html: string): TableQueryHost {
  return parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`).document.body as unknown as TableQueryHost;
}

describe("collectDataTables", () => {
  it("2行2列以上のデータ表をouterHTMLで採取する", () => {
    const tables = collectDataTables(
      body("<table><tr><th>国</th><th>人口</th></tr><tr><td>日本</td><td>1.2億</td></tr></table>"),
    );
    expect(tables).toHaveLength(1);
    expect(tables[0]).toContain("人口");
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
    expect(tables[0]).toContain("外1");
  });
});

describe("appendDroppedTables", () => {
  const table = "<table><tr><th>国</th><th>人口</th></tr><tr><td>日本</td><td>1.2億</td></tr></table>";

  it("本文に含まれない表は末尾へ再結合する", () => {
    const result = appendDroppedTables("<p>本文だけ。</p>", [table]);
    expect(result.appended).toBe(1);
    expect(result.html).toContain("人口");
  });

  it("シグネチャが本文に既にある表はスキップ(重複させない)", () => {
    const result = appendDroppedTables(`<div>${table}</div>`, [table]);
    expect(result.appended).toBe(0);
    expect(result.html).toBe(`<div>${table}</div>`);
  });

  it("空リストは本文を変えない", () => {
    const result = appendDroppedTables("<p>x</p>", []);
    expect(result.appended).toBe(0);
    expect(result.html).toBe("<p>x</p>");
  });
});
