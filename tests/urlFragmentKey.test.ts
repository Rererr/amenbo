import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withoutDocumentFragment } from "../src/cache.js";
import { startFixtureServer } from "./helpers/fixtureServer.js";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * HTTPはURLのフラグメントを先方へ送らない。同じ文書を `#見出し` 違いで続けて取っても、
 * 先方への取得・キャッシュの行・定型学習の記録は1つの文書として扱う。
 * `#/` と `#!` はSPAが画面を切り替えるルートなので別の文書のまま扱う。
 */

describe("withoutDocumentFragment", () => {
  it.each([
    ["https://example.com/a#intro", "https://example.com/a"],
    ["https://example.com/a?x=1#s2", "https://example.com/a?x=1"],
    ["https://example.com/a#", "https://example.com/a"],
    ["https://example.com/a", "https://example.com/a"],
    ["https://example.com/app#/settings", "https://example.com/app#/settings"],
    ["https://example.com/app#!/settings", "https://example.com/app#!/settings"],
  ])("%s → %s", (input, expected) => {
    expect(withoutDocumentFragment(input)).toBe(expected);
  });
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-url-fragment-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { handleFetchTool, politeness, cache } = await import("../src/core.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");

setAddressPolicyForTests(() => false);
const server = await startFixtureServer();

afterAll(async () => {
  setAddressPolicyForTests(null);
  await server.close();
  cleanupCacheDir(cacheDir, () => cache.close());
});

beforeEach(() => {
  vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
  vi.spyOn(politeness, "waitTurn").mockResolvedValue(undefined);
});

function articleHtml(marker: string): string {
  const paragraphs = Array.from(
    { length: 4 },
    (_, i) => `<p>${marker} の${i + 1}番目の段落です。見出しへのリンクをたどって同じ文書を何度も開く使い方を想定し、本文抽出の対象として扱われる程度の長さの説明を置いています。</p>`,
  ).join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${marker}</title></head>
<body><article><h1>${marker}</h1>${paragraphs}<h2>はじめに</h2><p>${marker} の導入です。</p><h2>詳細</h2><p>${marker} の詳細です。</p></article></body></html>`;
}

async function fetchText(input: Parameters<typeof handleFetchTool>[0]): Promise<string> {
  return (await handleFetchTool(input)).map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("URLのフラグメント", () => {
  it("フラグメント違いの同じ文書は1回だけ取得し、定型学習でも1ページと数える", async () => {
    server.pages.set("/v/fragment-doc", articleHtml("FRAGMENT-DOC"));
    const base = `${server.origin}/v/fragment-doc`;

    await fetchText({ url: `${base}#intro` });
    await fetchText({ url: `${base}#detail` });
    await fetchText({ url: base });
    // 同じ文書を別ページと数えると、直近3ページすべてに同じブロックがあることになり、本文が定型として消える。
    const outline = await fetchText({ url: `${base}#summary`, mode: "outline" });

    expect(outline).not.toContain("template_blocks_removed");
    expect(server.hits.get("/v/fragment-doc")).toBe(1);
  }, 30_000);

  it("フラグメント違いの同時取得は1本にまとまる", async () => {
    server.pages.set("/v/fragment-concurrent", articleHtml("FRAGMENT-CONCURRENT"));
    const base = `${server.origin}/v/fragment-concurrent`;

    const [first, second] = await Promise.all([fetchText({ url: `${base}#a` }), fetchText({ url: `${base}#b` })]);

    expect(server.hits.get("/v/fragment-concurrent")).toBe(1);
    expect(first).toContain("FRAGMENT-CONCURRENT");
    expect(second).toContain("FRAGMENT-CONCURRENT");
  }, 30_000);

  it("#/ で始まるSPAのルートは別の文書として扱う", async () => {
    server.pages.set("/v/spa", articleHtml("FRAGMENT-SPA"));
    const base = `${server.origin}/v/spa`;

    await fetchText({ url: `${base}#/a` });
    await fetchText({ url: `${base}#/b` });

    expect(server.hits.get("/v/spa")).toBe(2);
  }, 30_000);
});
