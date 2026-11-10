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

describe("decodeHtmlBytes - 弱い宣言(Latin-1 系・BOM の無い UTF-16 系)の付いた日本語のページ", () => {
  const page = (head: string) => `<html><head>${head}<title>t</title></head><body><p>${SAMPLE_TEXT}</p></body></html>`;

  // サーバーやテンプレートの既定値がそのまま付いた日本語のページ。宣言に従うと化ける(以前は自動判定で読めていた)。
  it.each([
    ["Shift_JIS の本文 + ヘッダ ISO-8859-1 + meta なし", toBytes(page(""), "SJIS"), "text/html; charset=ISO-8859-1"],
    ["UTF-8 の本文 + ヘッダ ISO-8859-1 + meta なし", toBytes(page(""), "UTF8"), "text/html; charset=ISO-8859-1"],
    ["Shift_JIS の本文 + meta iso-8859-1", toBytes(page('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'), "SJIS"), "text/html"],
    ["EUC-JP の本文 + meta windows-1252", toBytes(page('<meta charset="windows-1252">'), "EUCJP"), "text/html"],
    ["text/plain の Shift_JIS + ヘッダ ISO-8859-1", toBytes(SAMPLE_TEXT, "SJIS"), "text/plain; charset=ISO-8859-1"],
    ["UTF-8 の本文 + ヘッダ utf-16", toBytes(page(""), "UTF8"), "text/html; charset=utf-16"],
    ["UTF-8 の本文 + ヘッダ unicode", toBytes(page(""), "UTF8"), "text/html; charset=unicode"],
  ])("%s は日本語として読める", (_label, bytes, contentType) => {
    expect(decodeHtmlBytes(bytes, contentType).text).toContain(SAMPLE_TEXT);
  });

  // 日本語の自動判定は、本物の Latin-1 の文を Shift_JIS と取り違えることがある(下の独語の文は実測で取り違えた)。
  const LATIN1_SENTENCES = [
    "Le café est fermé le dimanche, mais la pâtisserie reste ouverte jusqu'à midi.",
    "Über die Öffnungszeiten informiert Sie unser Kundendienst täglich ab neun Uhr.",
    "Größere Änderungen müssen vorher mit der Geschäftsführung abgestimmt werden.",
    "¿Dónde está la biblioteca? Está al lado del ayuntamiento, en la plaza mayor.",
    "Vi ses på søndag ved søen; husk at tage din frakke med, for det blæser meget.",
  ];
  const latin1 = (text: string) => Uint8Array.from(Array.from(text, (ch) => ch.codePointAt(0)!));

  it.each(LATIN1_SENTENCES)("Latin-1 の実文は、ヘッダの宣言どおり windows-1252 で読む: %s", (sentence) => {
    const result = decodeHtmlBytes(latin1(`<html><body><p>${sentence}</p></body></html>`), "text/html; charset=iso-8859-1");
    expect(result.text).toContain(sentence);
    expect(result.encoding).toBe("windows-1252");
  });

  it.each(LATIN1_SENTENCES)("Latin-1 の実文は、meta の宣言どおり windows-1252 で読む: %s", (sentence) => {
    const result = decodeHtmlBytes(latin1(`<html><head><meta charset="windows-1252"></head><body><p>${sentence}</p></body></html>`), null);
    expect(result.text).toContain(sentence);
  });

  it.each(["utf-16le", "utf-16"])("BOM の無い英字だけの UTF-16LE は、UTF-8 として読めても NUL 混じりの読み方を採らず、宣言(%s)どおり読む", (label) => {
    const text = "<html><body><p>English only page</p></body></html>";
    const bytes = Uint8Array.from(Array.from(text).flatMap((ch) => [ch.charCodeAt(0), 0]));
    const result = decodeHtmlBytes(bytes, `text/html; charset=${label}`);
    expect(result.text).toContain("English only page");
    expect(result.text).not.toContain("\u0000");
  });

  it("BOM の無い英字だけの UTF-16BE も、宣言どおり UTF-16BE で読む", () => {
    const text = "<html><body><p>English only page</p></body></html>";
    const bytes = Uint8Array.from(Array.from(text).flatMap((ch) => [0, ch.charCodeAt(0)]));
    expect(decodeHtmlBytes(bytes, "text/html; charset=utf-16be").text).toContain("English only page");
  });

  // 限界(仕様として残す): かなを条件にしているので、漢字だけの Shift_JIS の本文に Latin-1 の宣言が付くと、
  // 日本語と判定せず宣言どおり windows-1252 で読む(基点の版は自動判定で読めていた)。かなを条件にしないと、
  // 本物の Latin-1 の文を Shift_JIS と取り違える(実測で独語の文)ため、こちらを採った。
  it("限界: かなを含まない(漢字だけの)Shift_JIS の本文は、Latin-1 の宣言があると日本語として読まない", () => {
    const kanjiOnly = "東京都千代田区丸之内一丁目";
    const result = decodeHtmlBytes(toBytes(`<html><body><p>${kanjiOnly}</p></body></html>`, "SJIS"), "text/html; charset=iso-8859-1");
    expect(result.encoding).toBe("windows-1252");
    expect(result.text).not.toContain(kanjiOnly);
  });

  it("BOM のある UTF-16 は宣言どおり UTF-16 で読む", () => {
    const text = `<html><body><p>${SAMPLE_TEXT}</p></body></html>`;
    const bytes = Uint8Array.from([0xff, 0xfe, ...Array.from(text).flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])]);
    expect(decodeHtmlBytes(bytes, "text/html; charset=utf-16").text).toContain(SAMPLE_TEXT);
  });
});
