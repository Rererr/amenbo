/**
 * jp/consentBanner.ts — J8: 国内同意バナー・アプリ誘導インタースティシャル除去。
 *
 * Cookie同意バナー・アプリ誘導オーバーレイ等、本文を覆う/汚染する要素を除去する。
 * Crawl4AIの40+CMP対応の国内版に相当するが、Phase 3では個別CMPのSDK名を列挙するのではなく、
 * 「よくある実装パターン」の汎用ヒューリスティックでカバーする:
 *   - id/class名にcookie/consent/cmp/gdpr/app-banner/interstitial等が含まれる
 *   - 「同意して閉じる」「アプリで開く」等の日本語頻出文言を含む
 *   - (fixed overlay判定はDOM抽出時は不可。ブラウザレンダリング時はfetcher/browser.tsの
 *     hideConsentBanners が実際のcomputed styleで判定する)
 * のうち複数シグナルが揃った場合のみ除去することで、誤除去(本文の一部を消してしまう)を防ぐ。
 */

const BANNER_TEXT_PATTERNS = [
  /同意して閉じる/,
  /同意する/,
  /Cookie.{0,10}(の使用に|に)?同意/i,
  /このサイトはCookieを使用/,
  /アプリで(開く|見る|読む)/,
  /アプリをダウンロード/,
  /アプリ内で開く/,
  /ストアで見る/,
  /App Store|Google Play.{0,10}(で|から)開く/i,
];

const BANNER_ID_CLASS_PATTERN = /cookie|consent|cmp[-_]|gdpr|app[-_]?banner|interstitial|smart-?banner/i;

/** 本文ブロックを誤って除去しないよう、この文字数を超えるブロックは対象外にする(バナーは短文が通例)。 */
const MAX_BANNER_TEXT_LENGTH = 400;

interface RemovableElement {
  id: string;
  className: string;
  textContent: string;
  remove(): void;
}

export interface ConsentBannerHostDocument {
  querySelectorAll(selector: string): ArrayLike<RemovableElement>;
}

/**
 * DOM上のCookie同意バナー/アプリ誘導インタースティシャルを除去する。
 * 除去したブロック数を返す。
 */
export function removeConsentBanners(document: ConsentBannerHostDocument): number {
  let removed = 0;
  const candidates = Array.from(document.querySelectorAll("div, section, aside, dialog"));

  for (const el of candidates) {
    const text = el.textContent ?? "";
    if (text.length === 0 || text.length > MAX_BANNER_TEXT_LENGTH) continue;

    const idClassMatch = BANNER_ID_CLASS_PATTERN.test(`${el.id ?? ""} ${el.className ?? ""}`);
    const textMatch = BANNER_TEXT_PATTERNS.some((pattern) => pattern.test(text));

    // id/class名パターンと文言パターンの両方が揃った場合のみ除去する(誤除去防止)
    if (idClassMatch && textMatch) {
      el.remove();
      removed++;
    }
  }

  return removed;
}
