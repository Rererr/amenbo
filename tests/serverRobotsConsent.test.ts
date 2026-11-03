import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * server.ts の robots.txt 例外取得の配線を、実際のMCP Client + InMemoryTransport(2025系の接続)で検証する。
 * 確認がクライアントの elicitation ハンドラ(=利用者の画面)へ届き、その答えだけで取得の可否が決まること。
 * 取得本体(core.ts)は、本物のrobots判定を通るだけの代役に差し替える。
 */
const httpGetMock = vi.fn();
const { robotsGate } = vi.hoisted(() => ({ robotsGate: { guard: async (_url: string): Promise<void> => {} } }));

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args) };
});

vi.mock("../src/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core.js")>();
  const fetched = (label: string) => async ({ url }: { url: string }) => {
    await robotsGate.guard(url);
    return [{ type: "text" as const, text: `${label}: ${url}` }];
  };
  return { ...actual, handleFetchTool: fetched("fetched"), handleScreenshotTool: fetched("captured") };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-server-robots-consent-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");
const { createServer } = await import("../src/server.js");
const { cache } = await import("../src/core.js");
const { PolitenessManager } = await import("../src/politeness.js");

afterAll(() => {
  cleanupCacheDir(cacheDir, () => cache.close());
});

const PAGE = "http://example.com/private/page";
type ElicitAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

beforeEach(() => {
  httpGetMock.mockReset().mockResolvedValue({
    finalUrl: "http://example.com/robots.txt",
    status: 200,
    headers: new Headers(),
    html: "User-agent: *\nDisallow: /private\n",
    encoding: "UTF-8",
  });
  const politeness = new PolitenessManager({ sleep: async () => {} });
  robotsGate.guard = (url) => politeness.guard(url);
});

/** answerを渡すと、確認フォームに対応したクライアントとして、その答えを返す。 */
async function connectedClient(answer?: ElicitAnswer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const asked: string[] = [];
  const client = new Client(
    { name: "amenbo-test-client", version: "1.0.0" },
    answer ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (answer) {
    client.setRequestHandler("elicitation/create", async (request) => {
      asked.push(String(request.params.message));
      return answer;
    });
  }
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
  return { client, asked };
}

function textOf(result: Awaited<ReturnType<InstanceType<typeof Client>["callTool"]>>): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? "";
}

describe("server.ts - robots.txt の例外取得(利用者の確認)", () => {
  it("ask_robots_override が無ければ確認を出さず、拒否を返す", async () => {
    const { client, asked } = await connectedClient({ action: "accept" });

    const result = await client.callTool({ name: "fetch", arguments: { url: PAGE } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/robots\.txt によりアクセスが拒否されています/);
    expect(asked).toHaveLength(0);
  });

  it.each([
    ["fetch", "fetched"],
    ["screenshot", "captured"],
  ])("%s: 利用者が画面で許可したら、robots.txt の拒否を外して取得する", async (tool, label) => {
    const { client, asked } = await connectedClient({ action: "accept" });

    const result = await client.callTool({ name: tool, arguments: { url: PAGE, ask_robots_override: true } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe(`${label}: ${PAGE}`);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(PAGE);
  });

  it("利用者が断ったら取得しない", async () => {
    const { client } = await connectedClient({ action: "decline" });

    const result = await client.callTool({ name: "fetch", arguments: { url: PAGE, ask_robots_override: true } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/利用者が例外の取得を許可しませんでした/);
  });

  it("確認に対応しないクライアントでは、理由を示して拒否する", async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({ name: "fetch", arguments: { url: PAGE, ask_robots_override: true } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/elicitation\)に対応していないため/);
  });

  it("ask_robots_override は fetch と screenshot にだけあり、ページを巡る links には無い", async () => {
    const { client } = await connectedClient();

    const { tools } = await client.listTools();
    const hasOverride = (name: string) =>
      Object.keys((tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {}) as Record<string, unknown>).includes("ask_robots_override");
    expect(hasOverride("fetch")).toBe(true);
    expect(hasOverride("screenshot")).toBe(true);
    expect(hasOverride("links")).toBe(false);
  });
});
