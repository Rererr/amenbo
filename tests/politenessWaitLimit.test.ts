import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 自分の番を待つ時間の上限。上限を超える待ちは、待たずに「次に取得できる時刻」を理由つきで返す。
 * 上限以下の待ちは今までどおり待つ。
 */
const httpGetMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args) };
});

const { MAX_WAIT_MS, PolitenessManager } = await import("../src/politeness.js");
const { WaitTooLongError } = await import("../src/errors.js");

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
