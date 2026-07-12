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

describe("PolitenessManager - waitTurn/guard onProgress(MCP progress notifications)", () => {
  it("実際に待機が発生する場合のみonProgressが呼ばれる", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1000 });
    const onProgress = vi.fn();

    await pm.waitTurn("http://example.com/a", onProgress);
    expect(onProgress).not.toHaveBeenCalled(); // 初回は待機0

    await pm.waitTurn("http://example.com/b", onProgress);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith("アクセス間隔を確保するため待機しています…");
  });

  it("onProgress未指定でも後方互換で動作する", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1000 });

    await expect(pm.waitTurn("http://example.com/a")).resolves.toBeUndefined();
    await expect(pm.waitTurn("http://example.com/b")).resolves.toBeUndefined();
  });

  it("guard()もwaitTurnへonProgressをそのまま伝搬する", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1000 });
    const onProgress = vi.fn();

    await pm.guard("http://example.com/a", onProgress);
    await pm.guard("http://example.com/b", onProgress);

    expect(onProgress).toHaveBeenCalledTimes(1);
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

  it("M5: robots.txt取得時にAmenboError(SSRF拒否等)が発生した場合は握りつぶさず再送出する", async () => {
    const { PrivateAddressError } = await import("../src/errors.js");
    httpGetMock.mockRejectedValue(new PrivateAddressError("http://example.com/robots.txt", "127.0.0.1"));
    const pm = new PolitenessManager({ sleep: async () => {} });
    await expect(pm.checkRobotsAllowed("http://example.com/anything")).rejects.toThrow(PrivateAddressError);
  });

  it("公開品質バグ修正: file:等のhttp(s)以外のURLはrobots.txtを取得しようとせず(=不正な`null/robots.txt`を組み立てず)許可扱いになる", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pm = new PolitenessManager({ sleep: async () => {} });

    // 修正前は new URL(url).origin が "null" になり、httpGet("null/robots.txt") 内部の
    // new URL() が生のTypeErrorを投げ、それがconsole.errorでスタックトレースごと
    // stderrに漏れていた。
    await expect(pm.checkRobotsAllowed("file:///etc/passwd")).resolves.toBeUndefined();

    expect(httpGetMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
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

// N8: robotsCache/locks/lastRequestAtは訪問ホスト毎に増える内部Mapで、以前は掃除する仕組みが
// 無く長時間稼働するプロセスで無制限に増加しうった。private実装詳細のテストになるため、
// 型安全性を犠牲にしたキャストで内部Mapを直接検査する(このファイル内の他のテストと同様、
// robots-parser等の上流型定義の都合で行っているキャストと同じ考え方)。
interface InternalPolitenessState {
  robotsCache: Map<string, { fetchedAt: number }>;
  locks: Map<string, { chain: Promise<void>; settled: boolean }>;
  lastRequestAt: Map<string, number>;
}

describe("PolitenessManager - N8: 内部状態(robotsCache/locks/lastRequestAt)の掃除", () => {
  it("robotsTtlMsを超えて未使用のホストの状態は、後続の呼び出しをきっかけに掃除される", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, minIntervalMs: 0, robotsTtlMs: 1000 });
    const internal = pm as unknown as InternalPolitenessState;

    await pm.waitTurn("http://a.example.com/");
    expect(internal.lastRequestAt.has("a.example.com")).toBe(true);
    expect(internal.robotsCache.has("http://a.example.com")).toBe(true);

    clock.advance(2000); // robotsTtlMs(1000ms)超過

    await pm.waitTurn("http://b.example.com/"); // 別ホストへの呼び出しがトリガーになり掃除される

    expect(internal.lastRequestAt.has("a.example.com")).toBe(false);
    expect(internal.locks.has("a.example.com")).toBe(false);
    expect(internal.robotsCache.has("http://a.example.com")).toBe(false);
    // 直近アクセスしたホストの状態は残る
    expect(internal.lastRequestAt.has("b.example.com")).toBe(true);
  });

  it("直列化中(settled=falseの)ロックは、最終アクセスが古くても削除しない(競合状態を防ぐ)", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, minIntervalMs: 0, robotsTtlMs: 1000 });
    const internal = pm as unknown as InternalPolitenessState;

    await pm.waitTurn("http://a.example.com/");
    clock.advance(2000);

    // 「まだ処理中(settled=false)」の状態を模す
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    internal.locks.set("a.example.com", { chain: pending, settled: false });

    await pm.waitTurn("http://b.example.com/");

    expect(internal.locks.has("a.example.com")).toBe(true);
    release();
  });
});

// CLI併設対応: CLIは1コマンド=1プロセスのため、ドメイン毎レート制御の状態をプロセス間で
// 共有する必要がある。storeオプション(cache.tsのhost_requestsテーブル相当)を注入した場合の挙動を検証する。
describe("PolitenessManager - store注入時のプロセス間レート制御共有", () => {
  function createFakeStore(): { getLastRequestAt: (host: string) => number | null; setLastRequestAt: (host: string, at: number) => void; data: Map<string, number> } {
    const data = new Map<string, number>();
    return {
      data,
      getLastRequestAt: (host) => data.get(host) ?? null,
      setLastRequestAt: (host, at) => {
        data.set(host, at);
      },
    };
  }

  it("store値がインメモリより新しい場合、store値を基準に待機が発生する", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const sleepSpy = vi.fn(clock.sleep);
    const store = createFakeStore();
    // 「別プロセスが300ms前にこのホストへアクセス済み」という状態を模す
    store.data.set("example.com", -300);
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepSpy, minIntervalMs: 1000, store });

    await pm.waitTurn("http://example.com/a");

    // インメモリのlastRequestAt(未記録=-Infinity)ではなくstore値(-300)を基準にするため、
    // 1000 - 300 = 700ms待機するはず
    expect(sleepSpy).toHaveBeenCalledWith(700);
  });

  it("リクエスト時刻の記録時にstoreへも書き込まれる", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const store = createFakeStore();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep, minIntervalMs: 1000, store });

    await pm.waitTurn("http://example.com/a");

    expect(store.data.get("example.com")).toBe(0);
  });

  it("store未指定時は従来通りインメモリのみで動作する(完全後方互換)", async () => {
    mockRobotsResponse("");
    const clock = createClock();
    const sleepSpy = vi.fn(clock.sleep);
    const pm = new PolitenessManager({ now: clock.now, sleep: sleepSpy, minIntervalMs: 1000 });

    await pm.waitTurn("http://example.com/a");
    expect(sleepSpy).not.toHaveBeenCalled();
    await pm.waitTurn("http://example.com/b");
    expect(sleepSpy).toHaveBeenCalledWith(1000);
  });
});

// レビュー指摘対応: CLIは1コマンド=1プロセスのため、robots.txt取得結果もプロセス間で
// 共有する必要がある(でなければCLIバルク収集時にコマンド毎に再取得してしまう)。
// robotsStoreオプション(cache.tsのrobots_cacheテーブル相当)を注入した場合の挙動を検証する。
describe("PolitenessManager - robotsStore注入時のプロセス間robots.txtキャッシュ共有", () => {
  function createFakeRobotsStore(): {
    get: (origin: string) => { body: string; fetchedAt: number } | null;
    set: (origin: string, body: string, fetchedAt: number) => void;
    data: Map<string, { body: string; fetchedAt: number }>;
  } {
    const data = new Map<string, { body: string; fetchedAt: number }>();
    return {
      data,
      get: (origin) => data.get(origin) ?? null,
      set: (origin, body, fetchedAt) => {
        data.set(origin, { body, fetchedAt });
      },
    };
  }

  it("robotsStoreに有効なキャッシュがあれば、ネットワークを引かずそこから復元する", async () => {
    const clock = createClock();
    const robotsStore = createFakeRobotsStore();
    // 「別プロセスが直近取得済み」という状態を模す
    robotsStore.data.set("http://example.com", { body: "User-agent: *\nDisallow: /admin\n", fetchedAt: clock.now() });
    const pm = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000, robotsStore });

    await expect(pm.checkRobotsAllowed("http://example.com/admin/x")).rejects.toThrow(RobotsDeniedError);
    expect(httpGetMock).not.toHaveBeenCalled();
  });

  it("ネットワーク取得結果はインメモリだけでなくrobotsStoreへも書き込まれる", async () => {
    mockRobotsResponse("User-agent: *\nDisallow: /admin\n");
    const clock = createClock();
    const robotsStore = createFakeRobotsStore();
    const pm = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000, robotsStore });

    await pm.checkRobotsAllowed("http://example.com/a");

    expect(robotsStore.data.get("http://example.com")?.body).toBe("User-agent: *\nDisallow: /admin\n");
    expect(httpGetMock).toHaveBeenCalledTimes(1);
  });

  it("2回目のgetRobotsは(インメモリキャッシュのTTL内なので)ネットワークを引かない", async () => {
    mockRobotsResponse("User-agent: *\nDisallow: /admin\n");
    const clock = createClock();
    const robotsStore = createFakeRobotsStore();
    const pm = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000, robotsStore });

    await pm.checkRobotsAllowed("http://example.com/a");
    await pm.checkRobotsAllowed("http://example.com/b");

    expect(httpGetMock).toHaveBeenCalledTimes(1);
  });

  it("別プロセス相当(新しいPolitenessManagerインスタンス)でも、共有したrobotsStoreからネットワークを引かず復元する", async () => {
    mockRobotsResponse("User-agent: *\nDisallow: /admin\n");
    const clock = createClock();
    const robotsStore = createFakeRobotsStore();
    const pmFirstProcess = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000, robotsStore });
    await pmFirstProcess.checkRobotsAllowed("http://example.com/a"); // 1回目のプロセスがネットワーク取得+robotsStoreへ書き込み
    httpGetMock.mockClear();

    const pmSecondProcess = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000, robotsStore });
    await expect(pmSecondProcess.checkRobotsAllowed("http://example.com/admin/x")).rejects.toThrow(RobotsDeniedError);

    expect(httpGetMock).not.toHaveBeenCalled(); // 別インスタンス(=別プロセス相当)でも再取得しない
  });

  it("空bodyのrobotsStoreキャッシュ(robots.txt不在=制限なし)からも正しく復元し、毎回ネットワークを引かない", async () => {
    const clock = createClock();
    const robotsStore = createFakeRobotsStore();
    robotsStore.data.set("http://example.com", { body: "", fetchedAt: clock.now() });
    const pm = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000, robotsStore });

    await expect(pm.checkRobotsAllowed("http://example.com/anything")).resolves.toBeUndefined();
    expect(httpGetMock).not.toHaveBeenCalled();
  });

  it("robotsStore未指定時は従来通りインメモリのみで動作する(完全後方互換)", async () => {
    mockRobotsResponse("User-agent: *\nDisallow: /admin\n");
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: async () => {}, robotsTtlMs: 60_000 });

    await pm.checkRobotsAllowed("http://example.com/a");
    await pm.checkRobotsAllowed("http://example.com/b");

    expect(httpGetMock).toHaveBeenCalledTimes(1);
  });
});
