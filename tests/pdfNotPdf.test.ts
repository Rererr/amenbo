import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * URLが .pdf でも応答が PDF でないとき(期限切れのリンクがログイン画面を返す等)と、pdf.js が
 * 投げる例外(パスワード付き・壊れたPDF)を、「予期しないエラー」でなく理由の分かるエラーにする。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-pdf-not-pdf-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { extractPdfTextSpy } = vi.hoisted(() => ({ extractPdfTextSpy: vi.fn() }));
vi.mock("../src/extract/pdf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extract/pdf.js")>();
  extractPdfTextSpy.mockImplementation(actual.extractPdfText);
  return { ...actual, extractPdfText: (...args: Parameters<typeof actual.extractPdfText>) => extractPdfTextSpy(...args) };
});

const { handleFetchTool, cache } = await import("../src/core.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");
const { PdfUnreadableError } = await import("../src/errors.js");

const PDF_BYTES = readFileSync(new URL("./fixtures/sample-text.pdf", import.meta.url));
const LOGIN_HTML = "<!DOCTYPE html><html><head><title>ログイン</title></head><body><form><input name=id></form></body></html>";

const server: Server = createServer((req, res) => {
  switch (req.url) {
    case "/robots.txt":
      res.writeHead(200, { "Content-Type": "text/plain" }).end("User-agent: *\nAllow: /\n");
      return;
    case "/expired.pdf":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(LOGIN_HTML);
      return;
    case "/moved.pdf":
      res.writeHead(302, { Location: "/login" }).end();
      return;
    case "/login":
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(LOGIN_HTML);
      return;
    case "/broken.pdf":
      res.writeHead(200, { "Content-Type": "application/pdf" }).end("%PDF-1.4\nthis is not a real pdf body\n");
      return;
    case "/locked.pdf":
    case "/real.pdf":
      res.writeHead(200, { "Content-Type": "application/pdf" }).end(PDF_BYTES);
      return;
    default:
      res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
setAddressPolicyForTests(() => false);

afterAll(async () => {
  setAddressPolicyForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupCacheDir(cacheDir, () => cache.close());
});

describe("URLが .pdf でも応答が PDF でないとき", () => {
  it("HTML が返ったら、何が返ったかを書いたエラーにする(pdf.js へ渡さない)", async () => {
    extractPdfTextSpy.mockClear();
    const error = await handleFetchTool({ url: `${origin}/expired.pdf` }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PdfUnreadableError);
    expect((error as Error).message).toContain("PDFではない応答");
    expect((error as Error).message).toContain("text/html");
    expect((error as Error).message).toContain("ログイン画面");
    expect(extractPdfTextSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("PDFでないページへ転送されたら、転送先を fetch すれば読めることを示す", async () => {
    const error = await handleFetchTool({ url: `${origin}/moved.pdf` }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PdfUnreadableError);
    expect((error as Error).message).toContain(`転送先 ${origin}/login を fetch`);
  }, 30_000);
});

describe("pdf.js の例外", () => {
  it("壊れた PDF は、構造を読めなかったという理由つきのエラーにする", async () => {
    const error = await handleFetchTool({ url: `${origin}/broken.pdf` }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PdfUnreadableError);
    expect((error as Error).message).toContain("PDFの構造を読めませんでした");
  }, 30_000);

  it("パスワード付きの PDF は、その理由を書いたエラーにする", async () => {
    const passwordError = Object.assign(new Error("No password given"), { name: "PasswordException" });
    extractPdfTextSpy.mockRejectedValueOnce(passwordError);

    const error = await handleFetchTool({ url: `${origin}/locked.pdf` }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PdfUnreadableError);
    expect((error as Error).message).toContain("パスワードで保護されたPDF");
  }, 30_000);

  it("正常な PDF は従来どおり本文を返す", async () => {
    const content = await handleFetchTool({ url: `${origin}/real.pdf` });
    const text = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

    expect(text).toContain("fetch_tier: pdf");
  }, 30_000);
});
