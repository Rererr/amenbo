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
const { SectionNotFoundError } = await import("../src/errors.js");

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
  it("このプロセスが本文を返した後の失効後の再取得はunchangedになり、全文の推定トークンと取り直しの案内を持つ", async () => {
    const url = `${server.origin}/v/unchanged`;
    server.pages.set("/v/unchanged", articleHtml("変わらないページ", [{ heading: "概要", marker: "UNCHANGED-BODY" }]));

    expect(await fetchText({ url })).toContain("UNCHANGED-BODY");

    // 同じプロセスの別の呼び出し元(サブエージェント等)とは区別できないので、案内で取り直しを促す。
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

  it("outlineと1節だけを返した後に全文を求めると、差分ではなく本文を返す", async () => {
    const url = `${server.origin}/v/outline-then-full`;
    server.pages.set(
      "/v/outline-then-full",
      articleHtml("目次から読むページ", [
        { heading: "本題", marker: "OUTLINE-BODY" },
        { heading: "補足", marker: "OUTLINE-NOTE" },
      ]),
    );

    const outline = await fetchText({ url, mode: "outline" });
    const sectionId = /\[(s\d+)\] ## 本題/.exec(outline)?.[1];
    if (!sectionId) throw new Error(`outlineに「本題」の節がありません:\n${outline}`);
    await expire();
    expect(await fetchText({ url, section: sectionId })).toContain("OUTLINE-BODY");
    await expire();
    const full = await fetchText({ url, mode: "markdown" });

    expect(full).toContain("cache: miss");
    expect(full).toContain("OUTLINE-BODY");
    expect(full).toContain("OUTLINE-NOTE");
  }, 30_000);

  it("別のプロセスが取得して失効した行があっても、このプロセスが本文を返していなければ本文を返す", async () => {
    // 毎回違うETagを返すので、行は失効後も保持期間のあいだ残り、別のプロセスの起動時の掃除でも消えない。
    const url = `${server.origin}/v-etag/other-process`;
    server.pages.set("/v-etag/other-process", articleHtml("別のプロセスが取ったページ", [{ heading: "概要", marker: "OTHER-PROCESS-BODY" }]));
    expect(await fetchText({ url })).toContain("OTHER-PROCESS-BODY");

    // 同じキャッシュを開く別のプロセス(別のセッションのMCPサーバー)を、モジュールを読み直して作る。
    vi.resetModules();
    const other = await import("../src/core.js");
    const otherHttp = await import("../src/fetcher/http.js");
    otherHttp.setAddressPolicyForTests(() => false);
    vi.spyOn(other.politeness, "guard").mockResolvedValue(undefined);
    vi.spyOn(other.politeness, "waitTurn").mockResolvedValue(undefined);
    try {
      await expire();
      const text = textOf(await other.handleFetchTool({ url }));

      expect(text).toContain("cache: miss");
      expect(text).toContain("OTHER-PROCESS-BODY");
    } finally {
      otherHttp.setAddressPolicyForTests(null);
      other.cache.close();
    }
  }, 30_000);

  it("unchangedのtotal_tokensは、案内どおりforce_fullで取り直したときの量(定型ブロックを除く前)を示す", async () => {
    // 同じドメインの直近3ページに共通するフッタの段落を、定型ブロックとして学習させる。
    const footer = "<p>TEMPLATE-FOOTER このサイトの全ページに出る共通の案内文です。お問い合わせは窓口までお願いします。</p></article>";
    const withFooter = (title: string, marker: string) => articleHtml(title, [{ heading: "概要", marker }]).replace("</article>", footer);
    for (const name of ["a", "b"]) {
      server.pages.set(`/v/footer-${name}`, withFooter(`フッタのあるページ${name}`, `FOOTER-${name}`));
      await fetchText({ url: `${server.origin}/v/footer-${name}` });
    }
    const url = `${server.origin}/v/total-tokens`;
    server.pages.set("/v/total-tokens", withFooter("定型を含むページ", "TOTAL-TOKENS"));
    const first = await fetchText({ url });
    expect(first).toMatch(/^template_blocks_removed: \d+$/m);

    await expire();
    const unchanged = await fetchText({ url });
    await expire();
    const refetched = await fetchText({ url, force_full: true });

    expect(unchanged).toContain("cache: unchanged");
    expect(refetched).toContain("page: 1 of 1");
    expect(totalTokensOf(unchanged)).toBe(Number(/^tokens: (\d+)$/m.exec(refetched)?.[1]));
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

describe("sectionの契約(fetchツールのハンドラを通す)", () => {
  it("存在しないsection IDは、IDの振り方と揃えるべき引数を案内するエラーになる", async () => {
    const url = `${server.origin}/v/sections`;
    server.pages.set("/v/sections", articleHtml("節のあるページ", [{ heading: "唯一の節", marker: "SECTION-ONLY" }]));

    const error = await handleFetchTool({ url, section: "s99" }).then(
      () => null,
      (rejected: unknown) => rejected,
    );

    expect(error).toBeInstanceOf(SectionNotFoundError);
    const message = (error as Error).message;
    expect(message).toContain("selector");
    expect(message).toContain("force_full");
    expect(message).toContain("outline");
  }, 30_000);
});
