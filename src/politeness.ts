/**
 * politeness.ts — 収集先への低負荷を担保するpolitenessマネージャ。
 *
 * - robots.txt尊重(robots-parser)。取得結果はプロセス内でキャッシュ(TTL付き)
 * - Crawl-Delay尊重
 * - ドメイン毎の直列キュー + 既定最小間隔1秒
 */
import robotsParserImport from "robots-parser";
import { RobotsDeniedError } from "./errors.js";
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

export interface PolitenessOptions {
  /** ドメイン毎の最小リクエスト間隔(ミリ秒、既定1000ms)。robots.txtのCrawl-Delayがこれより長ければそちらを優先。 */
  minIntervalMs?: number;
  /** robots.txtキャッシュのTTL(ミリ秒、既定1時間)。 */
  robotsTtlMs?: number;
  /** テスト用の時刻取得関数差し替え。 */
  now?: () => number;
  /** テスト用のsleep関数差し替え。 */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PolitenessManager {
  private readonly minIntervalMs: number;
  private readonly robotsTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly robotsCache = new Map<string, RobotsCacheEntry>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(options: PolitenessOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.robotsTtlMs = options.robotsTtlMs ?? DEFAULT_ROBOTS_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
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

  /** ドメイン毎の直列キュー+最小間隔(robots.txtのCrawl-Delay考慮)を適用して順番を待つ。 */
  async waitTurn(url: string): Promise<void> {
    const host = new URL(url).host;
    const crawlDelayMs = await this.getCrawlDelayMs(url);
    const intervalMs = Math.max(this.minIntervalMs, crawlDelayMs);

    const previous = this.locks.get(host) ?? Promise.resolve();
    let release: () => void = () => {};
    const ourTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      host,
      previous.then(() => ourTurn),
    );

    await previous;
    try {
      const lastAt = this.lastRequestAt.get(host) ?? -Infinity;
      const elapsed = this.now() - lastAt;
      if (elapsed < intervalMs) {
        await this.sleep(intervalMs - elapsed);
      }
      this.lastRequestAt.set(host, this.now());
    } finally {
      release();
    }
  }

  private async getCrawlDelayMs(url: string): Promise<number> {
    const robots = await this.getRobots(url);
    const delaySec = robots?.getCrawlDelay(USER_AGENT);
    return typeof delaySec === "number" && Number.isFinite(delaySec) ? delaySec * 1000 : 0;
  }

  private async getRobots(url: string): Promise<Robot | null> {
    const origin = new URL(url).origin;
    const cached = this.robotsCache.get(origin);
    if (cached && this.now() - cached.fetchedAt < this.robotsTtlMs) {
      return cached.robots;
    }

    const robotsUrl = `${origin}/robots.txt`;
    let body = "";
    try {
      const result = await httpGet(robotsUrl, { timeoutMs: ROBOTS_FETCH_TIMEOUT_MS });
      body = result.status === 200 ? result.html : "";
    } catch {
      // robots.txtが取得できない場合は「制限なし」として扱う(一般的な慣習)
      body = "";
    }

    const robots = robotsParser(robotsUrl, body);
    this.robotsCache.set(origin, { robots, fetchedAt: this.now() });
    return robots;
  }
}
