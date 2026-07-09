import Encoding from "encoding-japanese";
import { describe, expect, it } from "vitest";
import { decodeHtmlBytes } from "../src/fetcher/http.js";

const SAMPLE_TEXT = "こんにちは、世界。日本語Webページのテストです。";

function toBytes(text: string, encoding: "SJIS" | "EUCJP" | "JIS" | "UTF8"): Uint8Array {
  if (encoding === "UTF8") {
    return new TextEncoder().encode(text);
  }
  const array = Encoding.convert(Array.from(Buffer.from(text, "utf-8")), { to: encoding, from: "UTF8", type: "array" });
  return Uint8Array.from(array);
}

function htmlWithMetaCharset(body: string, charset: string): string {
  return `<html><head><meta charset="${charset}"></head><body><p>${body}</p></body></html>`;
}

describe("decodeHtmlBytes", () => {
  it("Content-Typeヘッダのcharset宣言(Shift_JIS)を優先してデコードする", () => {
    const html = htmlWithMetaCharset(SAMPLE_TEXT, "utf-8"); // metaは無視され、ヘッダを優先する想定
    const bytes = toBytes(html, "SJIS");
    const result = decodeHtmlBytes(bytes, "text/html; charset=Shift_JIS");
    expect(result.encoding).toBe("Shift_JIS");
    expect(result.text).toContain(SAMPLE_TEXT);
  });

  it("Content-Typeヘッダが無い場合はmetaタグのcharset宣言(EUC-JP)を使う", () => {
    const html = htmlWithMetaCharset(SAMPLE_TEXT, "EUC-JP");
    const bytes = toBytes(html, "EUCJP");
    const result = decodeHtmlBytes(bytes, null);
    expect(result.encoding).toBe("EUC-JP");
    expect(result.text).toContain(SAMPLE_TEXT);
  });

  it("宣言が無い場合はencoding-japaneseの自動判定(ISO-2022-JP)にフォールバックする", () => {
    const html = `<html><head></head><body><p>${SAMPLE_TEXT}</p></body></html>`;
    const bytes = toBytes(html, "JIS");
    const result = decodeHtmlBytes(bytes, null);
    expect(result.encoding).toBe("ISO-2022-JP");
    expect(result.text).toContain(SAMPLE_TEXT);
  });

  it("宣言も無く自動判定もJIS系にならない場合はUTF-8として扱う", () => {
    const html = `<html><head></head><body><p>${SAMPLE_TEXT}</p></body></html>`;
    const bytes = toBytes(html, "UTF8");
    const result = decodeHtmlBytes(bytes, null);
    expect(result.encoding).toBe("UTF-8");
    expect(result.text).toContain(SAMPLE_TEXT);
  });

  it("Content-Typeヘッダのcharset(Shift_JISの別名 x-sjis)を認識する", () => {
    const bytes = toBytes(`<html><body>${SAMPLE_TEXT}</body></html>`, "SJIS");
    const result = decodeHtmlBytes(bytes, "text/html; charset=x-sjis");
    expect(result.encoding).toBe("Shift_JIS");
    expect(result.text).toContain(SAMPLE_TEXT);
  });
});
