import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeScreenshotCacheKey, PageCache } from "../src/cache.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amenbo-cache-test-"));
  dbPath = join(dir, "cache.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PageCache", () => {
  it("未キャッシュのURLはgetでundefinedを返す", () => {
    const cache = new PageCache({ dbPath });
    expect(cache.get("http://example.com/")).toBeUndefined();
    cache.close();
  });

  it("cacheDirを明示指定した場合、存在しなければ自動作成する", () => {
    const nestedDir = join(dir, "nested", "cache-dir");
    expect(existsSync(nestedDir)).toBe(false);
    const cache = new PageCache({ cacheDir: nestedDir });
    expect(existsSync(nestedDir)).toBe(true);
    cache.close();
  });

  it("setしたエントリをgetで取得できる", () => {
    const cache = new PageCache({ dbPath });
    cache.set({
      url: "http://example.com/",
      etag: "\"abc123\"",
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
      markdown: "# 見出し\n\n本文",
      metadata: { title: "テスト", finalUrl: "http://example.com/", tier: "http" },
    });

    const entry = cache.get("http://example.com/");
    expect(entry?.markdown).toBe("# 見出し\n\n本文");
    expect(entry?.etag).toBe("\"abc123\"");
    expect(entry?.metadata.title).toBe("テスト");
    cache.close();
  });

  it("TTL内はfresh判定になる", () => {
    let now = 1_000_000;
    const cache = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    cache.set({ url: "http://example.com/", etag: null, lastModified: null, markdown: "本文", metadata: {} });

    const entry = cache.get("http://example.com/");
    expect(entry).toBeDefined();
    now += 5 * 60 * 1000; // 5分経過(TTL15分以内)
    expect(cache.isFresh(entry!)).toBe(true);
    cache.close();
  });

  it("TTL超過後はfresh判定にならない(再検証が必要)", () => {
    let now = 1_000_000;
    const cache = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    cache.set({ url: "http://example.com/", etag: null, lastModified: null, markdown: "本文", metadata: {} });

    const entry = cache.get("http://example.com/");
    now += 16 * 60 * 1000; // 16分経過(TTL超過)
    expect(cache.isFresh(entry!)).toBe(false);
    cache.close();
  });

  it("touchはfetched_atのみ更新し本文は変更しない(304再検証時に再変換しない)", () => {
    let now = 1_000_000;
    const cache = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    cache.set({ url: "http://example.com/", etag: "\"v1\"", lastModified: null, markdown: "元の本文", metadata: {} });

    now += 20 * 60 * 1000;
    cache.touch("http://example.com/");

    const entry = cache.get("http://example.com/");
    expect(entry?.markdown).toBe("元の本文");
    expect(cache.isFresh(entry!)).toBe(true);
    cache.close();
  });

  it("同一URLへの再setは上書きされる", () => {
    const cache = new PageCache({ dbPath });
    cache.set({ url: "http://example.com/", etag: "\"v1\"", lastModified: null, markdown: "旧本文", metadata: {} });
    cache.set({ url: "http://example.com/", etag: "\"v2\"", lastModified: null, markdown: "新本文", metadata: {} });

    const entry = cache.get("http://example.com/");
    expect(entry?.markdown).toBe("新本文");
    expect(entry?.etag).toBe("\"v2\"");
    cache.close();
  });

  it("プロセスを跨いでも同じDBファイルであれば永続化されている", () => {
    const cache1 = new PageCache({ dbPath });
    cache1.set({ url: "http://example.com/", etag: null, lastModified: null, markdown: "永続化テスト", metadata: {} });
    cache1.close();

    const cache2 = new PageCache({ dbPath });
    const entry = cache2.get("http://example.com/");
    expect(entry?.markdown).toBe("永続化テスト");
    cache2.close();
  });
});

describe("PageCache - スクリーンショットキャッシュ", () => {
  it("未キャッシュのcacheKeyはgetScreenshotでundefinedを返す", () => {
    const cache = new PageCache({ dbPath, cacheDir: dir });
    expect(cache.getScreenshot("nonexistent")).toBeUndefined();
    cache.close();
  });

  it("setScreenshotはタイルをファイル保存し、パスをgetScreenshotで取得できる", () => {
    const cache = new PageCache({ dbPath, cacheDir: dir });
    const cacheKey = computeScreenshotCacheKey("http://example.com/", 1280, 1.0, true);
    const tile0 = Buffer.from([1, 2, 3]);
    const tile1 = Buffer.from([4, 5, 6]);

    cache.setScreenshot({ cacheKey, url: "http://example.com/", tiles: [tile0, tile1], metadata: { pageWidth: 1280, pageHeight: 2000 } });

    const entry = cache.getScreenshot(cacheKey);
    expect(entry?.tilePaths).toHaveLength(2);
    expect(entry?.tilePaths.every((p) => existsSync(p))).toBe(true);
    expect(readFileSync(entry!.tilePaths[0]!)).toEqual(tile0);
    expect(readFileSync(entry!.tilePaths[1]!)).toEqual(tile1);
    expect(entry?.metadata.pageWidth).toBe(1280);
    cache.close();
  });

  it("同じurl+パラメータのcacheKeyは決定的(同じキーになる)", () => {
    const a = computeScreenshotCacheKey("http://example.com/", 1280, 1.0, true);
    const b = computeScreenshotCacheKey("http://example.com/", 1280, 1.0, true);
    expect(a).toBe(b);
  });

  it("パラメータが異なればcacheKeyも異なる", () => {
    const a = computeScreenshotCacheKey("http://example.com/", 1280, 1.0, true);
    const b = computeScreenshotCacheKey("http://example.com/", 1280, 0.5, true);
    expect(a).not.toBe(b);
  });

  it("isFreshはスクリーンショットエントリにも使える", () => {
    let now = 1_000_000;
    const cache = new PageCache({ dbPath, cacheDir: dir, ttlMs: 15 * 60 * 1000, now: () => now });
    const cacheKey = computeScreenshotCacheKey("http://example.com/", 1280, 1.0, true);
    cache.setScreenshot({ cacheKey, url: "http://example.com/", tiles: [Buffer.from([1])], metadata: {} });

    const entry = cache.getScreenshot(cacheKey)!;
    now += 20 * 60 * 1000;
    expect(cache.isFresh(entry)).toBe(false);
    cache.close();
  });

  it("同じcacheKeyへの再setScreenshotは上書きされる", () => {
    const cache = new PageCache({ dbPath, cacheDir: dir });
    const cacheKey = computeScreenshotCacheKey("http://example.com/", 1280, 1.0, true);
    cache.setScreenshot({ cacheKey, url: "http://example.com/", tiles: [Buffer.from([1])], metadata: { v: 1 } });
    cache.setScreenshot({ cacheKey, url: "http://example.com/", tiles: [Buffer.from([2]), Buffer.from([3])], metadata: { v: 2 } });

    const entry = cache.getScreenshot(cacheKey);
    expect(entry?.tilePaths).toHaveLength(2);
    expect(entry?.metadata.v).toBe(2);
    cache.close();
  });
});

describe("PageCache - Phase 4 テンプレート学習(定型ブロック判定)", () => {
  it("直近ページ数(既定3件)に満たない場合は空集合を返す(コールドスタート)", () => {
    const cache = new PageCache({ dbPath });
    cache.recordDomainPageBlocks("example.com", "https://example.com/a", ["hashNav", "hashA"]);
    cache.recordDomainPageBlocks("example.com", "https://example.com/b", ["hashNav", "hashB"]);
    expect(cache.getTemplateBlockHashes("example.com")).toEqual(new Set());
    cache.close();
  });

  it("直近3ページ全てに共通するハッシュのみ定型ブロックと判定する", () => {
    const cache = new PageCache({ dbPath });
    cache.recordDomainPageBlocks("example.com", "https://example.com/a", ["hashNav", "hashFooter", "hashA"]);
    cache.recordDomainPageBlocks("example.com", "https://example.com/b", ["hashNav", "hashFooter", "hashB"]);
    cache.recordDomainPageBlocks("example.com", "https://example.com/c", ["hashNav", "hashFooter", "hashC"]);

    const templateHashes = cache.getTemplateBlockHashes("example.com");
    expect(templateHashes).toEqual(new Set(["hashNav", "hashFooter"]));
    cache.close();
  });

  it("一部のページにしか出現しないハッシュは定型ブロックと判定しない", () => {
    const cache = new PageCache({ dbPath });
    cache.recordDomainPageBlocks("example.com", "https://example.com/a", ["hashNav", "hashOnlyA"]);
    cache.recordDomainPageBlocks("example.com", "https://example.com/b", ["hashNav", "hashOnlyB"]);
    cache.recordDomainPageBlocks("example.com", "https://example.com/c", ["hashNav", "hashOnlyC"]);

    expect(cache.getTemplateBlockHashes("example.com")).toEqual(new Set(["hashNav"]));
    cache.close();
  });

  it("ドメインが異なれば独立して判定される", () => {
    const cache = new PageCache({ dbPath });
    for (const url of ["https://a.com/1", "https://a.com/2", "https://a.com/3"]) {
      cache.recordDomainPageBlocks("a.com", url, ["hashA"]);
    }
    for (const url of ["https://b.com/1", "https://b.com/2"]) {
      cache.recordDomainPageBlocks("b.com", url, ["hashB"]);
    }
    expect(cache.getTemplateBlockHashes("a.com")).toEqual(new Set(["hashA"]));
    expect(cache.getTemplateBlockHashes("b.com")).toEqual(new Set()); // b.comはまだ2件のみ
    cache.close();
  });

  it("M3: 起動時(コンストラクタ)にTTL超過したpagesエントリを削除する", () => {
    let now = 1_000_000;
    const cache1 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    cache1.set({ url: "http://example.com/old", etag: null, lastModified: null, markdown: "古い本文", metadata: {} });
    cache1.close();

    now += 20 * 60 * 1000; // TTL(15分)超過
    const cache2 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    expect(cache2.get("http://example.com/old")).toBeUndefined();
    cache2.close();
  });

  it("M3: TTL内のpagesエントリは起動時に削除されない", () => {
    let now = 1_000_000;
    const cache1 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    cache1.set({ url: "http://example.com/fresh", etag: null, lastModified: null, markdown: "新しい本文", metadata: {} });
    cache1.close();

    now += 5 * 60 * 1000; // TTL(15分)以内
    const cache2 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    expect(cache2.get("http://example.com/fresh")?.markdown).toBe("新しい本文");
    cache2.close();
  });

  it("M3: 起動時にTTL超過したscreenshotsエントリを削除し、対応するPNGファイルも削除する", () => {
    let now = 1_000_000;
    const cache1 = new PageCache({ dbPath, cacheDir: dir, ttlMs: 15 * 60 * 1000, now: () => now });
    const cacheKey = computeScreenshotCacheKey("http://example.com/", 1280, 1.0, true);
    cache1.setScreenshot({ cacheKey, url: "http://example.com/", tiles: [Buffer.from([1, 2, 3])], metadata: {} });
    const tilePath = cache1.getScreenshot(cacheKey)!.tilePaths[0]!;
    expect(existsSync(tilePath)).toBe(true);
    cache1.close();

    now += 20 * 60 * 1000; // TTL超過
    const cache2 = new PageCache({ dbPath, cacheDir: dir, ttlMs: 15 * 60 * 1000, now: () => now });
    expect(cache2.getScreenshot(cacheKey)).toBeUndefined();
    expect(existsSync(tilePath)).toBe(false); // PNGファイルもディスクから削除されている
    cache2.close();
  });

  it("直近3件を超えるとページ履歴が古いものから判定対象外になる", () => {
    let now = 1_000_000;
    const cache = new PageCache({ dbPath, now: () => now });
    cache.recordDomainPageBlocks("example.com", "https://example.com/1", ["hashOld"]);
    now += 1000;
    cache.recordDomainPageBlocks("example.com", "https://example.com/2", ["hashCommon"]);
    now += 1000;
    cache.recordDomainPageBlocks("example.com", "https://example.com/3", ["hashCommon"]);
    now += 1000;
    cache.recordDomainPageBlocks("example.com", "https://example.com/4", ["hashCommon"]);

    // 直近3件(2,3,4)には"hashOld"が含まれないため定型ブロック扱いされない
    expect(cache.getTemplateBlockHashes("example.com")).toEqual(new Set(["hashCommon"]));
    cache.close();
  });
});

// CLI併設対応: CLIは1コマンド=1プロセスのため、politenessのドメイン毎レート制御の状態を
// プロセス間で共有する必要がある。host_requestsテーブル(getHostLastRequestAt/setHostLastRequestAt)を検証する。
describe("PageCache - host_requests(politenessのプロセス間レート制御永続化)", () => {
  it("未記録のホストはgetHostLastRequestAtでnullを返す", () => {
    const cache = new PageCache({ dbPath });
    expect(cache.getHostLastRequestAt("example.com")).toBeNull();
    cache.close();
  });

  it("setHostLastRequestAtで記録した時刻をgetHostLastRequestAtで取得できる", () => {
    const cache = new PageCache({ dbPath });
    cache.setHostLastRequestAt("example.com", 12345);
    expect(cache.getHostLastRequestAt("example.com")).toBe(12345);
    cache.close();
  });

  it("同一ホストへの再setHostLastRequestAtは上書きされる", () => {
    const cache = new PageCache({ dbPath });
    cache.setHostLastRequestAt("example.com", 100);
    cache.setHostLastRequestAt("example.com", 200);
    expect(cache.getHostLastRequestAt("example.com")).toBe(200);
    cache.close();
  });

  it("code-reviewer指摘: 古い時刻でのsetHostLastRequestAtは時刻を巻き戻さない(SQL側でMAXを取る)", () => {
    // プロセス間のread-modify-write競合で「新しい時刻の書き込み」の後に「古い時刻の書き込み」が
    // 遅れて到着しても、レート制御の最小間隔が短くなる方向にすり抜けないようにするための保証。
    const cache = new PageCache({ dbPath });
    cache.setHostLastRequestAt("example.com", 200);
    cache.setHostLastRequestAt("example.com", 100);
    expect(cache.getHostLastRequestAt("example.com")).toBe(200);
    cache.close();
  });

  it("ホストが異なれば独立して記録される", () => {
    const cache = new PageCache({ dbPath });
    cache.setHostLastRequestAt("a.example.com", 111);
    cache.setHostLastRequestAt("b.example.com", 222);
    expect(cache.getHostLastRequestAt("a.example.com")).toBe(111);
    expect(cache.getHostLastRequestAt("b.example.com")).toBe(222);
    cache.close();
  });

  it("code-reviewer指摘: M3と一貫させ、起動時にTTL超過したhost_requestsエントリを削除する", () => {
    let now = 1_000_000;
    const cache1 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    cache1.setHostLastRequestAt("old.example.com", now);
    cache1.close();

    now += 20 * 60 * 1000; // TTL(15分)超過
    const cache2 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    expect(cache2.getHostLastRequestAt("old.example.com")).toBeNull();
    cache2.close();
  });

  it("M3: TTL内のhost_requestsエントリは起動時に削除されない", () => {
    let now = 1_000_000;
    const cache1 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    cache1.setHostLastRequestAt("fresh.example.com", now);
    cache1.close();

    now += 5 * 60 * 1000; // TTL(15分)以内
    const cache2 = new PageCache({ dbPath, ttlMs: 15 * 60 * 1000, now: () => now });
    expect(cache2.getHostLastRequestAt("fresh.example.com")).toBe(1_000_000);
    cache2.close();
  });

  it("プロセスを跨いでも同じDBファイルであれば永続化されている", () => {
    // M3(起動時TTL掃除)の対象にならないよう、実時刻に近い値を使う(999のような固定の
    // 小さい値だと既定TTL(15分)を起動時に必ず超過しており、掃除で消えてしまうため)。
    const recentTimestamp = Date.now();
    const cache1 = new PageCache({ dbPath });
    cache1.setHostLastRequestAt("example.com", recentTimestamp);
    cache1.close();

    const cache2 = new PageCache({ dbPath });
    expect(cache2.getHostLastRequestAt("example.com")).toBe(recentTimestamp);
    cache2.close();
  });
});
