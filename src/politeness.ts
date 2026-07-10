/**
 * politeness.ts — 収集先への低負荷を担保するpolitenessマネージャ。
 *
 * - robots.txt尊重(robots-parser)。取得結果はプロセス内でキャッシュ(TTL付き)
 * - Crawl-Delay尊重
 * - ドメイン毎の直列キュー + 既定最小間隔1秒
 */
import robotsParserImport from "robots-parser";
import { HttpStatusError, PrivateAddressError, RobotsDeniedError } from "./errors.js";
import { httpGet, USER_AGENT } from "./fetcher/http.js";

/**
 * robots-parser の同梱型定義(index.d.ts)は `declare module 'robots-parser';` という
 * shorthandアンビエント宣言と実宣言が同一ファイルに混在しており、"type": "module"環境の
 * NodeNext interop下ではdefault importが呼び出し不能な型に解決されてしまう(上流の型定義バグ)。
 * 実行時の挙動(module.exports = function)は正しいため、実体の形に合わせて明示的に型付けする。
 */
interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getMatchingLineNumber(url: string, ua?: string): number;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | null;
}

const robotsParser = robotsParserImport as unknown as (url: string, robotsTxt: string) => Robot;

const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_ROBOTS_TTL_MS = 60 * 60 * 1000; // 1時間
const ROBOTS_FETCH_TIMEOUT_MS = 5000;

interface RobotsCacheEntry {
  robots: Robot;
  fetchedAt: number;
}

/**
 * CLI併設対応: ドメイン毎の最終リクエスト時刻をプロセス間で共有するための永続化ストア。
 * CLIは1コマンド=1プロセスのためインメモリのlastRequestAtだけでは直列/最小間隔制御が
 * プロセスを跨いで機能しない。cache.ts(host_requestsテーブル)をこの形で注入する想定。
 *
 * code-reviewer指摘(重要な制約): waitTurn内の「store読み取り→待機時間の算出→sleep→
 * store書き込み」は、同一プロセス内ではlocks(直列キュー)で完全に直列化されるが、
 * 複数プロセス(MCPサーバー+複数のCLI実行等)が同一ホストへほぼ同時にこの一連の処理へ
 * 入った場合、プロセスを跨いだ排他制御は無い(read-modify-writeがアトミックではない)ため
 * 最小間隔がすり抜けうる。低負荷"優先"のベストエフォートな安全網であり、分散ロックのような
 * 複雑な再試行機構は追加しない(単一プロセス内の直列化という強い保証・低実装コストという
 * コンセプトを崩さないため)。cache.ts側のsetHostLastRequestAtはSQLのMAXで時刻の巻き戻りだけは
 * 防いでいるが、read-modify-writeの競合そのものは解消しない。
 */
export interface PolitenessStore {
  getLastRequestAt(host: string): number | null;
  setLastRequestAt(host: string, at: number): void;
}

export interface PolitenessOptions {
  /** ドメイン毎の最小リクエスト間隔(ミリ秒、既定1000ms)。robots.txtのCrawl-Delayがこれより長ければそちらを優先。 */
  minIntervalMs?: number;
  /** robots.txtキャッシュのTTL(ミリ秒、既定1時間)。 */
  robotsTtlMs?: number;
  /** テスト用の時刻取得関数差し替え。 */
  now?: () => number;
  /** テスト用のsleep関数差し替え。 */
  sleep?: (ms: number) => Promise<void>;
  /** 未指定時は従来通りインメモリのみでレート制御する(完全後方互換)。 */
  store?: PolitenessStore;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PolitenessManager {
  private readonly minIntervalMs: number;
  private readonly robotsTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly store: PolitenessStore | undefined;

  private readonly robotsCache = new Map<string, RobotsCacheEntry>();
  // N8: settledを持たせるのは、pruneStaleHostStateがまだ完了していない(=キューに並んでいる
  // 呼び出しがある)ロックを誤って消してしまうと直列化が壊れる(同一ホストへの同時呼び出しが
  // 追い越してしまう)ため。「完了済み」かつ「最終アクセスから十分時間が経っている」ロックのみ
  // 安全に削除できる。
  private readonly locks = new Map<string, { chain: Promise<void>; settled: boolean }>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(options: PolitenessOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.robotsTtlMs = options.robotsTtlMs ?? DEFAULT_ROBOTS_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.store = options.store;
  }

  /** robots.txtとレート制御の両方を確認し、アクセス可能になるまで待機する。拒否時はRobotsDeniedErrorを投げる。 */
  async guard(url: string): Promise<void> {
    await this.checkRobotsAllowed(url);
    await this.waitTurn(url);
  }

  /** robots.txtのみ確認する(waitTurnは行わない)。 */
  async checkRobotsAllowed(url: string): Promise<void> {
    const robots = await this.getRobots(url);
    if (robots && robots.isAllowed(url, USER_AGENT) === false) {
      throw new RobotsDeniedError(url);
    }
  }

  /** robots.txtが宣言するSitemap URLの一覧を返す(linksツールのsitemap優先探索用)。 */
  async getSitemaps(url: string): Promise<string[]> {
    const robots = await this.getRobots(url);
    return robots?.getSitemaps() ?? [];
  }

  /**
   * ドメイン毎の直列キュー+最小間隔(robots.txtのCrawl-Delay考慮)を適用して順番を待つ。
   * 直列キュー(locks)による直列化はプロセス内のみ有効。store(PolitenessStore)経由の
   * プロセス間共有はread-modify-writeがアトミックではないベストエフォート(PolitenessStoreの
   * JSDoc参照)。
   */
  async waitTurn(url: string): Promise<void> {
    this.pruneStaleHostState();
    const host = new URL(url).host;
    const crawlDelayMs = await this.getCrawlDelayMs(url);
    const intervalMs = Math.max(this.minIntervalMs, crawlDelayMs);

    const previousEntry = this.locks.get(host);
    const previous = previousEntry?.chain ?? Promise.resolve();
    let release: () => void = () => {};
    const ourTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = { chain: previous.then(() => ourTurn), settled: false };
    this.locks.set(host, entry);

    await previous;
    try {
      // CLI併設対応: インメモリのlastRequestAtとstore(プロセス間永続化)の値のうち新しい方を
      // 採用する。store未指定時はstoreLastAtが常に-Infinityになり従来通りの挙動になる。
      const memoryLastAt = this.lastRequestAt.get(host) ?? -Infinity;
      const storeLastAt = this.store?.getLastRequestAt(host) ?? -Infinity;
      const lastAt = Math.max(memoryLastAt, storeLastAt);
      const elapsed = this.now() - lastAt;
      if (elapsed < intervalMs) {
        await this.sleep(intervalMs - elapsed);
      }
      const requestAt = this.now();
      this.lastRequestAt.set(host, requestAt);
      this.store?.setLastRequestAt(host, requestAt);
    } finally {
      release();
      entry.settled = true;
    }
  }

  /**
   * N8: robotsCache/locks/lastRequestAtは訪問したホスト毎に1エントリずつ増え、長時間稼働する
   * MCPサーバープロセスでは無制限に増加しうる。robotsTtlMsを「エントリの生存期間」の目安として
   * 転用し、しばらく使われていないホストの状態を掃除する。
   *
   * locksは、まだ完了していない(settled=false)呼び出しが並んでいる可能性があるホストを
   * 誤って削除すると直列化が壊れる(新しい呼び出しが空のロックを掴んで先に進んでしまう)ため、
   * settled=trueのエントリのみ削除する。
   */
  private pruneStaleHostState(): void {
    const cutoff = this.now() - this.robotsTtlMs;

    for (const [host, lastAt] of this.lastRequestAt) {
      if (lastAt >= cutoff) continue;
      const lock = this.locks.get(host);
      if (!lock || lock.settled) {
        this.lastRequestAt.delete(host);
        this.locks.delete(host);
      }
    }

    for (const [origin, entry] of this.robotsCache) {
      if (entry.fetchedAt < cutoff) {
        this.robotsCache.delete(origin);
      }
    }
  }

  private async getCrawlDelayMs(url: string): Promise<number> {
    const robots = await this.getRobots(url);
    const delaySec = robots?.getCrawlDelay(USER_AGENT);
    return typeof delaySec === "number" && Number.isFinite(delaySec) ? delaySec * 1000 : 0;
  }

  private async getRobots(url: string): Promise<Robot | null> {
    this.pruneStaleHostState();
    const parsed = new URL(url);
    // 公開品質バグ修正: http(s)以外(file:等)はorigin(host)を持たず、new URL(url).origin が
    // "null" という文字列になる。素通りさせると `null/robots.txt` という不正なURLを
    // 組み立ててしまい、httpGet内部のguardPublicAddress(new URL())が生のTypeErrorを投げ、
    // それが下のcatchでAmenboErrorではないためstderrにスタックトレースを吐いていた。
    // 呼び出し元(server.ts/links.ts)が事前にassertHttpSchemeでスキーム検証している想定だが、
    // politeness.ts単体でも安全側に倒す(non-http(s)は「robots.txtの概念が無い」として扱う)。
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    const origin = parsed.origin;
    const cached = this.robotsCache.get(origin);
    if (cached && this.now() - cached.fetchedAt < this.robotsTtlMs) {
      return cached.robots;
    }

    const robotsUrl = `${origin}/robots.txt`;
    let body = "";
    try {
      const result = await httpGet(robotsUrl, { timeoutMs: ROBOTS_FETCH_TIMEOUT_MS });
      body = result.status === 200 ? result.html : "";
    } catch (error) {
      // M5: catchが広すぎるとSSRF拒否(PrivateAddressError)まで「robots.txtが取得できない
      // だけ」として握りつぶしてしまう問題があったため、PrivateAddressErrorは再送出する。
      //
      // 公開品質バグ修正: 一方で当初の修正はAmenboError全般(HttpStatusError等)まで
      // 再送出しており、robots.txtが存在しない(404)という極めて一般的なケースで
      // 「robots.txtが無いだけの普通のサイト」への通常のfetchすら失敗するようになって
      // いた(HttpStatusErrorは非2xx全般で投げられるため)。404/403/5xx等のHTTPエラーは
      // robots.txt不在の慣習的な扱い(=制限なし)としてそのまま静かに継続する
      // (ログも出さない。頻出するため公開ツールとしてノイズになる)。
      if (error instanceof PrivateAddressError) throw error;
      if (!(error instanceof HttpStatusError)) {
        console.error(`robots.txtの取得に失敗しました(制限なしとして扱います): ${robotsUrl}`, error);
      }
      body = "";
    }

    const robots = robotsParser(robotsUrl, body);
    this.robotsCache.set(origin, { robots, fetchedAt: this.now() });
    return robots;
  }
}
