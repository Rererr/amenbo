import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RobotsDeniedError } from "../src/errors.js";
import { setAddressPolicyForTests } from "../src/fetcher/http.js";
import { PolitenessManager, UNREACHABLE_ROBOTS_TTL_MS } from "../src/politeness.js";

/**
 * robots.txt の取得を、ループバックの実サーバー相手に実HTTPで確かめる。
 * タイムアウトや接続断がどの型のエラーになるかは実際の接続でしか決まらないので、httpGet をモックしない。
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handleRobots: Handler = (_req, res) => res.end("");
const robotsArrivals: number[] = [];
let server: Server;
let origin: string;

beforeAll(async () => {
  setAddressPolicyForTests(() => false);
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") {
      robotsArrivals.push(Date.now());
      handleRobots(req, res);
      return;
    }
    res.end("page");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  robotsArrivals.length = 0;
  handleRobots = (_req, res) => res.end("");
});

afterAll(async () => {
  setAddressPolicyForTests(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function storeSpy() {
  return { get: () => null, set: vi.fn<(origin: string, body: string, fetchedAt: number) => void>() };
}

describe("新しいサイトへの同時の取得", () => {
  it("異なるURLへ5件同時に始めても、robots.txt の取得は1回にまとまる", async () => {
    handleRobots = (_req, res) => {
      // 取得中に後続の呼び出しが重なるよう、少し遅らせて返す
      setTimeout(() => res.end("User-agent: *\nDisallow: /private/\n"), 50);
    };
    const pm = new PolitenessManager({ sleep: async () => {} });

    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => pm.guard(`${origin}/page/${n}`)));

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect(robotsArrivals).toHaveLength(1);
    await expect(pm.checkRobotsAllowed(`${origin}/private/x`)).rejects.toThrow(RobotsDeniedError);
    expect(robotsArrivals).toHaveLength(1);
  });

  it("まとめた取得が届かなかったら、相乗りした呼び出しもすべて全面拒否になる", async () => {
    handleRobots = (req) => setTimeout(() => req.socket.destroy(), 50);
    const pm = new PolitenessManager({ sleep: async () => {} });

    const results = await Promise.allSettled([1, 2, 3].map((n) => pm.checkRobotsAllowed(`${origin}/page/${n}`)));

    expect(results.every((r) => r.status === "rejected" && r.reason instanceof RobotsDeniedError)).toBe(true);
    expect(robotsArrivals).toHaveLength(1);
  });
});

describe("robots.txt に届かないとき(RFC 9309 2.3.1.4)", () => {
  it("接続を切られたら全面拒否とし、理由を示し、プロセス間のストアに残さない", async () => {
    handleRobots = (req) => req.socket.destroy();
    const robotsStore = storeSpy();
    const pm = new PolitenessManager({ sleep: async () => {}, robotsStore });

    const error = await pm.guard(`${origin}/page`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RobotsDeniedError);
    expect((error as Error).message).toContain("robots.txt に接続できず規則を確認できないため、全面拒否として扱います(RFC 9309)");
    expect(robotsStore.set).not.toHaveBeenCalled();
  });

  it("応答が返らずタイムアウトしたら全面拒否とし、プロセス間のストアに残さない", async () => {
    // 5秒のタイムアウトより長く保留する(応答しないサイトの再現)
    handleRobots = (_req, res) => {
      const timer = setTimeout(() => res.end(""), 6000);
      res.on("close", () => clearTimeout(timer));
    };
    const robotsStore = storeSpy();
    const pm = new PolitenessManager({ sleep: async () => {}, robotsStore });

    const error = await pm.guard(`${origin}/page`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RobotsDeniedError);
    expect((error as Error).message).toContain("robots.txt が 5 秒以内に応答せず規則を確認できないため、全面拒否として扱います(RFC 9309)");
    expect(robotsStore.set).not.toHaveBeenCalled();
  }, 15_000);

  it("全面拒否の間は robots.txt を取り直さず、期限を過ぎたら取り直して回復する", async () => {
    handleRobots = (req) => req.socket.destroy();
    let now = 1_000_000;
    const pm = new PolitenessManager({ now: () => now, sleep: async () => {} });

    await expect(pm.guard(`${origin}/page`)).rejects.toThrow(RobotsDeniedError);
    await expect(pm.guard(`${origin}/page`)).rejects.toThrow(RobotsDeniedError);
    expect(robotsArrivals).toHaveLength(1);

    handleRobots = (_req, res) => res.end("");
    now += UNREACHABLE_ROBOTS_TTL_MS;
    await expect(pm.guard(`${origin}/page`)).resolves.toBeUndefined();
    expect(robotsArrivals).toHaveLength(2);
  });
});
