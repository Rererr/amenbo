import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 同じホストへの待ち行列(waitTurn)の仕様。
 * - 並んだときの通知: 前の要求が残っていれば、前の件数と目安の秒数を1回知らせる
 * - 待ちの上限: 上限を超える待ちは、待たずに「次に取得できる時刻」を理由つきで返す。上限以下は今までどおり待つ
 * - 取り消し: 取り消された呼び出しは待たずに抜け、要求を記録しない。後ろの呼び出しの順番は崩さない
 */
const httpGetMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args) };
});

const { MAX_WAIT_MS, PolitenessManager, runCancellableBy } = await import("../src/politeness.js");
const { RequestCancelledError, WaitTooLongError } = await import("../src/errors.js");

function mockRobots(body: string): void {
  httpGetMock.mockResolvedValue({ finalUrl: "http://example.com/robots.txt", status: 200, headers: new Headers(), html: body, encoding: "UTF-8" });
}

function createClock() {
  let current = 1_000_000;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

/** 番が来ても戻らない sleep。並んだ呼び出しをその場に留め、待ち行列の長さだけを変数にする。 */
const sleepForever = (): Promise<void> => new Promise(() => {});

async function isStillPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  const result = await Promise.race([promise.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve(marker), 20))]);
  return result === marker;
}

beforeEach(() => {
  httpGetMock.mockReset();
});

describe("PolitenessManager - 順番待ちの通知", () => {
  it("前の要求が残った状態で並んだら、前の件数と目安の秒数を並んだ時点で1回通知する", async () => {
    mockRobots("User-agent: *\nCrawl-delay: 3\n");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepForever });
    const received = [vi.fn(), vi.fn(), vi.fn()];

    // robots.txt の取得(=1リクエスト)の直後から並ぶ。どの呼び出しも sleep から戻らないので、並んだままになる
    const calls = received.map((onProgress, i) => pm.waitTurn(`http://example.com/${i}`, onProgress));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received[0]!.mock.calls).toEqual([["アクセス間隔を確保するため待機しています…"]]);
    expect(received[1]!.mock.calls).toEqual([["同じサイト(example.com)への取得が前に1件あります。約6秒後に取得します…"]]);
    expect(received[2]!.mock.calls).toEqual([["同じサイト(example.com)への取得が前に2件あります。約9秒後に取得します…"]]);
    expect(await isStillPending(calls[2]!)).toBe(true);
  });

  it("前に並んでいる要求が無ければ、順番待ちの通知は出さない", async () => {
    mockRobots("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });
    const onProgress = vi.fn();

    await pm.waitTurn("http://example.com/a", onProgress);
    await pm.waitTurn("http://example.com/b", onProgress);

    expect(onProgress.mock.calls.flat().filter((message: string) => message.includes("前に"))).toEqual([]);
  });
});

describe("PolitenessManager - 待ちの上限", () => {
  it("上限は60秒", () => {
    expect(MAX_WAIT_MS).toBe(60_000);
  });

  it("上限以下の Crawl-delay は今までどおり待つ", async () => {
    mockRobots("User-agent: *\nCrawl-delay: 60\n");
    const clock = createClock();
    const sleep = vi.fn(clock.sleep);
    const pm = new PolitenessManager({ now: clock.now, sleep });

    await pm.guard("http://example.com/a");

    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("Crawl-delay が上限を超えるなら、待たずに次に取得できる時刻を理由つきで返す", async () => {
    mockRobots("User-agent: *\nCrawl-delay: 120\n");
    const clock = createClock();
    const sleep = vi.fn(clock.sleep);
    const pm = new PolitenessManager({ now: clock.now, sleep });

    const error = await pm.guard("http://example.com/a").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WaitTooLongError);
    const message = (error as Error).message;
    expect(message).toContain("このサイト(example.com)へはrobots.txt の Crawl-delay(120秒)のため、次に取得できるのは約2分後(");
    expect(message).toContain("amenbo は60秒を超えて待たずに中止しました。その時刻以降に取り直してください: http://example.com/a");
    expect(message).toContain(new Date(clock.now() + 120_000).toLocaleString("ja-JP", { timeZoneName: "short" }));
    expect(sleep).not.toHaveBeenCalled();
    expect(httpGetMock).toHaveBeenCalledTimes(1); // robots.txt だけで、本文には行っていない
  });

  it("setTimeout の上限(約24.8日)を超える Crawl-delay でも、待ちを1msに縮めて送らず、待たずに返す", async () => {
    mockRobots("User-agent: *\nCrawl-delay: 3000000\n");
    const clock = createClock();
    const sleep = vi.fn(clock.sleep);
    const pm = new PolitenessManager({ now: clock.now, sleep });

    await expect(pm.guard("http://example.com/a")).rejects.toThrow(WaitTooLongError);
    await expect(pm.guard("http://example.com/b")).rejects.toThrow(WaitTooLongError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("待ち行列の長さで上限を超えるなら、並ぶ前に、先に並んでいる件数を添えて返す", async () => {
    mockRobots("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepForever, minIntervalMs: 1000 });

    // robots.txt の取得(=1リクエスト)の直後から並ぶので、i 番目の待ちの目安は (i + 1) 秒
    const calls = Array.from({ length: 61 }, (_, i) => pm.waitTurn(`http://example.com/${i}`));

    const error = await calls[60]!.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WaitTooLongError);
    expect((error as Error).message).toContain("アクセス間隔(1秒)と、先に並んでいる60件の取得のため");
    expect(await isStillPending(calls[59]!)).toBe(true);
  });

  it("並んでいる間に別プロセスが同じホストへの要求を記録して待ちが上限を超えたら、番が来た時点で待たずに返す", async () => {
    httpGetMock.mockRejectedValue(new Error("robotsStore から読むのでネットワークへは行かない"));
    const clock = createClock();
    const sleep = vi.fn(clock.sleep);
    let otherProcessRequestedAt: number | null = null;
    const pm = new PolitenessManager({
      now: clock.now,
      sleep,
      robotsStore: { get: () => ({ body: "User-agent: *\nCrawl-delay: 120\n", fetchedAt: clock.now() }), set: () => {} },
      store: {
        getLastRequestAt: () => {
          // 並ぶ前の確認では未記録、番が来たときには別プロセスが記録済み
          const at = otherProcessRequestedAt;
          otherProcessRequestedAt = clock.now();
          return at;
        },
        setLastRequestAt: () => {},
      },
    });

    await expect(pm.waitTurn("http://example.com/a")).rejects.toThrow(WaitTooLongError);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("PolitenessManager - 取り消し", () => {
  /** 待ちを1件ずつ手で終わらせる sleep。 */
  function manualSleep(clock: ReturnType<typeof createClock>) {
    const pending: Array<() => void> = [];
    return {
      pending,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          pending.push(() => {
            void clock.sleep(ms);
            resolve();
          });
        }),
    };
  }

  function recordingStore() {
    const recorded: string[] = [];
    return { recorded, store: { getLastRequestAt: () => null, setLastRequestAt: (host: string) => void recorded.push(host) } };
  }

  it("番を待っている間に取り消されたら、待たずに抜けて要求を記録しない。後ろの呼び出しは前の呼び出しの後に進む", async () => {
    mockRobots("");
    const clock = createClock();
    const manual = manualSleep(clock);
    const { recorded, store } = recordingStore();
    const pm = new PolitenessManager({ now: clock.now, sleep: manual.sleep, store });
    const controller = new AbortController();

    const first = pm.waitTurn("http://example.com/a");
    const cancelled = runCancellableBy(controller.signal, () => pm.waitTurn("http://example.com/b")).catch((e: unknown) => e);
    const third = pm.waitTurn("http://example.com/c");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manual.pending).toHaveLength(1); // first だけが間隔の待機に入っている

    controller.abort();
    expect(await cancelled).toBeInstanceOf(RequestCancelledError);
    expect(await isStillPending(third)).toBe(true); // first の番が終わるまで third は進まない

    manual.pending.shift()!();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    manual.pending.shift()!();
    await third;

    expect(recorded).toHaveLength(3); // robots.txt、first、third。取り消した呼び出しは記録しない
  });

  it("間隔の待機中に取り消されたら、待ち終わりを待たずに抜けて要求を記録しない", async () => {
    mockRobots("");
    const clock = createClock();
    const { recorded, store } = recordingStore();
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepForever, store });
    const controller = new AbortController();

    const call = runCancellableBy(controller.signal, () => pm.waitTurn("http://example.com/a")).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    expect(await call).toBeInstanceOf(RequestCancelledError);
    expect(recorded).toHaveLength(1); // robots.txt だけ
  });

  it("取り消しの文脈の外(CLI等)では、今までどおり待って記録する", async () => {
    mockRobots("");
    const clock = createClock();
    const { recorded, store } = recordingStore();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, store });

    await pm.waitTurn("http://example.com/a");

    expect(recorded).toHaveLength(2);
  });
});
