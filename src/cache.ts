/**
 * cache.ts — node:sqlite(DatabaseSync)によるURL単位のローカルキャッシュ。
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
 *
 * Phase 4 テンプレート学習: ドメイン毎に直近ページのブロックハッシュ集合を domain_pages に
 * 記録し、直近N ページ全てに共通して出現したハッシュを定型ブロック(ヘッダ/フッタ/定型ナビ等)
 * と判定する(getTemplateBlockHashes)。除去処理自体はtemplateLearning.tsが行う。
 *
 * CLI併設対応: politenessのドメイン毎レート制御(直近リクエスト時刻)は元々プロセス内メモリ
 * のみで保持していたが、CLIは1コマンド=1プロセスのためプロセスを跨いで状態を引き継げず、
 * 短時間に連続実行すると同一ドメインへの最小間隔が守られない。host_requests テーブルへ
 * 最終リクエスト時刻を永続化し、PolitenessManagerのstoreオプションとして注入することで
 * MCPサーバー/CLIの複数プロセス間で共有する(再起動直後の連続アクセスも守れる副次効果あり)。
 * 同じ理由でrobots.txtの取得結果もrobots_cache テーブルへ永続化し、PolitenessManagerの
 * robotsStoreオプションとして注入する(CLIでの複数ページ一括収集時にコマンド毎の
 * robots.txt再取得を防ぐ)。journal_mode=WAL は複数プロセスからの同時アクセスを想定して設定している。
 *
 * node:sqliteの制約: better-sqlite3はNumber.MAX_SAFE_INTEGERを超えるINTEGER列を読むと
 * 例外を投げたが、node:sqliteは黙ってbigintを返す(上流の挙動差)。本ファイルの整数列
 * (fetched_at/last_request_at)は全てDate.now()由来でMAX_SAFE_INTEGERを超えないため、
 * number型へのキャストのみで安全に扱える。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
/** Phase 4テンプレート学習: 定型ブロック判定に使う「直近ページ数」の既定値。 */
const DEFAULT_TEMPLATE_RECENT_PAGES = 3;

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

interface DomainPageRow {
  domain: string;
  url: string;
  fetched_at: number;
  block_hashes: string;
}

interface HostRequestRow {
  host: string;
  last_request_at: number;
}

interface RobotsCacheRow {
  origin: string;
  body: string;
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
  private readonly db: DatabaseSync;
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private closed = false;

  constructor(options: { dbPath?: string; cacheDir?: string; ttlMs?: number; now?: () => number } = {}) {
    this.cacheDir = options.cacheDir ?? resolveCacheDir();
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
    this.db = new DatabaseSync(options.dbPath ?? join(this.cacheDir, "cache.sqlite"));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode = WAL");
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_pages (
        domain TEXT NOT NULL,
        url TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        block_hashes TEXT NOT NULL,
        PRIMARY KEY (domain, url)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_domain_pages_domain_fetched_at ON domain_pages (domain, fetched_at DESC)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_requests (
        host TEXT PRIMARY KEY,
        last_request_at INTEGER NOT NULL
      )
    `);
    // レビュー指摘対応: robots.txtの取得結果をhost_requestsと同じ考え方でプロセス間共有する。
    // CLIバルク収集(1コマンド=1プロセス)で、コマンド毎にrobots.txtを再取得してしまう
    // 低負荷原則違反への対応(PolitenessManagerのrobotsStoreオプションとして注入する)。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS robots_cache (
        origin TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
      )
    `);

    // M3: TTL超過削除・サイズ上限が無くディスクが無制限に増加する問題への対応。
    // 起動(コンストラクタ)のたびにTTL超過エントリを掃除する。
    this.pruneExpired();
  }

  /**
   * M3: TTL超過エントリを削除する(ディスク無制限増加の防止)。起動時に自動実行される。
   * screenshotsはSQLite行に加え、対応するPNGファイル(タイル)もあわせて削除する。
   */
  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;

    this.db.prepare("DELETE FROM pages WHERE fetched_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM domain_pages WHERE fetched_at < ?").run(cutoff);
    // code-reviewer指摘: host_requestsもM3の対象から漏れていた(訪問ホスト毎に1行増える
    // 無制限増加テーブルという点でdomain_pages等と同じ性質を持つため、他テーブルと一貫させる)。
    this.db.prepare("DELETE FROM host_requests WHERE last_request_at < ?").run(cutoff);

    const expiredScreenshots = this.db.prepare("SELECT * FROM screenshots WHERE fetched_at < ?").all(cutoff) as unknown as ScreenshotRow[];
    for (const row of expiredScreenshots) {
      const tilePaths = JSON.parse(row.tile_paths) as string[];
      for (const filePath of tilePaths) {
        try {
          rmSync(filePath, { force: true });
        } catch {
          // 既に削除済み等のファイルシステムエラーはベストエフォートで無視する
        }
      }
    }
    this.db.prepare("DELETE FROM screenshots WHERE fetched_at < ?").run(cutoff);
  }

  /** 保存済みエントリを取得する(TTL判定は行わない。判定は isFresh を使う)。 */
  get(url: string): CacheEntry | undefined {
    const row = this.db.prepare("SELECT * FROM pages WHERE url = ?").get(url) as PageRow | undefined;
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
    const row = this.db.prepare("SELECT * FROM screenshots WHERE cache_key = ?").get(cacheKey) as ScreenshotRow | undefined;
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

  /** Phase 4テンプレート学習: このページの(除去前・全)ブロックハッシュ集合をドメイン別に記録する。 */
  recordDomainPageBlocks(domain: string, url: string, blockHashes: string[]): void {
    this.db
      .prepare(
        `INSERT INTO domain_pages (domain, url, fetched_at, block_hashes)
         VALUES (@domain, @url, @fetchedAt, @blockHashes)
         ON CONFLICT(domain, url) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           block_hashes = excluded.block_hashes`,
      )
      .run({ domain, url, fetchedAt: this.now(), blockHashes: JSON.stringify(blockHashes) });
  }

  /**
   * 直近recentPages件のページ全てに共通して出現したブロックハッシュを定型ブロック
   * (ヘッダ/フッタ/定型ナビ等)とみなして返す。まだrecentPages件分のページ履歴が
   * 無い場合(コールドスタート)は誤除去を避けるため空集合を返す。
   */
  getTemplateBlockHashes(domain: string, recentPages: number = DEFAULT_TEMPLATE_RECENT_PAGES): Set<string> {
    const rows = this.db
      .prepare("SELECT * FROM domain_pages WHERE domain = ? ORDER BY fetched_at DESC LIMIT ?")
      .all(domain, recentPages) as unknown as DomainPageRow[];

    if (rows.length < recentPages) return new Set();

    const occurrenceCount = new Map<string, number>();
    for (const row of rows) {
      const hashes = JSON.parse(row.block_hashes) as string[];
      for (const hash of hashes) {
        occurrenceCount.set(hash, (occurrenceCount.get(hash) ?? 0) + 1);
      }
    }

    const templateHashes = new Set<string>();
    for (const [hash, count] of occurrenceCount) {
      if (count >= recentPages) templateHashes.add(hash);
    }
    return templateHashes;
  }

  /**
   * CLI併設対応: ホスト(例 "example.com")の最終リクエスト時刻を返す(未記録ならnull)。
   * PolitenessManagerのstoreオプションとして注入し、プロセス間でレート制御状態を共有するために使う。
   */
  getHostLastRequestAt(host: string): number | null {
    const row = this.db.prepare("SELECT * FROM host_requests WHERE host = ?").get(host) as HostRequestRow | undefined;
    return row ? row.last_request_at : null;
  }

  /**
   * ホストの最終リクエスト時刻を記録する。
   *
   * code-reviewer指摘: MCPサーバー/CLIの複数プロセスが同一ホストへほぼ同時にwaitTurnを
   * 実行すると、「読み取り→待機→書き込み」の3ステップがプロセス間でアトミックではないため
   * 後勝ちの書き込みが古い時刻で新しい時刻を上書きし、最小間隔がすり抜けうる
   * (完全な直列化はプロセス内のみ。プロセス間はベストエフォート。PolitenessManagerの
   * store JSDoc参照)。せめて時刻が巻き戻らないよう、SQL側でMAXを取って単調増加を保証する。
   */
  setHostLastRequestAt(host: string, at: number): void {
    this.db
      .prepare(
        `INSERT INTO host_requests (host, last_request_at)
         VALUES (@host, @lastRequestAt)
         ON CONFLICT(host) DO UPDATE SET last_request_at = MAX(last_request_at, excluded.last_request_at)`,
      )
      .run({ host, lastRequestAt: at });
  }

  /**
   * レビュー指摘対応: オリジン(例 "https://example.com")のrobots.txtキャッシュを返す
   * (未記録ならnull)。PolitenessManagerのrobotsStoreオプションとして注入し、プロセス間で
   * robots.txt取得結果を共有するために使う。TTL判定(robotsTtlMs)は呼び出し元(PolitenessManager)
   * がfetchedAtを見て行う(page cacheのttlMsとは別の時間軸のため、ここでは判定しない)。
   * 空bodyのrobots.txt(=制限なし)も正しい取得結果として保存されるため、
   * 「未記録(null)」と「空bodyの記録あり」は区別される。
   */
  getRobotsCache(origin: string): { body: string; fetchedAt: number } | null {
    const row = this.db.prepare("SELECT * FROM robots_cache WHERE origin = ?").get(origin) as RobotsCacheRow | undefined;
    return row ? { body: row.body, fetchedAt: row.fetched_at } : null;
  }

  /** オリジンのrobots.txt取得結果(本文+取得時刻)を記録する。既存があれば上書きする。 */
  setRobotsCache(origin: string, body: string, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO robots_cache (origin, body, fetched_at)
         VALUES (@origin, @body, @fetchedAt)
         ON CONFLICT(origin) DO UPDATE SET
           body = excluded.body,
           fetched_at = excluded.fetched_at`,
      )
      .run({ origin, body, fetchedAt });
  }

  /**
   * 冪等なclose。better-sqlite3のclose()は閉鎖済みでも安全だったが、node:sqliteは
   * "database is not open" を投げるため、CLIのfinallyとprocess 'exit'ハンドラの両方から
   * 呼ばれる二重close経路(core.ts参照)を自前のフラグで吸収する。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
