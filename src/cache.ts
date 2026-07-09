/**
 * cache.ts — better-sqlite3によるURL単位のローカルキャッシュ。
 *
 * 保存場所: $AMENBO_CACHE_DIR または ~/.cache/amenbo/cache.sqlite
 * URL毎にETag/Last-Modified/本文ハッシュ/変換済みMarkdown/取得時刻を保存する。
 * TTL内はローカル返却(fresh)、TTL超過時はIf-None-Match/If-Modified-Sinceで再検証し、
 * 304なら再変換せず返す(revalidated)。未キャッシュ/再検証不可はmiss。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

export type CacheStatus = "fresh" | "revalidated" | "miss";

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

function resolveDbPath(): string {
  const dir = process.env.AMENBO_CACHE_DIR ?? join(homedir(), ".cache", "amenbo");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "cache.sqlite");
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

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class PageCache {
  private readonly db: Database.Database;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { dbPath?: string; ttlMs?: number; now?: () => number } = {}) {
    this.db = new Database(options.dbPath ?? resolveDbPath());
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

  /** エントリがTTL内(再検証不要)かどうかを判定する。 */
  isFresh(entry: CacheEntry): boolean {
    return this.now() - entry.fetchedAt < this.ttlMs;
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
