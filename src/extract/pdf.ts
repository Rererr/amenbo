/**
 * extract/pdf.ts — PDF対応(plan.md §6 Phase3 / 官公庁PDF想定)。
 *
 * pdfjs-distでテキスト層を抽出し、実質的にテキストが無ければ(スキャンPDF)
 * 各ページを画像化してタイルとして返す(mode:autoの品質スコア→ピクセル切替と同じ流儀)。
 *
 * 設計判断: Playwright(Chromium)のヘッドレスビルドは内蔵PDFビューアプラグインが
 * 無効化されており、`page.goto(pdfUrl)`は描画されずダウンロード扱いになることを実機検証で
 * 確認した(`<embed type="application/pdf">`経由でも "Couldn't load plugin" となり失敗)。
 * そのためPDFページの画像化にはPlaywrightを使わず、pdfjs-dist(パース・描画)+
 * @napi-rs/canvas(cairo等のシステム依存が無いprebuiltネイティブモジュール)を
 * 組み合わせる。
 */
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFPageProxy } from "pdfjs-dist";
import { PayloadTooLargeError } from "../errors.js";

export const DEFAULT_PDF_MAX_BYTES = 20 * 1024 * 1024; // 20MB

// これ未満(全ページ平均の抽出文字数/ページ)ならテキスト層が実質無い(スキャンPDF)とみなす。
// 図表ラベル程度の僅かなテキストは残る場合があるため、完全に0でなくとも低いしきい値にする。
const MIN_TEXT_CHARS_PER_PAGE = 30;
// 画像フォールバック時、トークン予算保護のため先頭N ページのみラスタライズする
const MAX_RENDER_PAGES = 10;
/**
 * テキスト抽出するページ数の上限。20MBのバイト上限は処理時間を抑えない
 * (実測: 30,000ページ・9.8MBのPDFで92.5秒。ページ数に対して超線形に伸びる)。
 * 3,000ページなら約1秒で、統計年鑑のような大部の資料でも実用上到達しない水準。
 */
const MAX_TEXT_PAGES = 3000;
const RENDER_SCALE = 1.5;

export interface PdfTextResult {
  hasTextLayer: boolean;
  /** ページ毎のプレーンテキスト(hasTextLayer=falseの場合は空配列)。 */
  pages: string[];
  pageCount: number;
  /** 実際にテキスト抽出したページ数(上限で打ち切った場合はpageCountより小さい)。 */
  extractedPageCount: number;
  title: string | null;
}

/** URLまたはContent-TypeからPDFかどうかを判定する。 */
export function looksLikePdf(url: string, contentType: string | null): boolean {
  if (contentType && /application\/pdf/i.test(contentType)) return true;
  try {
    return /\.pdf(?:[?#]|$)/i.test(new URL(url).pathname);
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(url);
  }
}

/** PDFバイト列がサイズ上限を超えていないか確認する。超過時は型付きエラーを投げる。 */
export function assertPdfSizeWithinLimit(url: string, byteLength: number, maxBytes: number = DEFAULT_PDF_MAX_BYTES): void {
  if (byteLength > maxBytes) {
    throw new PayloadTooLargeError(url, byteLength, maxBytes);
  }
}

export interface ExtractPdfTextOptions {
  /** テキスト抽出するページ数の上限(既定 MAX_TEXT_PAGES)。 */
  maxPages?: number;
}

/**
 * pdf.jsはdataに渡したバイト列の下敷きのArrayBufferをワーカーへtransferするため、
 * 呼び出し元の配列がその場でdetachされる(byteLengthが0になる)。テキスト層が無いPDFで
 * 同じバイト列を画像化しようとすると必ず失敗していたため、渡す前に複製する。
 */
function toOwnedCopy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** PDFバイト列からテキスト層を抽出する。実質的にテキストが無ければhasTextLayer=false。 */
export async function extractPdfText(bytes: Uint8Array, options: ExtractPdfTextOptions = {}): Promise<PdfTextResult> {
  // verbosity: 0 (ERRORS)にしてpdf.jsの警告ログでstdout/stderrを汚さないようにする
  const loadingTask = getDocument({ data: toOwnedCopy(bytes), useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    const extractedPageCount = Math.min(pageCount, options.maxPages ?? MAX_TEXT_PAGES);
    const pages: string[] = [];
    let totalChars = 0;

    for (let i = 1; i <= extractedPageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join("");
      totalChars += pageText.trim().length;
      pages.push(pageText);
    }

    const metadata = await doc.getMetadata().catch(() => null);
    const infoTitle = (metadata?.info as { Title?: string } | undefined)?.Title ?? "";
    const title = infoTitle.trim() || null;

    const hasTextLayer = extractedPageCount > 0 && totalChars / extractedPageCount >= MIN_TEXT_CHARS_PER_PAGE;

    return { hasTextLayer, pages: hasTextLayer ? pages : [], pageCount, extractedPageCount, title };
  } finally {
    await loadingTask.destroy();
  }
}

/** テキスト抽出結果をページ見出し付きのMarkdown相当プレーンテキストへ整形する。 */
export function markdownFromPdfText(result: PdfTextResult): string {
  return result.pages.map((text, index) => `## ページ ${index + 1}\n\n${text.trim()}`).join("\n\n");
}

export interface PdfPageImage {
  page: number;
  png: Buffer;
}

/** テキスト層が無いPDFのフォールバック: 各ページをPNGにラスタライズする(先頭MAX_RENDER_PAGESまで)。 */
export async function renderPdfPages(bytes: Uint8Array): Promise<PdfPageImage[]> {
  // verbosity: 0 (ERRORS)にしてpdf.jsの警告ログでstdout/stderrを汚さないようにする
  const loadingTask = getDocument({ data: toOwnedCopy(bytes), useSystemFonts: true, verbosity: 0 });
  try {
    const doc = await loadingTask.promise;
    const pageCount = Math.min(doc.numPages, MAX_RENDER_PAGES);
    const images: PdfPageImage[] = [];

    for (let i = 1; i <= pageCount; i++) {
      const page: PDFPageProxy = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      // @napi-rs/canvasのContext2Dは pdf.js が要求するCanvasRenderingContext2D相当のAPIを実装している。
      // canvas: null + canvasContext指定はDOM非依存(Node)環境向けにpdf.js自身が想定する使い方。
      await page.render({ canvas: null, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      images.push({ page: i, png: canvas.toBuffer("image/png") });
    }

    return images;
  } finally {
    await loadingTask.destroy();
  }
}
