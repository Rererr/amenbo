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
