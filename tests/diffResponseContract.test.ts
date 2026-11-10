import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFixtureServer } from "./helpers/fixtureServer.js";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * 差分応答(cache: unchanged / diff)の契約を、fetchツールのハンドラを通して確かめる。
 * 比較の基準はamenboのキャッシュで、キャッシュはセッション・サブエージェント・CLIをまたいで共有されるため、
 * 本文を見ていない呼び出し元にも差分応答が返りうる。ここではその応答が取り直しの判断材料を持つことと、
 * 差分にしてはいけない要求(2ページ目以降)で差分にならないことを見る。
 *
 * フィクスチャのページはETagもLast-Modifiedも返さないので、TTL(1ms)を過ぎた再取得は毎回200になり、
 * 旧キャッシュとの比較に入る。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-diff-contract-"));
process.env.AMENBO_CACHE_DIR = cacheDir;
process.env.AMENBO_CACHE_TTL_MS = "1";

const { handleFetchTool, politeness, cache } = await import("../src/core.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");
const { estimateTokens } = await import("../src/tokens.js");

setAddressPolicyForTests(() => false);
const server = await startFixtureServer();

afterAll(async () => {
  setAddressPolicyForTests(null);
  await server.close();
  cleanupCacheDir(cacheDir, () => cache.close());
  delete process.env.AMENBO_CACHE_TTL_MS;
});

beforeEach(() => {
  // 同じホストへの1秒間隔を待つと1件ごとに1秒かかる。間隔制御はここで見る契約ではない。
  vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
  vi.spyOn(politeness, "waitTurn").mockResolvedValue(undefined);
});

const FILLER =
  "この段落は本文抽出の対象として扱われる程度の分量を持たせるための文です。短すぎる本文は品質が低いと判定され、" +
  "描画を伴う取得へ切り替わるため、どの節にも同じ程度の長さの説明を置いています。";

/** 節ごとに目印の文を持つ記事。目印で、応答にどの節の本文が入っているかを見分ける。 */
function articleHtml(title: string, sections: Array<{ heading: string; marker: string; children?: Array<{ heading: string; marker: string }> }>): string {
  const body = sections
    .map((section) => {
      const children = (section.children ?? []).map((child) => `<h3>${child.heading}</h3>\n<p>${child.marker} ${FILLER}</p>`).join("\n");
      return `<h2>${section.heading}</h2>\n<p>${section.marker} ${FILLER}</p>\n<p>${FILLER}</p>\n${children}`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head>
<body><article><h1>${title}</h1>
<p>${FILLER}</p>
${body}
</article></body></html>`;
}

function textOf(content: Awaited<ReturnType<typeof handleFetchTool>>): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function fetchText(input: Parameters<typeof handleFetchTool>[0]): Promise<string> {
  return textOf(await handleFetchTool(input));
}

/** TTL(1ms)を確実に過ぎるための待ち。fresh判定はキャッシュ書き込み時刻からの経過で決まる。 */
function expire(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function totalTokensOf(text: string): number {
  const match = /^total_tokens: (\d+)$/m.exec(text);
  if (!match?.[1]) throw new Error(`total_tokens の行がありません:\n${text}`);
  return Number(match[1]);
}

describe("差分応答の契約(fetchツールのハンドラを通す)", () => {
  it("本文を見ていない呼び出し元に返るunchangedは、全文の推定トークンと取り直しの案内を持つ", async () => {
    const url = `${server.origin}/v/unchanged`;
    server.pages.set("/v/unchanged", articleHtml("変わらないページ", [{ heading: "概要", marker: "UNCHANGED-BODY" }]));

    // 呼び出し元Aが取得する(別のセッションやCLIでもキャッシュは共有される)。
    expect(await fetchText({ url })).toContain("UNCHANGED-BODY");

    // 呼び出し元Bは初めてこのURLを取る。
    await expire();
    const second = await fetchText({ url });

    expect(second).toContain("cache: unchanged");
    expect(totalTokensOf(second)).toBeGreaterThan(0);
    expect(second).toContain("force_full: true");

    await expire();
    const refetched = await fetchText({ url, force_full: true });
    expect(refetched).toContain("UNCHANGED-BODY");
  }, 30_000);

  it("diffは変わった節だけでなく、全文の推定トークンと取り直しの案内を持つ", async () => {
    const url = `${server.origin}/v/diff`;
    const sections = [
      { heading: "第一節", marker: "DIFF-ONE" },
      { heading: "第二節", marker: "DIFF-TWO-OLD" },
      { heading: "第三節", marker: "DIFF-THREE" },
    ];
    server.pages.set("/v/diff", articleHtml("一部が変わるページ", sections));
    await fetchText({ url });

    server.pages.set("/v/diff", articleHtml("一部が変わるページ", sections.map((s) => (s.heading === "第二節" ? { ...s, marker: "DIFF-TWO-NEW" } : s))));
    await expire();
    const second = await fetchText({ url });

    expect(second).toContain("cache: diff");
    expect(second).toContain("DIFF-TWO-NEW");
    expect(second).not.toContain("DIFF-ONE");
    expect(totalTokensOf(second)).toBeGreaterThan(0);
    expect(second).toContain("force_full: true");
  }, 30_000);

  it("親節と子節が変わったdiffは、子節の本文を二重に出さず、全文より小さい", async () => {
    const url = `${server.origin}/v/nested`;
    const build = (parent: string, child: string) =>
      articleHtml("入れ子のページ", [
        { heading: "親", marker: parent, children: [{ heading: "子1", marker: child }, { heading: "子2", marker: "NESTED-SIBLING" }] },
        { heading: "別の節", marker: "NESTED-OTHER" },
      ]);
    server.pages.set("/v/nested", build("NESTED-PARENT-OLD", "NESTED-CHILD-OLD"));
    await fetchText({ url });

    server.pages.set("/v/nested", build("NESTED-PARENT-NEW", "NESTED-CHILD-NEW"));
    await expire();
    const second = await fetchText({ url });

    expect(second).toContain("cache: diff");
    expect(second).toContain("NESTED-PARENT-NEW");
    expect(second.match(/NESTED-CHILD-NEW/g)).toHaveLength(1);
    expect(second).not.toContain("NESTED-SIBLING");
    expect(estimateTokens(second)).toBeLessThan(totalTokensOf(second));
  }, 30_000);

  it("diffがmax_tokensを超えるときは、差分ではなくページに区切った通常の応答を返す", async () => {
    const url = `${server.origin}/v/large-diff`;
    const sections = Array.from({ length: 6 }, (_, i) => ({ heading: `節${i + 1}`, marker: `LARGE-${i + 1}-OLD` }));
    server.pages.set("/v/large-diff", articleHtml("多くの節が変わるページ", sections));
    await fetchText({ url, max_tokens: 200 });

    // 最後の節だけ残して変える(全節変更だと別の理由で通常の応答になる)。
    server.pages.set("/v/large-diff", articleHtml("多くの節が変わるページ", sections.map((s, i) => (i < 5 ? { ...s, marker: `LARGE-${i + 1}-NEW` } : s))));
    await expire();
    const second = await fetchText({ url, max_tokens: 200 });

    expect(second).not.toContain("cache: diff");
    expect(second).toMatch(/^page: 1 of \d+$/m);
    expect(estimateTokens(second)).toBeLessThan(400);
  }, 30_000);

  it("outlineだけを見た後に全文を求めると、本文か取り直しの案内が返る", async () => {
    const url = `${server.origin}/v/outline-then-full`;
    server.pages.set("/v/outline-then-full", articleHtml("目次から読むページ", [{ heading: "本題", marker: "OUTLINE-BODY" }]));

    expect(await fetchText({ url, mode: "outline" })).toContain("mode_used: outline");
    await expire();
    const full = await fetchText({ url, mode: "markdown" });

    expect(full.includes("OUTLINE-BODY") || full.includes("force_full: true")).toBe(true);
  }, 30_000);

  it("失効後の2ページ目の要求は、差分ではなくそのページの中身を返す", async () => {
    const url = `${server.origin}/v/long`;
    const sections = Array.from({ length: 12 }, (_, i) => ({ heading: `節${i + 1}`, marker: `LONG-${i + 1}` }));
    server.pages.set("/v/long", articleHtml("長いページ", sections));

    const first = await fetchText({ url, max_tokens: 150 });
    const totalPages = Number(/^page: 1 of (\d+)$/m.exec(first)?.[1]);
    expect(totalPages).toBeGreaterThanOrEqual(2);

    await expire();
    const second = await fetchText({ url, max_tokens: 150, page: 2 });

    expect(second).toContain(`page: 2 of ${totalPages}`);
    expect(second).not.toContain("cache: unchanged");
    expect(second).not.toContain("cache: diff");
  }, 30_000);
});
