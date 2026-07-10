import { describe, expect, it } from "vitest";
import { buildHandoffPreview, isTextLikeContentType } from "../src/extract/preview.js";

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("機能B: isTextLikeContentType", () => {
  it("text/plain・text/csv・text/tab-separated-values・application/json・application/xmlはtext-like", () => {
    expect(isTextLikeContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isTextLikeContentType("text/csv")).toBe(true);
    expect(isTextLikeContentType("text/tab-separated-values")).toBe(true);
    expect(isTextLikeContentType("application/json")).toBe(true);
    expect(isTextLikeContentType("application/xml")).toBe(true);
    expect(isTextLikeContentType("text/xml")).toBe(true);
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
