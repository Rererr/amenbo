import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageCache } from "../src/cache.js";

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
