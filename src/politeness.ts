/**
 * politeness.ts — 収集先への低負荷を担保するpolitenessマネージャ。
 *
 * - robots.txt尊重(robots-parser)。取得結果はプロセス内でキャッシュ(TTL付き)し、
 *   robotsStore注入時はプロセス間でも共有する(CLI併設対応)。利用者が個別に許可した
 *   1回の取得(runIgnoringRobotsFor)の間だけ、許可したページと同じオリジンへの拒否を適用しない
 * - Crawl-Delay尊重。1回の呼び出しの最初の要求で、自分の番までの待ちが上限(MAX_WAIT_MS)を超えるときは、
 *   待たずに次に取得できる時刻を返す
 * - ドメイン毎の直列キュー + 既定最小間隔1秒
 * - 取得を断られた(429 / Retry-After)ホストへは、期限までアクセスしない
 */
import { AsyncLocalStorage } from "node:async_hooks";
import robotsParserImport from "robots-parser";
import {
  FetchTimeoutError,
  HostRefusedError,
  HttpStatusError,
  NETWORK_ERROR_KIND_LABELS,
  NetworkError,
  PrivateAddressError,
  RequestCancelledError,
  RobotsDeniedError,
  WaitTooLongError,
} from "./errors.js";
import { httpGet, USER_AGENT } from "./fetcher/http.js";
import { DEFAULT_ROBOTS_TTL_MS, MAX_ROBOTS_TTL_MS } from "./ttl.js";

/** 利用者が許可したページのオリジン。許可の範囲を、利用者が確認画面で見たサイトに限る。 */
const robotsOverrideScope = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * fnの実行中に限り、approvedUrlsと同じオリジンへのrobots.txtの拒否を適用しない。それ以外のオリジンへの
 * リダイレクトは利用者が見ていないので、通常どおり拒否する(呼び出し側が改めて確認する)。
 * レート制御とCrawl-Delayは維持する。呼び出してよいのは、利用者本人が各ページを許可した場合だけ。
 */
export function runIgnoringRobotsFor<T>(approvedUrls: readonly string[], fn: () => Promise<T>): Promise<T> {
  return robotsOverrideScope.run(new Set(approvedUrls.map((url) => new URL(url).origin)), fn);
}

/** 1回の呼び出し(rememberRefusalsの範囲)。最初の要求を送ったかを持つ。 */
const callScope = new AsyncLocalStorage<{ sentFirstRequest: boolean }>();

/** 呼び出し元(MCPのツール呼び出し)の取り消し。 */
const cancellationScope = new AsyncLocalStorage<AbortSignal>();

/**
 * fnの実行中、待ち行列の待機(guard/waitTurn)をsignalの取り消しで打ち切る。引数で渡さないのは、待ち行列に
 * 入る経路(fetch・screenshot・links・PDF)の関数すべてに通すことになるため(許可の範囲と同じく文脈に載せる)。
 */
export function runCancellableBy<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return cancellationScope.run(signal, fn);
}

/** 今の呼び出しの取り消し。HTTP取得へはこれを明示的に渡す。取り消しの文脈の外ではundefined。 */
export function currentCancellation(): AbortSignal | undefined {
  return cancellationScope.getStore();
}

/** promiseの完了を待つ。先に取り消されたらRequestCancelledErrorで抜ける(promise自体は止めない)。 */
async function unlessCancelled<T>(promise: Promise<T>, url: string, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new RequestCancelledError(url);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RequestCancelledError(url));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isOverriddenIn(approvedOrigins: ReadonlySet<string> | undefined, url: string): boolean {
  if (approvedOrigins === undefined) return false;
  try {
    return approvedOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

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
/** 断られたときに Retry-After が無ければ、この時間アクセスを止める。 */
export const DEFAULT_REFUSAL_COOLDOWN_MS = 30 * 60_000;
/** Retry-After が長すぎる値でも、止めるのはこの時間まで。 */
export const MAX_REFUSAL_COOLDOWN_MS = 24 * 60 * 60_000;
const ROBOTS_FETCH_TIMEOUT_MS = 5000;
/**
 * 1回の呼び出しで最初の要求を送る前に、自分の番を待つ時間の上限。超えるなら待たずに、次に取得できる時刻を
 * 返す(待つかどうかは呼び出し側が決める)。
 */
export const MAX_WAIT_MS = 60_000;
/**
 * 呼び出しの途中(ブラウザへの昇格・linksのフォールバック等、2回目以降の要求)の待ちの上限。途中で断ると、
 * 取り直すたびに最初の要求だけが先方へ届いて完了しない。Claude Codeの既定の打ち切り(stdioのMCPで
 * 応答も進捗も無いまま30分)を超える待ちは、待っても応答を返せないので断る(setTimeoutの上限もこれより長い)。
 */
export const MAX_FOLLOW_UP_WAIT_MS = 30 * 60_000;

interface RobotsCacheEntry {
  robots: Robot;
  fetchedAt: number;
  /** 既定(robotsTtlMs)より短く持つときだけ指定する。 */
  ttlMs?: number;
}

/** robots.txt に届かなかった(5xx・タイムアウト・接続断)ときの全面拒否を持つ時間。一時的な障害で長く止めず、1回の呼び出しの中では取り直さない長さ。 */
export const UNREACHABLE_ROBOTS_TTL_MS = 5 * 60_000;

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

/**
 * レビュー指摘対応: robots.txt取得結果をプロセス間で共有するための永続化ストア。
 * PolitenessStoreと同じ考え方で、cache.ts(robots_cacheテーブル)をこの形で注入する想定。
 * CLIは1コマンド=1プロセスのため、これが無いとREADME推奨の「CLIで複数ページ一括収集」時に
 * コマンド毎にrobots.txtを再取得してしまい低負荷原則に反する。
 */
export interface RobotsStore {
  get(origin: string): { body: string; fetchedAt: number } | null;
  set(origin: string, body: string, fetchedAt: number): void;
}

/** 断られたホストと期限を、MCPサーバーとCLIのプロセス間で共有する(cache.tsのhost_refusalsテーブル)。 */
export interface RefusalStore {
  getRefusedUntil(host: string): number | null;
  setRefusedUntil(host: string, until: number): void;
}

export interface PolitenessOptions {
  /** ドメイン毎の最小リクエスト間隔(ミリ秒、既定1000ms)。robots.txtのCrawl-Delayがこれより長ければそちらを優先。 */
  minIntervalMs?: number;
  /** robots.txtキャッシュのTTL(ミリ秒、既定1時間)。 */
  robotsTtlMs?: number;
  /** テスト用の時刻取得関数差し替え。 */
  now?: () => number;
  /** テスト用のsleep関数差し替え。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 未指定時は従来通りインメモリのみでレート制御する(完全後方互換)。 */
  store?: PolitenessStore;
  /** 未指定時は従来通りインメモリのみでrobots.txtをキャッシュする(完全後方互換)。 */
  robotsStore?: RobotsStore;
  /** 未指定時はインメモリのみで記録する。 */
  refusalStore?: RefusalStore;
}

/** robots.txt の取得失敗が「届かない」(RFC 9309 2.3.1.4)に当たるなら、その理由を返す。当たらなければ null。 */
function describeUnreachableRobots(error: unknown): string | null {
  if (error instanceof HttpStatusError && error.status >= 500) return `robots.txt が ${error.status} を返し規則を確認できない`;
  if (error instanceof FetchTimeoutError) return `robots.txt が ${error.timeoutMs / 1000} 秒以内に応答せず規則を確認できない`;
  if (error instanceof NetworkError) {
    const kind = error.kind === "unknown" ? "原因不明" : NETWORK_ERROR_KIND_LABELS[error.kind];
    return `robots.txt に接続できず(${kind})規則を確認できない`;
  }
  return null;
}

/** 取り消されたらタイマーを止める。そのときは解決しない(待ち終わりと区別できず要求を送ってしまうため)。 */
function crawlDelayMsOf(robots: Robot): number {
  const delaySec = robots.getCrawlDelay(USER_AGENT);
  return typeof delaySec === "number" && Number.isFinite(delaySec) ? delaySec * 1000 : 0;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => clearTimeout(timer);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export class PolitenessManager {
  private readonly minIntervalMs: number;
  private readonly robotsTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly store: PolitenessStore | undefined;
  private readonly robotsStore: RobotsStore | undefined;
  private readonly refusalStore: RefusalStore | undefined;
  private readonly refusedUntil = new Map<string, number>();

  private readonly robotsCache = new Map<string, RobotsCacheEntry>();
  /** robots.txt に届かず規則を確認できなかったオリジンと、その理由(全面拒否の理由に添える)。 */
  private readonly robotsUnreachable = new Map<string, string>();
  /** 取得中の robots.txt。新しいサイトへの同時の取得で、robots.txt を件数ぶん同時に取りに行かないため。 */
  private readonly robotsInFlight = new Map<string, Promise<Robot>>();
  // N8: settledを持たせるのは、pruneStaleHostStateがまだ完了していない(=キューに並んでいる
  // 呼び出しがある)ロックを誤って消してしまうと直列化が壊れる(同一ホストへの同時呼び出しが
  // 追い越してしまう)ため。「完了済み」かつ「最終アクセスから十分時間が経っている」ロックのみ
  // 安全に削除できる。
  private readonly locks = new Map<string, { chain: Promise<void>; settled: boolean }>();
  private readonly lastRequestAt = new Map<string, number>();
  /** ホストごとの、waitTurnに入って番が来ていない(または来て記録を終えていない)呼び出しの数。 */
  private readonly queued = new Map<string, number>();

  constructor(options: PolitenessOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.robotsTtlMs = options.robotsTtlMs ?? DEFAULT_ROBOTS_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.store = options.store;
    this.robotsStore = options.robotsStore;
    this.refusalStore = options.refusalStore;
  }

  /**
   * fnがサイトに断られて失敗したら(HttpStatusError.isRefusal)、そのホストを期限まで止めてから投げ直す。
   * LLMが同じサイトへ取得を繰り返しても、2回目以降は相手に届かない。
   * fnを1回の呼び出しとして扱い、待ちの上限(MAX_WAIT_MS)を最初の要求にだけ当てる(ツールの入口はすべてこれを通る)。
   */
  async rememberRefusals<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await (callScope.getStore() ? fn() : callScope.run({ sentFirstRequest: false }, fn));
    } catch (error) {
      this.noteRefusal(error);
      throw error;
    }
  }

  /** errorがサイトに断られたことを示すなら、そのホストを期限まで止める。それ以外は何もしない。 */
  noteRefusal(error: unknown): void {
    if (!(error instanceof HttpStatusError && error.isRefusal)) return;
    const cooldownMs = Math.min(error.retryAfterMs ?? DEFAULT_REFUSAL_COOLDOWN_MS, MAX_REFUSAL_COOLDOWN_MS);
    const host = new URL(error.url).host;
    const until = this.now() + cooldownMs;
    this.refusedUntil.set(host, Math.max(this.refusedUntil.get(host) ?? 0, until));
    this.refusalStore?.setRefusedUntil(host, until);
  }

  /** 止めているホストなら HostRefusedError を投げる。相手へ何か送る前に呼ぶ。 */
  assertNotRefused(url: string): void {
    const host = new URL(url).host;
    const until = Math.max(this.refusedUntil.get(host) ?? 0, this.refusalStore?.getRefusedUntil(host) ?? 0);
    const now = this.now();
    if (now < until) throw new HostRefusedError(url, host, until, now);
  }

  /** 転送先の確認(HttpGetOptions.checkRobots)。止めているホストと robots.txt の拒否を、どちらも相手へ送る前に止める。 */
  async checkRedirectTarget(url: string): Promise<void> {
    this.assertNotRefused(url);
    await this.checkRobotsAllowed(url);
  }

  /**
   * robots.txtとレート制御の両方を確認し、アクセス可能になるまで待機する。拒否時はRobotsDeniedErrorを投げる。
   * onProgress: MCP progress notifications用。待機が発生する場合のみ呼ばれる(待機0の場合は呼ばれない。waitTurn参照)。
   */
  async guard(url: string, onProgress?: ((message: string) => void) | undefined): Promise<void> {
    this.assertNotRefused(url);
    // robots.txtの取得は相乗りのため取り消せないので、取り消し済みならそれを始める前に抜ける。
    if (cancellationScope.getStore()?.aborted) throw new RequestCancelledError(url);
    // 範囲を呼ばれた時点で読むので、ツール呼び出しのawaitの連鎖からだけ呼ぶ。イベントのコールバックから
    // 呼ぶと、その資源を作った別の呼び出しの許可を読んでしまう(robotsCheckForThisCall参照)。
    if (!isOverriddenIn(robotsOverrideScope.getStore(), url)) await this.checkRobotsAllowed(url);
    await this.waitTurn(url, onProgress);
  }

  /** robots.txtのみ確認する(waitTurnは行わない)。 */
  async checkRobotsAllowed(url: string): Promise<void> {
    const robots = await this.getRobots(url);
    if (robots && robots.isAllowed(url, USER_AGENT) === false) {
      const unreachableReason = this.robotsUnreachable.get(new URL(url).origin);
      throw new RobotsDeniedError(url, unreachableReason === undefined ? undefined : `${unreachableReason}ため、全面拒否として扱います(RFC 9309)`);
    }
  }

  /**
   * リダイレクト先の確認に渡すrobots判定を作る。許可の有無は作った時点(=ツール呼び出しの中)で固定する。
   * 判定は後でブラウザのrouteハンドラ等から呼ばれ、そこではAsyncLocalStorageの値がブラウザを起動した
   * 呼び出しのものになる(実測)ため、呼ばれた時点で読むと許可が別の呼び出しへ漏れる。
   */
  robotsCheckForThisCall(): (url: string) => Promise<void> {
    const approvedOrigins = robotsOverrideScope.getStore();
    return async (url) => {
      this.assertNotRefused(url);
      if (!isOverriddenIn(approvedOrigins, url)) await this.checkRobotsAllowed(url);
    };
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
   * onProgress: 同じホストへの前の要求が残った状態で並んだとき(並んだ時点で1回)と、実際にsleepが発生するときに呼ばれる(待機0のときは呼ばれない)。
   */
  async waitTurn(url: string, onProgress?: ((message: string) => void) | undefined): Promise<void> {
    this.assertNotRefused(url);
    this.pruneStaleHostState();
    const host = new URL(url).host;
    const crawlDelayMs = await this.getCrawlDelayMs(url);
    const intervalMs = Math.max(this.minIntervalMs, crawlDelayMs);
    const signal = cancellationScope.getStore();
    const call = callScope.getStore();

    const pace = { url, host, intervalMs, crawlDelayMs, limitMs: call?.sentFirstRequest ? MAX_FOLLOW_UP_WAIT_MS : MAX_WAIT_MS };
    // 番が来てから断ると、そこまで待たせてしまう。先に並んでいる件数から目安を出し、並ぶ前に断る。
    const ahead = this.queued.get(host) ?? 0;
    const expectedWaitMs = Math.max(0, this.lastRequestAtOf(host) + intervalMs - this.now()) + ahead * intervalMs;
    this.assertWaitWithinLimit(pace, expectedWaitMs, ahead);
    if (ahead > 0) onProgress?.(`同じサイト(${host})への取得が前に${ahead}件あります。約${Math.ceil(expectedWaitMs / 1000)}秒後に取得します…`);

    const previousEntry = this.locks.get(host);
    const previous = previousEntry?.chain ?? Promise.resolve();
    let release: () => void = () => {};
    const ourTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = { chain: previous.then(() => ourTurn), settled: false };
    this.locks.set(host, entry);
    this.queued.set(host, ahead + 1);

    try {
      // 取り消されたら番を待たずに抜け、後ろの呼び出しを先へ進める(finallyで自分の番を手放す)。
      await unlessCancelled(previous, url, signal);
      const elapsed = this.now() - this.lastRequestAtOf(host);
      if (elapsed < intervalMs) {
        // 並んでいる間に別プロセスが同じホストへの要求を記録していると、目安より長くなりうる。
        this.assertWaitWithinLimit(pace, intervalMs - elapsed, 0);
        onProgress?.("アクセス間隔を確保するため待機しています…");
        await unlessCancelled(this.sleep(intervalMs - elapsed, signal), url, signal);
      }
      // 待っている間に、先に並んでいた同じホストへの取得が断られていることがある。
      this.assertNotRefused(url);
      this.noteRequest(host, this.now());
      if (call) call.sentFirstRequest = true;
    } finally {
      release();
      entry.settled = true;
      const remaining = (this.queued.get(host) ?? 1) - 1;
      if (remaining > 0) this.queued.set(host, remaining);
      else this.queued.delete(host);
    }
  }

  /**
   * CLI併設対応: インメモリのlastRequestAtとstore(プロセス間永続化)の値のうち新しい方を
   * 採用する。store未指定時はstore側が常に-Infinityになり従来通りの挙動になる。
   */
  private lastRequestAtOf(host: string): number {
    return Math.max(this.lastRequestAt.get(host) ?? -Infinity, this.store?.getLastRequestAt(host) ?? -Infinity);
  }

  /** 待ちが上限を超えるなら、待たずに次に取得できる時刻を添えて断る(setTimeoutの上限を超える待ちもここで止まる)。 */
  private assertWaitWithinLimit(
    pace: { url: string; host: string; intervalMs: number; crawlDelayMs: number; limitMs: number },
    waitMs: number,
    ahead: number,
  ): void {
    if (waitMs <= pace.limitMs) return;
    const pacing =
      pace.crawlDelayMs > this.minIntervalMs ? `robots.txt の Crawl-delay(${pace.crawlDelayMs / 1000}秒)` : `アクセス間隔(${pace.intervalMs / 1000}秒)`;
    const reason = ahead > 0 ? `${pacing}と、先に並んでいる${ahead}件の取得` : pacing;
    const now = this.now();
    throw new WaitTooLongError(pace.url, pace.host, reason, now + waitMs, now, pace.limitMs);
  }

  /** ホストへ1リクエスト発行したことを記録する(インメモリ + プロセス間共有ストア)。 */
  private noteRequest(host: string, at: number): void {
    this.lastRequestAt.set(host, at);
    this.store?.setLastRequestAt(host, at);
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

    for (const [host, until] of this.refusedUntil) {
      if (until <= this.now()) this.refusedUntil.delete(host);
    }

    for (const [origin, entry] of this.robotsCache) {
      if (this.now() - entry.fetchedAt >= (entry.ttlMs ?? this.robotsTtlFor(entry.robots))) {
        this.robotsCache.delete(origin);
      }
    }
  }

  private async getCrawlDelayMs(url: string): Promise<number> {
    const robots = await this.getRobots(url);
    return robots ? crawlDelayMsOf(robots) : 0;
  }

  /**
   * robots.txt を持つ期間。robots.txt の取得も1要求に数えるので、既定の期間がCrawl-delayより短いと、案内した時刻に
   * 取り直すたびに robots.txt を取り直してその1要求を使い、いつまでも完了しない。Crawl-delayの分だけ延ばす。
   */
  private robotsTtlFor(robots: Robot): number {
    return Math.max(this.robotsTtlMs, Math.min(MAX_ROBOTS_TTL_MS, this.robotsTtlMs + crawlDelayMsOf(robots)));
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
    if (cached && this.now() - cached.fetchedAt < (cached.ttlMs ?? this.robotsTtlFor(cached.robots))) {
      return cached.robots;
    }

    const inFlight = this.robotsInFlight.get(origin);
    if (inFlight) return inFlight;
    const loading = this.loadRobots(origin).finally(() => this.robotsInFlight.delete(origin));
    this.robotsInFlight.set(origin, loading);
    return loading;
  }

  /** robots.txt をストアかネットワークから読む。同じオリジンへの同時の呼び出しは getRobots が1本にまとめる。 */
  private async loadRobots(origin: string): Promise<Robot> {
    this.robotsUnreachable.delete(origin);

    // レビュー指摘対応: インメモリキャッシュに無い/TTL超過の場合、ネットワークへ行く前に
    // robotsStore(cache.tsのrobots_cacheテーブル。プロセス間共有)を確認する。ここで
    // 復元できれば別プロセス(CLIの前回実行等)が取得済みのrobots.txtを再利用でき、
    // CLIバルク収集時の再取得(=先方への追加負荷)を避けられる。空bodyの記録(robots.txt
    // 不在=制限なし)もfetchedAtの有無で「未記録」と区別して正しく復元する。
    const stored = this.robotsStore?.get(origin);
    if (stored) {
      const robots = robotsParser(`${origin}/robots.txt`, stored.body);
      if (this.now() - stored.fetchedAt < this.robotsTtlFor(robots)) {
        this.robotsCache.set(origin, { robots, fetchedAt: stored.fetchedAt });
        return robots;
      }
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
      // いた(HttpStatusErrorは非2xx全般で投げられるため)。404/403等のHTTPエラーは
      // robots.txt不在の慣習的な扱い(=制限なし)としてそのまま静かに継続する
      // (ログも出さない。頻出するため公開ツールとしてノイズになる)。
      if (error instanceof PrivateAddressError) throw error;
      // 名前が解決できないなら先方へは何も届いていない。robots.txtの拒否と取り違えて例外取得の確認を出さないよう、そのまま返す。
      if (error instanceof NetworkError && error.kind === "dns") throw error;
      // robots.txt への応答で断られたら、規則が読めないまま取りに行かず、ページの取得と同じく引く。
      if (error instanceof HttpStatusError && error.isRefusal) throw error;
      // RFC 9309: サーバーかネットワークのエラーで robots.txt に届かないときは全面拒否とみなす。一時的な障害で
      // 長く止めないよう短く持ち、プロセス間のストアにも残さない。
      const unreachableReason = describeUnreachableRobots(error);
      if (unreachableReason !== null) {
        const robots = robotsParser(robotsUrl, "User-agent: *\nDisallow: /\n");
        const fetchedAt = this.now();
        this.robotsUnreachable.set(origin, unreachableReason);
        this.robotsCache.set(origin, { robots, fetchedAt, ttlMs: UNREACHABLE_ROBOTS_TTL_MS });
        this.noteRequest(new URL(robotsUrl).host, fetchedAt);
        return robots;
      }
      if (!(error instanceof HttpStatusError)) {
        console.error(`robots.txtの取得に失敗しました(制限なしとして扱います): ${robotsUrl}`, error);
      }
      body = "";
    }

    const robots = robotsParser(robotsUrl, body);
    const fetchedAt = this.now();
    this.robotsCache.set(origin, { robots, fetchedAt });
    this.robotsStore?.set(origin, body, fetchedAt);
    // robots.txtの取得も先方への1リクエストなので、最終リクエスト時刻に数える。
    // ここを記録しないと、新規ホストの初回だけ「robots.txt取得 → 即座に本文取得」と
    // 連続2リクエストになり、掲げている最小間隔が実際には守られていなかった。
    // 待たずに記録するだけなので、遅くなるのはこの直後の本文取得1回分に限られる。
    this.noteRequest(new URL(robotsUrl).host, fetchedAt);
    return robots;
  }
}
