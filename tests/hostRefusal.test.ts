import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * サイトに取得を断られた(429 / Retry-After)ホストへ、期限まで amenbo からアクセスしない仕組みの仕様。
 * LLM が同じサイトへの取得を繰り返しても、2回目以降は相手に届かないこと。
 */
const httpGetMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args) };
});

const { DEFAULT_REFUSAL_COOLDOWN_MS, MAX_REFUSAL_COOLDOWN_MS, PolitenessManager, runIgnoringRobotsFor, UNREACHABLE_ROBOTS_TTL_MS } = await import("../src/politeness.js");
const { HostRefusedError, HttpStatusError, parseRetryAfterMs, RobotsDeniedError } = await import("../src/errors.js");
const { PageCache } = await import("../src/cache.js");

const PAGE = "http://example.com/page";

function createClock() {
  let current = 1_000_000;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

beforeEach(() => {
  httpGetMock.mockReset().mockResolvedValue({ finalUrl: "http://example.com/robots.txt", status: 200, headers: new Headers(), html: "", encoding: "UTF-8" });
});

describe("HttpStatusError - サイトが断ってきたかの判定", () => {
  it.each([
    ["429", 429, null, true],
    ["Retry-After 付きの 503", 503, "120", true],
    ["Retry-After の無い 503", 503, null, false],
    ["403(権限が無いだけのページでも返る)", 403, null, false],
    ["404", 404, null, false],
  ])("%s → isRefusal=%s", (_label, status, retryAfter, expected) => {
    const error = new HttpStatusError(PAGE, status, "x", retryAfter);
    expect(error.isRefusal).toBe(expected);
    expect(error.message.includes("サイトが取得を断っています")).toBe(expected);
  });

  it("Retry-After は秒数とHTTP日付を読み、読めない値はnullにする", () => {
    const now = Date.parse("2026-11-04T00:00:00Z");
    expect(parseRetryAfterMs("120", now)).toBe(120_000);
    expect(parseRetryAfterMs("Wed, 04 Nov 2026 00:10:00 GMT", now)).toBe(600_000);
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });

  it.each([
    ["0", "0"],
    ["過去の日付", "Tue, 03 Nov 2026 00:00:00 GMT"],
    ["小数(Date.parse は過去の日付として読む)", "1.5"],
    ["負の数(Date.parse は過去の日付として読む)", "-1"],
  ])("待ち時間を示さない Retry-After(%s)は、指定が無いのと同じに扱う", (_label, value) => {
    const now = Date.parse("2026-11-04T00:00:00Z");
    expect(parseRetryAfterMs(value, now)).toBeNull();
    expect(new HttpStatusError(PAGE, 503, "x", value).isRefusal).toBe(false);
    expect(new HttpStatusError(PAGE, 429, "x", value).retryAfterMs).toBeNull();
  });
});

describe("PolitenessManager - 断られたホストを一時的に止める", () => {
  function refusedBy(status: number, retryAfter: string | null = null, url = PAGE) {
    return async (): Promise<never> => {
      throw new HttpStatusError(url, status, "x", retryAfter);
    };
  }

  it("429 で断られたら、既定の期限までそのホストへの guard を相手に届く前に止める", async () => {
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });

    await expect(pm.rememberRefusals(refusedBy(429))).rejects.toThrow(HttpStatusError);
    httpGetMock.mockClear();

    await expect(pm.guard("http://example.com/other")).rejects.toThrow(HostRefusedError);
    expect(httpGetMock).not.toHaveBeenCalled();

    clock.advance(DEFAULT_REFUSAL_COOLDOWN_MS);
    await expect(pm.guard("http://example.com/other")).resolves.toBeUndefined();
  });

  it("転送やブラウザへの切り替えで使う waitTurn も止める", async () => {
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });

    await expect(pm.rememberRefusals(refusedBy(429))).rejects.toThrow(HttpStatusError);
    await expect(pm.waitTurn(PAGE)).rejects.toThrow(HostRefusedError);
  });

  it("Retry-After があればその時間だけ止め、長すぎる値は上限で切る", async () => {
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });

    await expect(pm.rememberRefusals(refusedBy(503, "60"))).rejects.toThrow(HttpStatusError);
    clock.advance(59_000);
    await expect(pm.guard(PAGE)).rejects.toThrow(HostRefusedError);
    clock.advance(1_000);
    await expect(pm.guard(PAGE)).resolves.toBeUndefined();

    await expect(pm.rememberRefusals(refusedBy(429, String(10 * MAX_REFUSAL_COOLDOWN_MS / 1000)))).rejects.toThrow(HttpStatusError);
    clock.advance(MAX_REFUSAL_COOLDOWN_MS);
    await expect(pm.guard(PAGE)).resolves.toBeUndefined();
  });

  it("止めるのは断ってきたホストだけで、403 や 404 では止めない", async () => {
    const pm = new PolitenessManager({ sleep: async () => {} });

    await expect(pm.rememberRefusals(refusedBy(429, null, "http://refused.example.com/"))).rejects.toThrow(HttpStatusError);
    await expect(pm.rememberRefusals(refusedBy(403))).rejects.toThrow(HttpStatusError);
    await expect(pm.rememberRefusals(refusedBy(404))).rejects.toThrow(HttpStatusError);

    await expect(pm.guard(PAGE)).resolves.toBeUndefined();
    await expect(pm.guard("http://refused.example.com/x")).rejects.toThrow(HostRefusedError);
  });

  it("止めている間のエラーは、ホストと再開の時刻を示す", async () => {
    const pm = new PolitenessManager({ sleep: async () => {} });
    await expect(pm.rememberRefusals(refusedBy(429))).rejects.toThrow(HttpStatusError);

    await expect(pm.guard(PAGE)).rejects.toThrow(/このサイト\(example\.com\)に取得を断られたため、あと約30分\(.+まで\) amenbo からのアクセスを止めています/);
  });

  it("同じホストへ並んでいた取得は、待っている間に先の取得が断られたら、相手に届く前に止まる", async () => {
    let releaseSleep: (() => void) | undefined;
    let holdSleep = false;
    const pm = new PolitenessManager({
      minIntervalMs: 1000,
      sleep: () =>
        holdSleep
          ? new Promise<void>((resolve) => {
              releaseSleep = resolve;
            })
          : Promise.resolve(),
    });
    await pm.guard(PAGE);
    holdSleep = true;

    const queued = pm.guard("http://example.com/second");
    await vi.waitFor(() => expect(releaseSleep).toBeDefined());
    pm.noteRefusal(new HttpStatusError(PAGE, 429, "Too Many Requests"));
    releaseSleep?.();

    await expect(queued).rejects.toThrow(HostRefusedError);
  });

  it("転送先の確認(robotsCheckForThisCall / checkRedirectTarget)でも、止めているホストへは送らない", async () => {
    const pm = new PolitenessManager({ sleep: async () => {} });
    pm.noteRefusal(new HttpStatusError("http://www.example.com/x", 429, "x"));
    httpGetMock.mockClear();

    await expect(pm.robotsCheckForThisCall()("http://www.example.com/landing")).rejects.toThrow(HostRefusedError);
    await expect(pm.checkRedirectTarget("http://www.example.com/landing")).rejects.toThrow(HostRefusedError);
    await expect(pm.checkRedirectTarget(PAGE)).resolves.toBeUndefined();
  });

  it("robots.txt への応答で断られたら、制限なしとして進まずに断られたことを返し、ホストを止める", async () => {
    httpGetMock.mockReset().mockRejectedValue(new HttpStatusError("http://example.com/robots.txt", 429, "Too Many Requests"));
    const pm = new PolitenessManager({ sleep: async () => {} });

    await expect(pm.rememberRefusals(() => pm.guard(PAGE))).rejects.toThrow(HttpStatusError);
    await expect(pm.guard(PAGE)).rejects.toThrow(HostRefusedError);
  });

  it("robots.txt が 404 を返したときは、従来どおり制限なしとして進む", async () => {
    httpGetMock.mockReset().mockRejectedValue(new HttpStatusError("http://example.com/robots.txt", 404, "Not Found"));
    const pm = new PolitenessManager({ sleep: async () => {} });

    await expect(pm.guard(PAGE)).resolves.toBeUndefined();
  });

  it("期限はキャッシュに残り、別プロセス(MCPサーバーとCLI)でも止まる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amenbo-refusal-test-"));
    try {
      const clock = createClock();
      const storeOf = (cache: InstanceType<typeof PageCache>) => ({
        getRefusedUntil: (host: string) => cache.getHostRefusedUntil(host),
        setRefusedUntil: (host: string, until: number) => cache.setHostRefusedUntil(host, until),
      });
      const first = new PageCache({ dbPath: join(dir, "cache.sqlite"), now: clock.now });
      const server = new PolitenessManager({ now: clock.now, sleep: clock.sleep, refusalStore: storeOf(first) });
      await expect(server.rememberRefusals(refusedBy(429))).rejects.toThrow(HttpStatusError);
      first.close();

      const second = new PageCache({ dbPath: join(dir, "cache.sqlite"), now: clock.now });
      const cli = new PolitenessManager({ now: clock.now, sleep: clock.sleep, refusalStore: storeOf(second) });
      await expect(cli.guard(PAGE)).rejects.toThrow(HostRefusedError);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PageCache - host_refusals", () => {
  it("期限は短くならず、期限切れの行は掃除で消える", () => {
    const dir = mkdtempSync(join(tmpdir(), "amenbo-refusal-cache-test-"));
    try {
      let now = 0;
      const dbPath = join(dir, "cache.sqlite");
      const ttlMs = 1000;
      const c1 = new PageCache({ dbPath, ttlMs, now: () => now });
      c1.setHostRefusedUntil("example.com", 500);
      c1.setHostRefusedUntil("example.com", 100);
      expect(c1.getHostRefusedUntil("example.com")).toBe(500);
      expect(c1.getHostRefusedUntil("other.example.com")).toBeNull();
      c1.close();

      now = ttlMs + 1;
      const c2 = new PageCache({ dbPath, ttlMs, now: () => now });
      expect(c2.getHostRefusedUntil("example.com")).toBeNull();
      c2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PolitenessManager - robots.txt が 5xx を返したとき(RFC 9309)", () => {
  const unavailable = () => new HttpStatusError("http://example.com/robots.txt", 503, "Service Unavailable");

  it("規則を確認できないので全面拒否とし、理由を示す", async () => {
    httpGetMock.mockReset().mockRejectedValue(unavailable());
    const pm = new PolitenessManager({ sleep: async () => {} });

    await expect(pm.guard(PAGE)).rejects.toThrow(RobotsDeniedError);
    await expect(pm.guard(PAGE)).rejects.toThrow(/robots\.txt が 503 を返し規則を確認できないため、全面拒否として扱います\(RFC 9309\)/);
  });

  it("全面拒否は短い時間だけ持ち、その間は robots.txt を取り直さず、過ぎたら取り直して回復する", async () => {
    httpGetMock.mockReset().mockRejectedValueOnce(unavailable());
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });

    await expect(pm.guard(PAGE)).rejects.toThrow(RobotsDeniedError);
    await expect(pm.guard(PAGE)).rejects.toThrow(RobotsDeniedError);
    expect(httpGetMock).toHaveBeenCalledTimes(1);

    httpGetMock.mockResolvedValue({ finalUrl: "http://example.com/robots.txt", status: 200, headers: new Headers(), html: "", encoding: "UTF-8" });
    clock.advance(UNREACHABLE_ROBOTS_TTL_MS);
    await expect(pm.guard(PAGE)).resolves.toBeUndefined();
    expect(httpGetMock).toHaveBeenCalledTimes(2);
  });

  it("回復した後の通常の拒否には、5xx の理由を付けない", async () => {
    httpGetMock.mockReset().mockRejectedValueOnce(unavailable());
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });
    await expect(pm.guard(PAGE)).rejects.toThrow(RobotsDeniedError);

    httpGetMock.mockResolvedValue({ finalUrl: "http://example.com/robots.txt", status: 200, headers: new Headers(), html: "User-agent: *\nDisallow: /\n", encoding: "UTF-8" });
    clock.advance(UNREACHABLE_ROBOTS_TTL_MS);
    const error = await pm.guard(PAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RobotsDeniedError);
    expect((error as Error).message).not.toContain("RFC 9309");
  });

  it("利用者が許可した例外取得なら通り、その呼び出しの中で robots.txt を取り直さない", async () => {
    httpGetMock.mockReset().mockRejectedValue(unavailable());
    const pm = new PolitenessManager({ sleep: async () => {} });
    await expect(pm.guard(PAGE)).rejects.toThrow(RobotsDeniedError);

    await expect(runIgnoringRobotsFor([PAGE], () => pm.guard(PAGE))).resolves.toBeUndefined();
    expect(httpGetMock).toHaveBeenCalledTimes(1);
  });

  it("全面拒否はプロセス間のストアに残さない(別プロセスは自分で取り直す)", async () => {
    httpGetMock.mockReset().mockRejectedValue(unavailable());
    const set = vi.fn();
    const pm = new PolitenessManager({ sleep: async () => {}, robotsStore: { get: () => null, set } });

    await expect(pm.guard(PAGE)).rejects.toThrow(RobotsDeniedError);
    expect(set).not.toHaveBeenCalled();
  });
});
