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

describe("decodeHtmlBytes - 日本語以外の charset 宣言", () => {
  function htmlBytes(body: number[], head = ""): Uint8Array {
    const encoder = new TextEncoder();
    return Uint8Array.from([...encoder.encode(`<html><head>${head}</head><body><p>`), ...body, ...encoder.encode("</p></body></html>")]);
  }

  // 自動判定に回すと、EUC-KR・GB系・Big5 はバイトの範囲が重なる EUC-JP と取り違え、Latin-1 系は Shift_JIS と取り違えていた。
  it.each([
    ["windows-1252", [0x63, 0x61, 0x66, 0xe9], "café"],
    ["iso-8859-1", [0x6e, 0x61, 0xef, 0x76, 0x65], "naïve"],
    ["euc-kr", [0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee], "한국어"],
    ["gbk", [0xd6, 0xd0, 0xce, 0xc4], "中文"],
    ["gb2312", [0xd6, 0xd0, 0xce, 0xc4], "中文"],
    ["big5", [0xa4, 0xa4, 0xa4, 0xe5], "中文"],
  ])("ヘッダで %s と宣言されたバイト列を宣言どおりに読む", (label, body, expected) => {
    const result = decodeHtmlBytes(htmlBytes(body), `text/html; charset=${label}`);
    expect(result.text).toContain(expected);
  });

  it("meta で宣言された日本語以外の charset にも従う", () => {
    const result = decodeHtmlBytes(htmlBytes([0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee], '<meta charset="euc-kr">'), null);
    expect(result.text).toContain("한국어");
    expect(result.encoding).toBe("euc-kr");
  });

  it("ヘッダの Latin-1 宣言(サーバーの既定値になりがち)より、文書内の Shift_JIS 宣言を優先する", () => {
    const bytes = toBytes(htmlWithMetaCharset(SAMPLE_TEXT, "Shift_JIS"), "SJIS");
    const result = decodeHtmlBytes(bytes, "text/html; charset=ISO-8859-1");
    expect(result.encoding).toBe("Shift_JIS");
    expect(result.text).toContain(SAMPLE_TEXT);
  });

  it("TextDecoder も知らないラベルは、従来どおり自動判定へ回す", () => {
    const bytes = toBytes(`<html><body>${SAMPLE_TEXT}</body></html>`, "SJIS");
    const result = decodeHtmlBytes(bytes, "text/html; charset=x-no-such-charset");
    expect(result.encoding).toBe("Shift_JIS");
    expect(result.text).toContain(SAMPLE_TEXT);
  });

  it("TextDecoder の別名で書かれた日本語の宣言(csShiftJIS)も Shift_JIS として読む", () => {
    const bytes = toBytes(`<html><body>${SAMPLE_TEXT}</body></html>`, "SJIS");
    const result = decodeHtmlBytes(bytes, "text/html; charset=csShiftJIS");
    expect(result.encoding).toBe("Shift_JIS");
    expect(result.text).toContain(SAMPLE_TEXT);
  });

  it("meta の UTF-16 宣言は(ASCII として読めている以上)UTF-8 として扱う", () => {
    const bytes = new TextEncoder().encode(`<html><head><meta charset="utf-16"></head><body>${SAMPLE_TEXT}</body></html>`);
    const result = decodeHtmlBytes(bytes, null);
    expect(result.text).toContain(SAMPLE_TEXT);
  });
});
