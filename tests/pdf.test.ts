import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PayloadTooLargeError } from "../src/errors.js";
import {
  assertPdfSizeWithinLimit,
  DEFAULT_PDF_MAX_BYTES,
  extractPdfText,
  looksLikePdf,
  markdownFromPdfText,
  renderPdfPages,
} from "../src/extract/pdf.js";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
}

describe("looksLikePdf", () => {
  it("Content-TypeがPDFなら真", () => {
    expect(looksLikePdf("https://example.com/a", "application/pdf")).toBe(true);
    expect(looksLikePdf("https://example.com/a", "application/pdf; charset=binary")).toBe(true);
  });

  it("URLが.pdfで終わるなら真", () => {
    expect(looksLikePdf("https://example.com/report.pdf", null)).toBe(true);
    expect(looksLikePdf("https://example.com/report.PDF", null)).toBe(true);
    expect(looksLikePdf("https://example.com/report.pdf?download=1", null)).toBe(true);
  });

  it("HTMLページは偽", () => {
    expect(looksLikePdf("https://example.com/article", "text/html")).toBe(false);
    expect(looksLikePdf("https://example.com/report.pdf.html", null)).toBe(false);
  });
});

describe("assertPdfSizeWithinLimit", () => {
  it("上限以内なら例外を投げない", () => {
    expect(() => assertPdfSizeWithinLimit("https://example.com/a.pdf", 1000, 2000)).not.toThrow();
  });

  it("上限超過はPayloadTooLargeErrorを投げる", () => {
    expect(() => assertPdfSizeWithinLimit("https://example.com/a.pdf", 3000, 2000)).toThrow(PayloadTooLargeError);
  });

  it("既定上限は20MB", () => {
    expect(DEFAULT_PDF_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("extractPdfText(fixtureベース)", () => {
  it("テキスト層のある実PDF(官公庁公開資料)からテキストを抽出する", async () => {
    const bytes = fixture("sample-text.pdf");
    const result = await extractPdfText(bytes);
    expect(result.hasTextLayer).toBe(true);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    expect(result.pages.join("")).toContain("統計");
  });

  it("markdownFromPdfTextはページ見出し付きのテキストを生成する", async () => {
    const bytes = fixture("sample-text.pdf");
    const result = await extractPdfText(bytes);
    const markdown = markdownFromPdfText(result);
    expect(markdown).toContain("## ページ 1");
  });

  it("テキスト層の無いPDF(スキャン相当)はhasTextLayer=falseになる", async () => {
    const bytes = fixture("sample-blank.pdf");
    const result = await extractPdfText(bytes);
    expect(result.hasTextLayer).toBe(false);
    expect(result.pages).toEqual([]);
  });
});

describe("renderPdfPages(fixtureベース)", () => {
  it("PDFの各ページをPNGにラスタライズする", async () => {
    const bytes = fixture("sample-blank.pdf");
    const images = await renderPdfPages(bytes);
    expect(images).toHaveLength(1);
    expect(images[0]?.page).toBe(1);
    // PNGシグネチャ(先頭8バイト)を確認
    expect(images[0]?.png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
