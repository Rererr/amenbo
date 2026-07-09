/**
 * cache.ts — better-sqlite3によるURL単位のローカルキャッシュ。
 *
 * 保存場所: $AMENBO_CACHE_DIR または ~/.cache/amenbo/cache.sqlite
 * URL毎にETag/Last-Modified/本文ハッシュ/変換済みMarkdown/取得時刻を保存する。
 * TTL内はローカル返却(fresh)、TTL超過時はIf-None-Match/If-Modified-Sinceで再検証し、
 * 304なら再変換せず返す(revalidated)。未キャッシュ/再検証不可はmiss。
 *
 * スクリーンショット(screenshotツール/mode:auto→screenshot)もキャッシュ対象とする。
 * バイナリ本体はSQLiteに入れず、$AMENBO_CACHE_DIR/screenshots/配下にファイル保存し、
 * SQLiteにはそのパスのみを保存する(DBの肥大化を避けるため)。
 * 画像はレンダリング結果でありETag等の安価な再検証手段が無いため、TTLベースの
 * fresh/miss判定のみとする(revalidatedは無い)。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export type CacheStatus = "fresh" | "revalidated" | "miss";
export type ScreenshotCacheStatus = "fresh" | "miss";

export interface CacheEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  markdown: string;
  /** メタデータ(title/finalUrl/tier等)をJSON文字列として保存したものをパースした値。 */
  metadata: Record<string, unknown>;
  fetchedAt: number;
}

export interface CacheWriteInput {
  url: string;
  etag: string | null;
  lastModified: string | null;
  markdown: string;
  metadata: Record<string, unknown>;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15分

function resolveCacheDir(): string {
  const dir = process.env.AMENBO_CACHE_DIR ?? join(homedir(), ".cache", "amenbo");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

interface PageRow {
  url: string;
  etag: string | null;
  last_modified: string | null;
  content_hash: string;
  markdown: string;
  metadata: string;
  fetched_at: number;
}

interface ScreenshotRow {
  cache_key: string;
  url: string;
  tile_paths: string;
  metadata: string;
  fetched_at: number;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** スクリーンショットのキャッシュキー(url+撮影パラメータの組)を計算する。 */
export function computeScreenshotCacheKey(url: string, width: number, scale: number, fullPage: boolean): string {
  return hashContent(`${url}|w=${width}|s=${scale}|full=${fullPage}`);
}

export interface ScreenshotCacheEntry {
  cacheKey: string;
  url: string;
  tilePaths: string[];
  metadata: Record<string, unknown>;
  fetchedAt: number;
}

export interface ScreenshotWriteInput {
  cacheKey: string;
  url: string;
  tiles: Buffer[];
  metadata: Record<string, unknown>;
}

export class PageCache {
  private readonly db: Database.Database;
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { dbPath?: string; cacheDir?: string; ttlMs?: number; now?: () => number } = {}) {
    this.cacheDir = options.cacheDir ?? resolveCacheDir();
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
    this.db = new Database(options.dbPath ?? join(this.cacheDir, "cache.sqlite"));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY,
        etag TEXT,
        last_modified TEXT,
        content_hash TEXT NOT NULL,
        markdown TEXT NOT NULL,
        metadata TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS screenshots (
        cache_key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        tile_paths TEXT NOT NULL,
        metadata TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `);
  }

  /** 保存済みエントリを取得する(TTL判定は行わない。判定は isFresh を使う)。 */
  get(url: string): CacheEntry | undefined {
    const row = this.db.prepare<[string], PageRow>("SELECT * FROM pages WHERE url = ?").get(url);
    if (!row) return undefined;
    return {
      url: row.url,
      etag: row.etag,
      lastModified: row.last_modified,
      contentHash: row.content_hash,
      markdown: row.markdown,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      fetchedAt: row.fetched_at,
    };
  }

  /** エントリ(ページ/スクリーンショットいずれも可)がTTL内(再検証不要)かどうかを判定する。 */
  isFresh(entry: { fetchedAt: number }): boolean {
    return this.now() - entry.fetchedAt < this.ttlMs;
  }

  /** 保存済みスクリーンショットエントリを取得する(TTL判定は isFresh を使う)。 */
  getScreenshot(cacheKey: string): ScreenshotCacheEntry | undefined {
    const row = this.db.prepare<[string], ScreenshotRow>("SELECT * FROM screenshots WHERE cache_key = ?").get(cacheKey);
    if (!row) return undefined;
    return {
      cacheKey: row.cache_key,
      url: row.url,
      tilePaths: JSON.parse(row.tile_paths) as string[],
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      fetchedAt: row.fetched_at,
    };
  }

  /** スクリーンショットのタイル群をファイル保存し、パスをSQLiteへ記録する。 */
  setScreenshot(input: ScreenshotWriteInput): ScreenshotCacheEntry {
    const tileDir = join(this.cacheDir, "screenshots", input.cacheKey);
    mkdirSync(tileDir, { recursive: true });
    const tilePaths = input.tiles.map((buffer, index) => {
      const filePath = join(tileDir, `tile-${index}.png`);
      writeFileSync(filePath, buffer);
      return filePath;
    });

    const fetchedAt = this.now();
    this.db
      .prepare(
        `INSERT INTO screenshots (cache_key, url, tile_paths, metadata, fetched_at)
         VALUES (@cacheKey, @url, @tilePaths, @metadata, @fetchedAt)
         ON CONFLICT(cache_key) DO UPDATE SET
           url = excluded.url,
           tile_paths = excluded.tile_paths,
           metadata = excluded.metadata,
           fetched_at = excluded.fetched_at`,
      )
      .run({
        cacheKey: input.cacheKey,
        url: input.url,
        tilePaths: JSON.stringify(tilePaths),
        metadata: JSON.stringify(input.metadata),
        fetchedAt,
      });

    return { cacheKey: input.cacheKey, url: input.url, tilePaths, metadata: input.metadata, fetchedAt };
  }

  /** 新規取得結果を保存(既存があれば上書き)する。 */
  set(input: CacheWriteInput): CacheEntry {
    const contentHash = hashContent(input.markdown);
    const fetchedAt = this.now();
    this.db
      .prepare(
        `INSERT INTO pages (url, etag, last_modified, content_hash, markdown, metadata, fetched_at)
         VALUES (@url, @etag, @lastModified, @contentHash, @markdown, @metadata, @fetchedAt)
         ON CONFLICT(url) DO UPDATE SET
           etag = excluded.etag,
           last_modified = excluded.last_modified,
           content_hash = excluded.content_hash,
           markdown = excluded.markdown,
           metadata = excluded.metadata,
           fetched_at = excluded.fetched_at`,
      )
      .run({
        url: input.url,
        etag: input.etag,
        lastModified: input.lastModified,
        contentHash,
        markdown: input.markdown,
        metadata: JSON.stringify(input.metadata),
        fetchedAt,
      });
    return {
      url: input.url,
      etag: input.etag,
      lastModified: input.lastModified,
      contentHash,
      markdown: input.markdown,
      metadata: input.metadata,
      fetchedAt,
    };
  }

  /** 304再検証成功時: 本文は変えず取得時刻のみ更新する(再変換しない)。 */
  touch(url: string): void {
    this.db.prepare("UPDATE pages SET fetched_at = ? WHERE url = ?").run(this.now(), url);
  }

  close(): void {
    this.db.close();
  }
}
