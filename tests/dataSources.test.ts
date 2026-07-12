import { describe, expect, it } from "vitest";
import { detectDataSources } from "../src/extract/dataSources.js";

describe("機能C: detectDataSources - 検出なし", () => {
  it("構造化データっぽいリンクが無ければ空配列を返す(トークン増ゼロ)", () => {
    const html = `<html><body><a href="/about">会社概要</a><a href="/contact">お問い合わせ</a></body></html>`;
    expect(detectDataSources(html, "https://example.jp/")).toEqual([]);
  });
});

describe("機能C: detectDataSources - 検出あり", () => {
  it("拡張子一致(.csv)のリンクを検出する", () => {
    const html = `<html><body><a href="/data/r5.csv">令和5年度データ</a></body></html>`;
    const hints = detectDataSources(html, "https://example.jp/");
    expect(hints).toEqual(["- 令和5年度データ — https://example.jp/data/r5.csv"]);
  });

  it("同一ドメイン内の「オープンデータ」語彙一致は検出する", () => {
    const html = `<html><body><a href="/opendata/">オープンデータ一覧</a></body></html>`;
    const hints = detectDataSources(html, "https://example.jp/");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("オープンデータ一覧");
  });

  it("「一括ダウンロード」の語彙一致は検出する", () => {
    const html = `<html><body><a href="/bundle">全件一括ダウンロード</a></body></html>`;
    const hints = detectDataSources(html, "https://example.jp/");
    expect(hints).toHaveLength(1);
  });

  it("sitemap.xml/RSSへの語彙一致も検出する", () => {
    const html = `<html><body><a href="/sitemap.xml">サイトマップ</a></body></html>`;
    const hints = detectDataSources(html, "https://example.jp/");
    expect(hints).toHaveLength(1);
  });
});

describe("機能C: detectDataSources - 実機検証で判明した誤検出の修正", () => {
  it("単独の「ダウンロード」(例: 点字ダウンロード等の無関係なリンク)は検出しない", () => {
    const html = `<html><body><a href="/braille/">点字ダウンロード</a></body></html>`;
    expect(detectDataSources(html, "https://example.jp/")).toEqual([]);
  });

  it("他ドメインへの「オープンデータ」説明リンク(例: デジタル庁ポータルへの案内)は検出しない", () => {
    const html = `<html><body><a href="https://cio.go.jp/policy-opendata">オープンデータ(デジタル庁)</a></body></html>`;
    expect(detectDataSources(html, "https://example.jp/")).toEqual([]);
  });

  it("厚労省ページ実測相当: 点字ダウンロード・他ドメインのオープンデータ説明リンクに埋まらず、jigyosho_*.csvを検出する", () => {
    const html = `<html><body>
      <a href="/braille/">点字ダウンロード</a>
      <a href="https://cio.go.jp/policy-opendata">オープンデータ(デジタル庁)</a>
      <a href="/data/jigyosho_01.csv">事業所一覧(北海道)</a>
      <a href="/data/jigyosho_02.csv">事業所一覧(青森県)</a>
    </body></html>`;

    const hints = detectDataSources(html, "https://kaigokensaku.mhlw.go.jp/");

    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("jigyosho_01.csv");
    expect(hints[0]).toContain("ほか1件");
    expect(hints.join("\n")).not.toContain("点字");
    expect(hints.join("\n")).not.toContain("デジタル庁");
  });
});

describe("機能C: detectDataSources - 拡張子一致の優先", () => {
  it("語彙一致のリンクが先に多数出現しても、拡張子一致(.csv)を優先して5枠を埋める", () => {
    const vocabAnchors = Array.from({ length: 6 }, (_, i) => `<a href="/portal${i}">全件一括ダウンロード${i}</a>`).join("");
    const html = `<html><body>${vocabAnchors}<a href="/data/r5.csv">令和5年度データ</a></body></html>`;

    const hints = detectDataSources(html, "https://example.jp/");

    expect(hints).toHaveLength(5);
    expect(hints[0]).toContain("令和5年度データ");
  });

  it("拡張子一致で5枠に満たない場合のみ、残り枠を語彙一致で埋める", () => {
    const html = `<html><body>
      <a href="/data/r5.csv">令和5年度データ</a>
      <a href="/bundle">全件一括ダウンロード</a>
    </body></html>`;

    const hints = detectDataSources(html, "https://example.jp/");

    expect(hints).toHaveLength(2);
    expect(hints[0]).toContain("令和5年度データ");
    expect(hints[1]).toContain("全件一括ダウンロード");
  });
});

describe("機能C: detectDataSources - 重複集約", () => {
  it("同一拡張子のリンクは代表1件+ほかN件に集約し、links filter提案を付ける", () => {
    const anchors = Array.from({ length: 20 }, (_, i) => `<a href="/data/r${i}.csv">令和${i}年度</a>`).join("");
    const html = `<html><body>${anchors}</body></html>`;

    const hints = detectDataSources(html, "https://example.jp/");

    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("令和0年度");
    expect(hints[0]).toContain("ほか19件");
    expect(hints[0]).toContain("links filter:'*.csv' で列挙可");
  });

  it("拡張子が異なるものは別グループとして集約する", () => {
    const html = `<html><body>
      <a href="/a.csv">A</a>
      <a href="/b.csv">B</a>
      <a href="/c.zip">C</a>
    </body></html>`;

    const hints = detectDataSources(html, "https://example.jp/");

    expect(hints).toHaveLength(2);
    expect(hints.some((h) => h.includes("ほか1件") && h.includes("*.csv"))).toBe(true);
    expect(hints.some((h) => h.includes("C") && h.includes(".zip") && !h.includes("ほか"))).toBe(true);
  });
});

describe("機能C: detectDataSources - レビュー指摘対応: API語彙の誤検出修正", () => {
  it("広告リダイレクトURL(redirect_api_logのような複合語の一部)は誤検出しない", () => {
    const html = `<html><body><a href="https://ad.yahoo.co.jp/redirect_api_log/xyz">広告</a></body></html>`;
    expect(detectDataSources(html, "https://news.yahoo.co.jp/")).toEqual([]);
  });

  it("リンクテキストが「API」の正当なエンドポイントは従来通り検出する", () => {
    const html = `<html><body><a href="/endpoint">API</a></body></html>`;
    const hints = detectDataSources(html, "https://example.jp/");
    expect(hints).toHaveLength(1);
  });

  it("URLパスに/api/セグメントを含む正当なエンドポイントは従来通り検出する", () => {
    const html = `<html><body><a href="/api/data">データ取得</a></body></html>`;
    const hints = detectDataSources(html, "https://example.jp/");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("データ取得");
  });
});

describe("機能C: detectDataSources - 上限5件", () => {
  it("6種類以上の拡張子/パターンが検出されても最大5件に切り詰める", () => {
    const html = `<html><body>
      <a href="/a.csv">A</a>
      <a href="/b.tsv">B</a>
      <a href="/c.zip">C</a>
      <a href="/d.json">D</a>
      <a href="/e.xlsx">E</a>
      <a href="/f.xls">F</a>
    </body></html>`;

    const hints = detectDataSources(html, "https://example.jp/");

    expect(hints).toHaveLength(5);
  });
});
