import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./helpers/fixtureServer.js";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * ローカルのフィクスチャサーバーに対する統合テスト。実HTTPを1往復させないと現れない挙動
 * (Content-TypeとURLによるPDF経路・条件付きGET・robots.txtの拒否とSitemap宣言)だけを見る。
 *
 * 本文抽出そのものはfixtureファイルを直接読むユニットテスト(extract/tableRescue/pdf)が
 * 担当済みなので、ここでは重ねない。実サイトを叩くE2E(scripts/e2e-smoke.mjs)は、
 * フィクスチャでは作れない現実の逸脱を見る役目として別に残している。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-fixture-integration-"));
process.env.AMENBO_CACHE_DIR = cacheDir;
// 条件付きGETはTTL超過時にしか起きない。既定の15分では2回目がfreshで返ってしまう。
process.env.AMENBO_CACHE_TTL_MS = "1";

const { handleFetchTool, politeness, cache } = await import("../src/core.js");
const { discoverLinks } = await import("../src/links.js");
const { formatLinksResponse } = await import("../src/formatting.js");
const { RobotsDeniedError } = await import("../src/errors.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");

// ループバックはSSRFガードの拒否対象。テストの間だけ判定を外し、必ず元へ戻す。
setAddressPolicyForTests(() => false);
const server = await startFixtureServer();

afterAll(async () => {
  setAddressPolicyForTests(null);
  await server.close();
  cleanupCacheDir(cacheDir, () => cache.close());
});

/** handleFetchToolのテキスト応答を1本の文字列にまとめる。 */
async function fetchText(url: string): Promise<string> {
  const content = await handleFetchTool({ url });
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("HTTP経由のPDF取得", () => {
  it("application/pdfを返すURLはPDF経路で本文が抽出される", async () => {
    const text = await fetchText(`${server.origin}/doc.pdf`);

    expect(text).toContain("## ページ 1");
    expect(text).toContain("統計");
  }, 30_000);
});

describe("URL拡張子で分からないPDFの取得", () => {
  it("content-typeで判明した時点で読み切り、取得は1回で済む", async () => {
    const text = await fetchText(`${server.origin}/download`);

    expect(text).toContain("fetch_tier: pdf");
    expect(text).toContain("pdf_pages: 1000"); // 打ち切られていれば総ページ数が合わない
    // プレビュー(256KB打ち切り)で返すと、PDF経路が同じURLをもう一度全体取得することになる
    expect(server.hits.get("/download")).toBe(1);
  }, 30_000);

  it("リダイレクト先が変わっていたら、304でもキャッシュ済みのPDFを返さない", async () => {
    const url = `${server.origin}/pdf-moving`;

    server.pdfRedirectTarget = "/pdf-a";
    expect(await fetchText(url)).toContain("統計");

    await new Promise((resolve) => setTimeout(resolve, 20));
    server.pdfRedirectTarget = "/pdf-b";
    const second = await fetchText(url);

    // HTML経路と同じ理由(ETagはリソース間で一意である必要がない)
    expect(second).toContain("pdf_pages: 3");
    expect(second).not.toContain("統計");
  }, 30_000);
});

describe("英語ページの取得", () => {
  it("英語の記事から表がMarkdown表として取れる", async () => {
    const text = await fetchText(`${server.origin}/en/table.html`);

    expect(text).toMatch(/^\|.*\|$/m);
    expect(text).toContain("Average handling time");
    expect(text).toContain("1,204");
    expect(text).toContain("Quarterly Shipment Report");
  }, 30_000);
});

describe("robots.txtによる拒否", () => {
  it("Disallow配下のURLは取得せずRobotsDeniedErrorになる", async () => {
    const deniedUrl = `${server.origin}/denied/secret.html`;

    await expect(fetchText(deniedUrl)).rejects.toBeInstanceOf(RobotsDeniedError);
    expect(server.hits.get("/denied/secret.html")).toBeUndefined();
  }, 30_000);
});

describe("linksツールの優先順", () => {
  it("RSSを宣言しているページでも、robots.txtが指すsitemapを優先する", async () => {
    const result = await discoverLinks(server.origin, politeness);
    const text = formatLinksResponse(server.origin, result);

    expect(result.source).toBe("sitemap");
    expect(text).toContain("source: sitemap");
    expect(result.links.length).toBeGreaterThan(0);
    // sitemapで完結するため、ページ本体とフィードは取得しない(低負荷の要点)。
    expect(server.hits.get("/feed.xml")).toBeUndefined();
  }, 30_000);
});

describe("同一URLへの同時取得", () => {
  it("並行して呼んでも取得は1回にまとまる", async () => {
    const url = `${server.origin}/concurrent.html`;

    const [first, second] = await Promise.all([fetchText(url), fetchText(url)]);

    // politenessは取得の「開始間隔」を空けるだけで取得自体は並行するため、
    // まとめないと同じURLへ2回取りにいく(先に始まった取得が後から完了して
    // 新しいキャッシュを古い内容で上書きする競合も同時に塞いでいる)。
    expect(server.hits.get("/concurrent.html")).toBe(1);
    expect(first).toContain("CONCURRENT");
    expect(second).toContain("CONCURRENT");
  }, 30_000);
});

describe("Cache-Control(延長方向のみ採用)", () => {
  it("no-store宣言のページはキャッシュへ保存せず、次回も取得しに行く", async () => {
    const url = `${server.origin}/no-store.html`;

    expect(await fetchText(url)).toContain("NO-STORE");
    expect(cache.get(url)).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fetchText(url)).toContain("NO-STORE");
    expect(server.hits.get("/no-store.html")).toBe(2);
  }, 30_000);

  it("max-ageが既定TTLより長ければ、TTL超過後でも取得しに行かない", async () => {
    const url = `${server.origin}/long-cache.html`;

    expect(await fetchText(url)).toContain("cache: miss");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await fetchText(url)).toContain("cache: fresh");
    expect(server.hits.get("/long-cache.html")).toBe(1);
  }, 30_000);
});

describe("条件付きGET", () => {
  it("TTL超過後の再取得はIf-None-Matchを送り、304なら本文を取り直さない", async () => {
    const first = await fetchText(`${server.origin}/etag.html`);
    expect(first).toContain("cache: miss");

    // 待機を挟むのは、fresh判定がキャッシュ書き込み時刻からの経過で決まるため。
    // freshなら早期returnしてpolitenessの間隔調整にも入らないので、連続で呼ぶと
    // 同一ミリ秒に収まりTTL(1ms)を超えないことがある(実測で5回中4回)。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await fetchText(`${server.origin}/etag.html`);

    expect(second).toContain("cache: revalidated");
    expect(second).toContain("fetch_tier: cache");
    expect(server.lastIfNoneMatch).toBe('"fixture-v1"');
    // 304なので本文は取り直していないが、サーバーへの往復自体は2回発生している。
    expect(server.hits.get("/etag.html")).toBe(2);
  }, 30_000);

  it("リダイレクト先が変わっていたら、304でもキャッシュ済みの本文を返さない", async () => {
    const url = `${server.origin}/moving`;

    server.redirectTarget = "/target-a";
    expect(await fetchText(url)).toContain("TARGET-A");

    await new Promise((resolve) => setTimeout(resolve, 20));
    server.redirectTarget = "/target-b";
    const second = await fetchText(url);

    // ETagはリソース間で一意である必要がないため、着地先が変わっても304は返りうる。
    // その304を素直に受けると、target-aの本文をtarget-bの内容として返してしまう。
    expect(server.lastIfNoneMatch).toBeUndefined(); // 条件付きヘッダ無しで取り直している
    expect(second).toContain("TARGET-B");
    expect(second).not.toContain("TARGET-A");
  }, 30_000);
});
