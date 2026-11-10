import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 待ちの上限(60秒)は、1回の呼び出しで最初の要求を送る前だけに当てる。呼び出しの途中の待ち
 * (ブラウザへの昇格・linksのフォールバック)を断ると、取り直すたびに最初の要求だけが先方へ届いて完了しない。
 */
const httpGetMock = vi.fn();
const httpGetRoutedMock = vi.fn();
const fetchWithBrowserMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return {
    ...actual,
    httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args),
    httpGetRouted: (...args: Parameters<typeof actual.httpGetRouted>) => httpGetRoutedMock(...args),
  };
});

vi.mock("../src/fetcher/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/browser.js")>();
  return { ...actual, fetchWithBrowser: (...args: Parameters<typeof actual.fetchWithBrowser>) => fetchWithBrowserMock(...args) };
});

const { MAX_FOLLOW_UP_WAIT_MS, PolitenessManager } = await import("../src/politeness.js");
const { HttpStatusError, WaitTooLongError } = await import("../src/errors.js");
const { fetchPage } = await import("../src/fetcher/index.js");
const { discoverLinks } = await import("../src/links.js");

const SITE = "http://example.com";
const SPA_HTML = `<!DOCTYPE html><html><head><title>spa</title></head><body><div id="root"></div></body></html>`;
const PAGE_HTML = `<!DOCTYPE html><html><head><title>p</title></head><body><a href="/a">A</a><a href="/b">B</a></body></html>`;

function robots(body: string) {
  return { finalUrl: `${SITE}/robots.txt`, status: 200, headers: new Headers(), html: body, encoding: "UTF-8" };
}

function routedHtml(url: string, html: string) {
  return { kind: "html", status: 200, finalUrl: url, headers: new Headers(), html, encoding: "UTF-8" };
}

function createClock() {
  let current = 1_000_000;
  return {
    now: () => current,
    sleep: vi.fn(async (ms: number) => {
      current += ms;
    }),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

beforeEach(() => {
  httpGetMock.mockReset();
  httpGetRoutedMock.mockReset();
  fetchWithBrowserMock.mockReset().mockResolvedValue({ finalUrl: `${SITE}/spa`, html: "<p>rendered</p>", status: 200, geometry: { blocks: [] } });
});

describe("呼び出しの途中の待ち", () => {
  it("Crawl-delayが上限を超えるSPAでも、案内どおり時刻を過ぎて取り直せばブラウザへの昇格まで待って完了する", async () => {
    httpGetMock.mockResolvedValue(robots("User-agent: *\nCrawl-delay: 90\n"));
    httpGetRoutedMock.mockImplementation(async (url: string) => routedHtml(url, SPA_HTML));
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });
    const fetchOnce = () =>
      pm.rememberRefusals(async () => {
        await pm.guard(`${SITE}/spa`);
        return fetchPage(`${SITE}/spa`, { checkRobots: pm.robotsCheckForThisCall(), waitTurn: (u) => pm.waitTurn(u) });
      });

    await expect(fetchOnce()).rejects.toThrow(WaitTooLongError); // 最初の要求の前に断る
    expect(httpGetRoutedMock).not.toHaveBeenCalled();

    clock.advance(91_000);
    const result = await fetchOnce();

    expect(result).toMatchObject({ tier: "browser" });
    expect(httpGetRoutedMock).toHaveBeenCalledTimes(1);
    expect(fetchWithBrowserMock).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledWith(90_000);
  });

  it("linksでsitemapからページへフォールバックするときも、途中の待ちは断らずに完了する", async () => {
    httpGetMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/robots.txt")) return robots("User-agent: *\nCrawl-delay: 90\n");
      throw new HttpStatusError(url, 404, "Not Found");
    });
    httpGetRoutedMock.mockImplementation(async (url: string) => routedHtml(url, PAGE_HTML));
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });

    await expect(discoverLinks(`${SITE}/`, pm)).rejects.toThrow(WaitTooLongError);

    clock.advance(91_000);
    const result = await discoverLinks(`${SITE}/`, pm);

    expect(result.source).toBe("page");
    expect(result.links.map((l) => l.url)).toEqual([`${SITE}/a`, `${SITE}/b`]);
  });

  it("途中の待ちでも、MCP stdioの既定の打ち切り(30分)を超えるなら、要求を送らずに断る", async () => {
    // robots.txt は別プロセスが取得済み(この呼び出しの最初の要求は待たずに送れる)
    const clock = createClock();
    const pm = new PolitenessManager({
      now: clock.now,
      sleep: clock.sleep,
      robotsStore: { get: () => ({ body: "User-agent: *\nCrawl-delay: 3000000\n", fetchedAt: clock.now() }), set: () => {} },
    });

    const error = await pm
      .rememberRefusals(async () => {
        await pm.waitTurn(`${SITE}/a`);
        await pm.waitTurn(`${SITE}/b`);
      })
      .catch((e: unknown) => e);

    expect(MAX_FOLLOW_UP_WAIT_MS).toBe(30 * 60_000);
    expect(error).toBeInstanceOf(WaitTooLongError);
    expect((error as Error).message).toContain("amenbo は30分を超えて待たずに中止しました");
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("別の呼び出しの最初の要求には、改めて60秒の上限を当てる", async () => {
    httpGetMock.mockResolvedValue(robots("User-agent: *\nCrawl-delay: 90\n"));
    const clock = createClock();
    const pm = new PolitenessManager({ now: clock.now, sleep: clock.sleep });
    await pm.getSitemaps(`${SITE}/`); // robots.txt を先に取得し、間隔が空いた状態にする
    clock.advance(91_000);

    await pm.rememberRefusals(() => pm.waitTurn(`${SITE}/a`));
    await expect(pm.rememberRefusals(() => pm.waitTurn(`${SITE}/b`))).rejects.toThrow(WaitTooLongError);
  });
});

describe("WaitTooLongError - 次に取得できる時刻の示し方", () => {
  const now = Date.UTC(2026, 10, 10, 1, 0, 0);

  it("1日以上先なら日数で示し、時刻はタイムゾーン名を付けて書く", () => {
    const at = now + 3 * 24 * 60 * 60_000;
    const message = new WaitTooLongError(`${SITE}/a`, "example.com", "x", at, now, 60_000).message;

    expect(message).toContain(`次に取得できるのは約3日後(${new Date(at).toLocaleString("ja-JP", { timeZoneName: "short" })}頃)です`);
  });

  it("Dateで表せないほど先なら、時刻を書かず期間だけで示す(Invalid Date を出さない)", () => {
    const message = new WaitTooLongError(`${SITE}/a`, "example.com", "x", now + 1e20, now, 60_000).message;

    expect(message).not.toContain("Invalid Date");
    expect(message).toMatch(/次に取得できるのは約\d+日後です。/);
  });
});
