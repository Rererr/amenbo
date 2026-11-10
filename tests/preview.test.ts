import { describe, expect, it } from "vitest";
import { buildHandoffPreview, isTextLikeContentType } from "../src/extract/preview.js";

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("機能B: isTextLikeContentType", () => {
  // 仕様: 人が読める文字で書かれた文書の型は、本文としてプレビューする。サイトが本文を配る形
  // (llms.txt の text/plain、ページごとの .md の text/markdown)を漏らさないことが要点。
  it.each([
    ["text/plain; charset=utf-8"],
    ["text/markdown"],
    ["text/markdown; charset=utf-8"],
    ["Text/Markdown; charset=UTF-8"],
    ["text/x-markdown"],
    ["text/csv"],
    ["text/tab-separated-values"],
    ["text/xml"],
    ["application/json"],
    ["application/xml"],
    ["application/ld+json"],
    ["application/rss+xml"],
  ])("%s はテキスト系としてプレビューする", (contentType) => {
    expect(isTextLikeContentType(contentType)).toBe(true);
    expect(buildHandoffPreview(toBytes("本文の一行目"), contentType, 1000, false)?.body).toBe("本文の一行目");
  });

  it("application/zip・application/vnd.ms-excel等のバイナリ系はtext-likeではない", () => {
    expect(isTextLikeContentType("application/zip")).toBe(false);
    expect(isTextLikeContentType("application/vnd.ms-excel")).toBe(false);
    expect(isTextLikeContentType("application/octet-stream")).toBe(false);
    expect(isTextLikeContentType(null)).toBe(false);
  });
});

describe("機能B: buildHandoffPreview - text/plain", () => {
  it("max_tokens予算に収まるテキストはそのまま返す", () => {
    const preview = buildHandoffPreview(toBytes("hello world"), "text/plain; charset=utf-8", 1000, false);
    expect(preview?.body).toBe("hello world");
    expect(preview?.note).toBeNull();
  });

  it("max_tokens予算を超えるテキストは切り詰め、その旨を注記する", () => {
    const longText = "a".repeat(10_000);
    const preview = buildHandoffPreview(toBytes(longText), "text/plain", 10, false);
    expect(preview).not.toBeNull();
    expect(preview!.body.length).toBeLessThan(longText.length);
    expect(preview!.note).toContain("max_tokens");
  });
});

describe("buildHandoffPreview - max_tokens を超えたテキストのページ送り", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}: 取得範囲の本文を max_tokens ごとに区切って続きを読めるか確かめる行`);
  const text = lines.join("\n");

  function allPages(maxTokens: number): { bodies: string[]; totalPages: number } {
    const first = buildHandoffPreview(toBytes(text), "text/markdown", maxTokens, false, 1)!;
    const bodies = [first.body];
    for (let page = 2; page <= first.totalPages; page++) {
      bodies.push(buildHandoffPreview(toBytes(text), "text/markdown", maxTokens, false, page)!.body);
    }
    return { bodies, totalPages: first.totalPages };
  }

  it("2ページ目以降で続きを返し、全ページをつなぐと取得した本文に戻る", () => {
    const { bodies, totalPages } = allPages(500);

    expect(totalPages).toBeGreaterThan(1);
    expect(bodies[1]).not.toBe(bodies[0]);
    expect(bodies.join("")).toBe(text);
    expect(bodies.join("")).toContain("line 399:");
  });

  it("途中のページは続きのページ番号を注記し、最後のページは注記しない", () => {
    const first = buildHandoffPreview(toBytes(text), "text/plain", 500, false, 1)!;
    const last = buildHandoffPreview(toBytes(text), "text/plain", 500, false, first.totalPages)!;

    expect(first.note).toContain("page: 2");
    expect(last.page).toBe(first.totalPages);
    expect(last.note).toBeNull();
  });

  it("範囲外のページは最後のページへ丸める", () => {
    const first = buildHandoffPreview(toBytes(text), "text/plain", 500, false, 1)!;
    const beyond = buildHandoffPreview(toBytes(text), "text/plain", 500, false, 999)!;

    expect(beyond.page).toBe(first.totalPages);
  });

  it("行の途中では切らない(後半に改行があるとき)", () => {
    const { bodies } = allPages(500);
    for (const body of bodies.slice(0, -1)) expect(body.endsWith("\n")).toBe(true);
  });

  it("極端に小さい予算でも先へ進み、時間が爆発しない", () => {
    const big = "word ".repeat(50_000);
    const started = Date.now();
    const preview = buildHandoffPreview(toBytes(big), "text/plain", 1, false, 3)!;

    expect(preview.totalPages).toBeGreaterThan(1000);
    expect(preview.body.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("機能B: buildHandoffPreview - sourceTruncated(ネットワーク層のプレビュー上限で打ち切り済み)", () => {
  it("max_tokens予算内に収まっていても、ネットワーク層で打ち切り済み(sourceTruncated)なら部分プレビューである旨を注記する", () => {
    const preview = buildHandoffPreview(toBytes("hello world"), "text/plain", 1000, true);
    expect(preview).not.toBeNull();
    expect(preview!.body).toBe("hello world");
    expect(preview!.note).not.toBeNull();
    expect(preview!.note).toContain("先頭部分");
  });

  it("sourceTruncated=falseかつmax_tokens内なら注記なし", () => {
    const preview = buildHandoffPreview(toBytes("hello world"), "text/plain", 1000, false);
    expect(preview!.note).toBeNull();
  });

  it("max_tokens予算超過による打ち切りが優先され、sourceTruncatedと二重に注記しない", () => {
    const longText = "a".repeat(10_000);
    const preview = buildHandoffPreview(toBytes(longText), "text/plain", 10, true);
    expect(preview!.note).toContain("max_tokens");
  });
});

describe("機能B: buildHandoffPreview - CSV/TSV", () => {
  it("CSVはヘッダ+先頭5行に整形し、行数を注記する", () => {
    const rows = ["id,name"];
    for (let i = 1; i <= 20; i++) rows.push(`${i},name${i}`);
    const csv = rows.join("\n");

    const preview = buildHandoffPreview(toBytes(csv), "text/csv; charset=utf-8", 8000, false);

    expect(preview).not.toBeNull();
    const lines = preview!.body.split("\n");
    expect(lines[0]).toBe("id,name");
    expect(lines.length).toBe(6); // ヘッダ+先頭5行
    expect(lines[1]).toBe("1,name1");
    expect(lines[5]).toBe("5,name5");
    expect(preview!.note).toContain("20行");
  });

  it("TSVもヘッダ+先頭5行に整形する", () => {
    const rows = ["id\tname", "1\ta", "2\tb", "3\tc"];
    const tsv = rows.join("\n");

    const preview = buildHandoffPreview(toBytes(tsv), "text/tab-separated-values", 8000, false);

    expect(preview).not.toBeNull();
    const lines = preview!.body.split("\n");
    expect(lines[0]).toBe("id\tname");
    expect(lines.length).toBe(4); // ヘッダ+3データ行(5行未満なので全件)
  });

  it("データ行が5行未満のCSVはある分だけ表示する", () => {
    const csv = "id,name\n1,a\n2,b";
    const preview = buildHandoffPreview(toBytes(csv), "text/csv", 8000, false);
    expect(preview).not.toBeNull();
    expect(preview!.body.split("\n")).toEqual(["id,name", "1,a", "2,b"]);
  });
});

describe("機能B: buildHandoffPreview - バイナリ系", () => {
  it("application/zip等のバイナリ系はnullを返す(メタデータのみ応答にする合図)", () => {
    const preview = buildHandoffPreview(new Uint8Array([1, 2, 3]), "application/zip", 8000, false);
    expect(preview).toBeNull();
  });
});
