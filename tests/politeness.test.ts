import { beforeEach, describe, expect, it, vi } from "vitest";

const httpGetMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args),
  };
});

const { PolitenessManager } = await import("../src/politeness.js");
const { RobotsDeniedError } = await import("../src/errors.js");

/** 実時間を待たずに経過時間だけを進める疑似クロック(sleepするとnow()も進む)。 */
function createClock(): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
  let current = 0;
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

function mockRobotsResponse(body: string, status = 200): void {
  httpGetMock.mockResolvedValue({
    finalUrl: "http://example.com/robots.txt",
    status,
    headers: new Headers(),
    html: body,
    encoding: "UTF-8",
  });
}

beforeEach(() => {
  httpGetMock.mockReset();
});

describe("PolitenessManager - waitTurn(ドメイン毎の直列キュー+最小間隔)", () => {
  it("同一ホストへの連続アクセスは既定の最小間隔(1秒)だけ待機する", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const sleepSpy = vi.fn(clock.sleep);
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepSpy, minIntervalMs: 1000 });

    await pm.waitTurn("http://example.com/a");
    expect(sleepSpy).not.toHaveBeenCalled();

    await pm.waitTurn("http://example.com/b");
    expect(sleepSpy).toHaveBeenCalledWith(1000);
  });

  it("同一ホストへの同時呼び出しは直列に処理される(順序が保たれる)", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1000 });

    const order: string[] = [];
    await Promise.all([
      pm.waitTurn("http://example.com/a").then(() => order.push("first")),
      pm.waitTurn("http://example.com/a").then(() => order.push("second")),
      pm.waitTurn("http://example.com/a").then(() => order.push("third")),
    ]);

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("異なるホストへのアクセスは互いに待機しない", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const sleepSpy = vi.fn(clock.sleep);
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepSpy, minIntervalMs: 1000 });

    await Promise.all([pm.waitTurn("http://a.example.com/"), pm.waitTurn("http://b.example.com/")]);

    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("robots.txtのCrawl-Delayが既定の最小間隔より長い場合はそちらを優先する", async () => {
    mockRobotsResponse("User-agent: *\nCrawl-delay: 3\n");
    const clock = createClock();
    const sleepSpy = vi.fn(clock.sleep);
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepSpy, minIntervalMs: 1000 });

    await pm.waitTurn("http://example.com/a");
    await pm.waitTurn("http://example.com/b");

    expect(sleepSpy).toHaveBeenCalledWith(3000);
  });
});

describe("PolitenessManager - checkRobotsAllowed / guard", () => {
  it("robots.txtで許可されたパスはRobotsDeniedErrorを投げない", async () => {
    mockRobotsResponse("User-agent: *\nDisallow: /admin\n");
    const pm = new PolitenessManager({ sleep: async () => {} });
    await expect(pm.checkRobotsAllowed("http://example.com/public")).resolves.toBeUndefined();
  });

  it("robots.txtで拒否されたパスはRobotsDeniedErrorを投げる", async () => {
    mockRobotsResponse("User-agent: *\nDisallow: /admin\n");
    const pm = new PolitenessManager({ sleep: async () => {} });
    await expect(pm.checkRobotsAllowed("http://example.com/admin/secret")).rejects.toThrow(RobotsDeniedError);
  });

  it("robots.txtが取得できない場合は許可されているものとして扱う", async () => {
    httpGetMock.mockRejectedValue(new Error("network error"));
    const pm = new PolitenessManager({ sleep: async () => {} });
    await expect(pm.checkRobotsAllowed("http://example.com/anything")).resolves.toBeUndefined();
  });

  it("robots.txtの取得結果はTTL内であれば再取得しない(キャッシュ)", async () => {
    mockRobotsResponse("User-agent: *\nDisallow: /admin\n");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000 });

    await pm.checkRobotsAllowed("http://example.com/a");
    await pm.checkRobotsAllowed("http://example.com/b");

    expect(httpGetMock).toHaveBeenCalledTimes(1);
  });
});

describe("PolitenessManager - getSitemaps(linksツールのsitemap優先探索用)", () => {
  it("robots.txtのSitemap宣言を返す", async () => {
    mockRobotsResponse("User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n");
    const pm = new PolitenessManager({ sleep: async () => {} });
    const sitemaps = await pm.getSitemaps("http://example.com/a");
    expect(sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("複数のSitemap宣言を全て返す", async () => {
    mockRobotsResponse("Sitemap: https://example.com/sitemap-news.xml\nSitemap: https://example.com/sitemap-pages.xml\n");
    const pm = new PolitenessManager({ sleep: async () => {} });
    const sitemaps = await pm.getSitemaps("http://example.com/a");
    expect(sitemaps).toEqual(["https://example.com/sitemap-news.xml", "https://example.com/sitemap-pages.xml"]);
  });

  it("Sitemap宣言が無い場合は空配列を返す", async () => {
    mockRobotsResponse("User-agent: *\nDisallow:\n");
    const pm = new PolitenessManager({ sleep: async () => {} });
    expect(await pm.getSitemaps("http://example.com/a")).toEqual([]);
  });
});
