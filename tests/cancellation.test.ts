import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * MCP の取り消し(notifications/cancelled)を、待ち行列の待機と HTTP 取得へ伝え、取り消された要求を先方へ送らないこと。
 * 実際の MCP Client + InMemoryTransport と、ループバックの実サーバーで確かめる(実サイトへは出ない)。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-cancellation-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");
const { createServer } = await import("../src/server.js");
const { cache, handleFetchTool } = await import("../src/core.js");
const { runCancellableBy } = await import("../src/politeness.js");
const { RequestCancelledError } = await import("../src/errors.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");

setAddressPolicyForTests(() => false);
const closers: Array<() => Promise<void>> = [];

afterAll(async () => {
  setAddressPolicyForTests(null);
  await Promise.all(closers.map((close) => close()));
  cleanupCacheDir(cacheDir, () => cache.close());
});

const ARTICLE = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>取り消しの検証</title></head>
<body><article><h1>取り消しの検証</h1>
<p>この段落は、取り消されなかった呼び出しに本文が返ったことを確かめる目印 CANCEL-MARKER を含みます。
本文抽出の対象として扱われる分量が要るため、同じ趣旨の文をいくつか続けています。</p>
<p>短すぎる本文は抽出の品質が低いと判定され、描画を伴う取得へ切り替わることがあります。そうなると
同じページへの取得が余分に発生し、何回サーバーへ行ったかを数える検証が成り立ちません。</p>
<p>そのため、通常の記事と同程度の段落数を置いています。内容そのものは検証結果に影響しません。</p>
</article></body></html>`;

interface Fixture {
  origin: string;
  /** パスごとの到着回数(robots.txt を除く) */
  arrivals: Map<string, number>;
  /** 応答を返す前に接続が閉じられたパス(取得の中止が先方に届いたか) */
  abandoned: string[];
}

/** サイトごとに別のポート(=別の待ち行列)で立てる。slowMs だけ応答を遅らせる。 */
async function startSite(slowMs = 0): Promise<Fixture> {
  const arrivals = new Map<string, number>();
  const abandoned: string[] = [];
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    if (path === "/robots.txt") {
      res.end("");
      return;
    }
    arrivals.set(path, (arrivals.get(path) ?? 0) + 1);
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ARTICLE);
    }, slowMs);
    res.on("close", () => {
      clearTimeout(timer);
      if (!res.writableFinished) abandoned.push(path);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, arrivals, abandoned };
}

async function connectedClient(): Promise<InstanceType<typeof Client>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "amenbo-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  return client;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("MCP の取り消し", () => {
  it("順番待ちの間に取り消した要求は、先方へ送らない。前に並んでいた要求は取得する", async () => {
    const site = await startSite();
    const client = await connectedClient();
    const controller = new AbortController();

    // robots.txt の取得から1秒ずつ間隔を空けるので、/q/0 は約1秒後、/q/1 は約2秒後の番になる
    const first = client.callTool({ name: "fetch", arguments: { url: `${site.origin}/q/0` } });
    const second = client.callTool({ name: "fetch", arguments: { url: `${site.origin}/q/1` } }, { signal: controller.signal });
    second.catch(() => {});
    await sleep(300);
    controller.abort("利用者が止めた");

    await first;
    await sleep(2000); // 取り消していなければ /q/1 が届いている時刻まで待つ

    expect(site.arrivals.get("/q/0")).toBe(1);
    expect(site.arrivals.get("/q/1")).toBeUndefined();
  }, 15_000);

  it("応答を待っている間に取り消したら、HTTP 取得を中止する", async () => {
    const site = await startSite(5_000);
    const client = await connectedClient();
    const controller = new AbortController();

    const call = client.callTool({ name: "fetch", arguments: { url: `${site.origin}/slow` } }, { signal: controller.signal });
    call.catch(() => {});
    // robots.txt の後の間隔(1秒)を待ってから送られる
    while (!site.arrivals.has("/slow")) await sleep(20);
    controller.abort("利用者が止めた");

    const startedAt = Date.now();
    while (site.abandoned.length === 0 && Date.now() - startedAt < 3_000) await sleep(20);
    expect(site.abandoned).toEqual(["/slow"]);
  }, 15_000);
});

// 同じ本文のページを同じホスト名(127.0.0.1)で何件も取るので、force_full で定型ブロックの学習による除去を外す。
describe("同じURLへ相乗りした呼び出しの取り消し", () => {
  it("一方だけが取り消しても、取り消していない呼び出しは本文を受け取り、取得は1回で済む", async () => {
    const site = await startSite(300);
    const url = `${site.origin}/shared`;
    const a = new AbortController();
    const b = new AbortController();

    const first = runCancellableBy(a.signal, () => handleFetchTool({ url, force_full: true }));
    first.catch(() => {});
    const second = runCancellableBy(b.signal, () => handleFetchTool({ url, force_full: true }));
    await sleep(100);
    a.abort();

    const content = await second;
    expect(content.map((c) => (c.type === "text" ? c.text : "")).join("\n")).toContain("CANCEL-MARKER");
    expect(site.arrivals.get("/shared")).toBe(1);
  }, 15_000);

  it("取り消せない呼び出し(CLI等)が相乗りしていれば、他の全員が取り消しても取得を続ける", async () => {
    const site = await startSite(300);
    const url = `${site.origin}/shared-cli`;
    const a = new AbortController();

    const first = runCancellableBy(a.signal, () => handleFetchTool({ url, force_full: true }));
    first.catch(() => {});
    const fromCli = handleFetchTool({ url, force_full: true });
    await sleep(100);
    a.abort();

    const content = await fromCli;
    expect(content.map((c) => (c.type === "text" ? c.text : "")).join("\n")).toContain("CANCEL-MARKER");
    expect(site.arrivals.get("/shared-cli")).toBe(1);
  }, 15_000);

  it("呼び出しの時点で既に取り消されていたら、先方へ送らずに取り消しとして返す", async () => {
    const site = await startSite();
    const controller = new AbortController();
    controller.abort();

    const error = await runCancellableBy(controller.signal, () => handleFetchTool({ url: `${site.origin}/pre`, force_full: true })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RequestCancelledError);
    await sleep(1500); // 取り消せない取得になっていれば、robots.txt の後の間隔(1秒)を空けて届く時刻
    expect(site.arrivals.get("/pre")).toBeUndefined();
  }, 15_000);

  it("全員が取り消したら取得を止め、取り消しとして返す", async () => {
    const site = await startSite(5_000);
    const url = `${site.origin}/shared-all`;
    const a = new AbortController();
    const b = new AbortController();

    const first = runCancellableBy(a.signal, () => handleFetchTool({ url, force_full: true })).catch((e: unknown) => e);
    const second = runCancellableBy(b.signal, () => handleFetchTool({ url, force_full: true })).catch((e: unknown) => e);
    while (!site.arrivals.has("/shared-all")) await sleep(20);
    a.abort();
    b.abort();

    expect(await first).toBeInstanceOf(RequestCancelledError);
    expect(await second).toBeInstanceOf(RequestCancelledError);
    const startedAt = Date.now();
    while (site.abandoned.length === 0 && Date.now() - startedAt < 3_000) await sleep(20);
    expect(site.abandoned).toEqual(["/shared-all"]);
  }, 15_000);
});
