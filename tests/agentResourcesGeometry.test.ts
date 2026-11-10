import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * ジオメトリのためにブラウザで取り直した経路でも、HTTP の応答(Link・X-Llms-Txt ヘッダ)で知らされた
 * Markdown 版と llms.txt の在りかを落とさない(ブラウザの取得結果には応答ヘッダが無い)。
 * 取得層と本文抽出を差し替え、実ネットワークと実ブラウザを使わずに経路だけを通す。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-agent-resources-geometry-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const URL_ = "https://docs.example.com/guide";
const ARTICLE = "<html><body><div><p>本文。</p></div></body></html>";

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  const { HttpStatusError } = await import("../src/errors.js");
  return {
    ...actual,
    httpGet: async (url: string) => {
      throw new HttpStatusError(url, 404, "Not Found");
    },
  };
});

vi.mock("../src/fetcher/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/index.js")>();
  const base = { finalUrl: URL_, html: ARTICLE, status: 200, encoding: "UTF-8", etag: null, lastModified: null, cacheControl: null, escalationReason: null };
  return {
    ...actual,
    fetchPage: async (_url: string, options: { forceBrowser?: boolean } = {}) =>
      options.forceBrowser
        ? { ...base, tier: "browser", geometry: { textBlocks: [], visualElements: [], pageWidth: 0, pageHeight: 0 }, agentResources: { markdownAlternate: null, llmsTxt: null } }
        : { ...base, tier: "http", geometry: null, agentResources: { markdownAlternate: `${URL_}.md`, llmsTxt: "https://docs.example.com/llms.txt" } },
  };
});

vi.mock("../src/extract/markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extract/markdown.js")>();
  return {
    ...actual,
    // HTTPの結果は本文を選べず(body-fallback)、ブラウザの結果はジオメトリで選べた、という経路を作る。
    extractMarkdown: (...args: Parameters<typeof actual.extractMarkdown>) => {
      const result = actual.extractMarkdown(...args);
      return { ...result, extractionMethod: args[1]?.geometry ? "geometry" : "body-fallback" };
    },
  };
});

const { handleFetchTool, cache } = await import("../src/core.js");

afterAll(() => {
  cleanupCacheDir(cacheDir, () => cache.close());
});

describe("ジオメトリへ昇格した経路の在りか", () => {
  it("HTTP の応答で知らされた Markdown 版と llms.txt を応答に残す", async () => {
    const content = await handleFetchTool({ url: URL_, mode: "markdown" });
    const text = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

    expect(text).toContain("extraction: geometry");
    expect(text).toContain(`markdown_alternate: ${URL_}.md`);
    expect(text).toContain("llms_txt: https://docs.example.com/llms.txt");
  });
});
