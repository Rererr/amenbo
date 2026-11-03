import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * runWithTerminalRobotsConsent(CLI で robots.txt が拒否したページを、端末で利用者が許可した1回に限り取得する)。
 * runには本物のPolitenessManagerのrobots判定を使い、許可後の再実行で実際に拒否が外れることまで確かめる。
 */
const httpGetMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args) };
});

const { PolitenessManager } = await import("../src/politeness.js");
const { RobotsDeniedError } = await import("../src/errors.js");
const { askOnTerminal, runWithTerminalRobotsConsent } = await import("../src/terminalRobotsConsent.js");

const PAGE = "http://example.com/private/page";
let politeness: InstanceType<typeof PolitenessManager>;
let runCount: number;

async function fetchPage(): Promise<string> {
  runCount++;
  await politeness.guard(PAGE);
  return "fetched";
}

/** 同じページから別のサイトへ転送される取得の代役。 */
async function fetchRedirectingToOtherSite(): Promise<string> {
  await politeness.guard(PAGE);
  await politeness.robotsCheckForThisCall()("http://other.example.com/private/landing");
  return "fetched";
}

beforeEach(() => {
  httpGetMock.mockReset().mockResolvedValue({
    finalUrl: "http://example.com/robots.txt",
    status: 200,
    headers: new Headers(),
    html: "User-agent: *\nDisallow: /private\n",
    encoding: "UTF-8",
  });
  politeness = new PolitenessManager({ sleep: async () => {} });
  runCount = 0;
});

describe("runWithTerminalRobotsConsent", () => {
  it("--ask-robots-override が無ければ聞かずに拒否する", async () => {
    const ask = vi.fn(async () => true);

    await expect(runWithTerminalRobotsConsent(false, fetchPage, ask)).rejects.toThrow(RobotsDeniedError);
    expect(ask).not.toHaveBeenCalled();
  });

  it("端末で y が打たれたら、拒否されたURLを示したうえで robots.txt の拒否を外して取得し直す", async () => {
    const ask = vi.fn(async () => true);

    await expect(runWithTerminalRobotsConsent(true, fetchPage, ask)).resolves.toBe("fetched");
    expect(ask).toHaveBeenCalledWith(expect.stringContaining(PAGE));
    expect(runCount).toBe(2);
  });

  it("y の後に別のサイトへの転送先が拒否されたら、その URL を示して改めて聞く", async () => {
    const ask = vi.fn(async () => true);

    await expect(runWithTerminalRobotsConsent(true, fetchRedirectingToOtherSite, ask)).resolves.toBe("fetched");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenLastCalledWith(expect.stringContaining("http://other.example.com/private/landing"));
  });

  it("端末で y 以外が打たれたら取得しない", async () => {
    await expect(runWithTerminalRobotsConsent(true, fetchPage, async () => false)).rejects.toThrow(/利用者が例外の取得を許可しませんでした/);
    expect(runCount).toBe(1);
  });

  it("端末が無い(エージェントのシェル・パイプ)ときは、理由を示して拒否する", async () => {
    await expect(runWithTerminalRobotsConsent(true, fetchPage, async () => null)).rejects.toThrow(/端末で利用者に確認できないため/);
  });

  it("bot 対策をしている大手(一覧のドメイン)は、聞かずに対象外として拒否する", async () => {
    const ask = vi.fn(async () => true);
    const fetchBotProtected = async () => {
      await politeness.guard("https://www.google.com/private/search");
      return "fetched";
    };

    await expect(runWithTerminalRobotsConsent(true, fetchBotProtected, ask)).rejects.toThrow(/bot 対策で自動取得を断っているため、例外の取得の対象外です/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("robots.txt の拒否以外の失敗では聞かない", async () => {
    const ask = vi.fn(async () => true);

    await expect(runWithTerminalRobotsConsent(true, async () => Promise.reject(new Error("boom")), ask)).rejects.toThrow("boom");
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("askOnTerminal", () => {
  it("stdin か stderr が端末でなければ聞かずに null を返す", async () => {
    const stdinTty = process.stdin.isTTY;
    const stderrTty = process.stderr.isTTY;
    try {
      for (const [stdin, stderr] of [[false, true], [true, false], [false, false]] as const) {
        process.stdin.isTTY = stdin;
        process.stderr.isTTY = stderr;
        await expect(askOnTerminal("確認")).resolves.toBeNull();
      }
    } finally {
      process.stdin.isTTY = stdinTty;
      process.stderr.isTTY = stderrTty;
    }
  });
});
