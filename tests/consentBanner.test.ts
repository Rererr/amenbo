import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { removeConsentBanners, type ConsentBannerHostDocument } from "../src/jp/consentBanner.js";

function makeDocument(bodyHtml: string): ConsentBannerHostDocument {
  const { document } = parseHTML(`<html><body>${bodyHtml}</body></html>`);
  return document as unknown as ConsentBannerHostDocument;
}

describe("removeConsentBanners", () => {
  it("id/classにcookieを含み文言も一致するバナーを除去する", () => {
    const doc = makeDocument(`
      <div id="cookie-consent-banner">当サイトはCookieの使用に同意いただく必要があります。<button>同意して閉じる</button></div>
      <article><p>これは本文の段落です。バナーとは無関係な内容です。</p></article>
    `);
    const removed = removeConsentBanners(doc);
    expect(removed).toBe(1);
  });

  it("アプリ誘導バナーを除去する", () => {
    const doc = makeDocument(`
      <div class="app-banner-container">アプリで開くと更に便利です。<a href="#">アプリで開く</a></div>
      <p>本文はそのまま残る。</p>
    `);
    const removed = removeConsentBanners(doc);
    expect(removed).toBe(1);
  });

  it("id/classパターンに一致しても文言が無ければ除去しない(誤検知防止)", () => {
    const doc = makeDocument(`<div class="consent-form">これは同意ではなく単なるお問い合わせフォームの説明です。</div>`);
    const removed = removeConsentBanners(doc);
    expect(removed).toBe(0);
  });

  it("文言に一致してもid/classが無関係なら除去しない(誤検知防止)", () => {
    const doc = makeDocument(`<div class="main-article"><p>この記事では利用規約に同意する手順を解説します。</p></div>`);
    const removed = removeConsentBanners(doc);
    expect(removed).toBe(0);
  });

  it("長文ブロック(本文らしきもの)は対象外にする", () => {
    const longText = "同意する。".repeat(100); // 400文字超
    const doc = makeDocument(`<div class="cookie-notice">${longText}</div>`);
    const removed = removeConsentBanners(doc);
    expect(removed).toBe(0);
  });

  it("バナーが無いページは何も除去しない", () => {
    const doc = makeDocument(`<article><p>普通の記事本文です。</p></article>`);
    expect(removeConsentBanners(doc)).toBe(0);
  });
});
