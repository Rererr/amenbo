import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MCP progress notifications: server.ts側の配線(progressToken有無での通知有無・
 * notifications/progress送出)を、実際のMCP Client + InMemoryTransportを使った統合テストで
 * 検証する(server.ts→core.tsのhandleFetchTool呼び出しはモックし、onProgressコールバックが
 * 実際にどう組み立てられて渡るかだけを見る。実ネットワーク/実ブラウザ起動は行わない)。
 */

const handleFetchToolMock = vi.fn();
const handleScreenshotToolMock = vi.fn();
const discoverLinksMock = vi.fn();

vi.mock("../src/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core.js")>();
  return {
    ...actual,
    handleFetchTool: (...args: Parameters<typeof actual.handleFetchTool>) => handleFetchToolMock(...args),
    handleScreenshotTool: (...args: Parameters<typeof actual.handleScreenshotTool>) => handleScreenshotToolMock(...args),
  };
});

vi.mock("../src/links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/links.js")>();
  return {
    ...actual,
    discoverLinks: (...args: Parameters<typeof actual.discoverLinks>) => discoverLinksMock(...args),
  };
});

// core.tsはモジュール読み込み時にPageCache(node:sqlite)を既定のキャッシュディレクトリに生成する
// 副作用を持つため、実ユーザーのキャッシュを汚さないよう一時ディレクトリへ退避してからimportする。
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-server-progress-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { server } = await import("../src/server.js");

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

beforeEach(() => {
  handleFetchToolMock.mockReset();
  handleScreenshotToolMock.mockReset();
  discoverLinksMock.mockReset();
});

async function connectedClient(): Promise<InstanceType<typeof Client>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "amenbo-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("server.ts - fetchツールのMCP progress notifications配線", () => {
  it("クライアントがprogressToken(onprogress)を指定した場合、core.tsのonProgress呼び出しがnotifications/progressとして届く", async () => {
    handleFetchToolMock.mockImplementation(async (input: { onProgress?: ((message: string) => void) | undefined }) => {
      input.onProgress?.("ブラウザで再取得しています…");
      input.onProgress?.("PDFを解析しています…");
      return [{ type: "text" as const, text: "ok" }];
    });

    const client = await connectedClient();
    const received: Array<{ progress: number; message?: string }> = [];

    const result = await client.callTool({ name: "fetch", arguments: { url: "https://example.com/" } }, undefined, {
      onprogress: (p) => {
        received.push({ progress: p.progress, message: p.message });
      },
    });

    expect(received).toEqual([
      { progress: 1, message: "ブラウザで再取得しています…" },
      { progress: 2, message: "PDFを解析しています…" },
    ]);
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);

    await client.close();
  });

  it("クライアントがonprogressを指定しない場合、core.tsへ渡るonProgressはundefinedのまま(通知は一切発生しない)", async () => {
    let capturedOnProgress: unknown = "not-called";
    handleFetchToolMock.mockImplementation(async (input: { onProgress?: ((message: string) => void) | undefined }) => {
      capturedOnProgress = input.onProgress;
      return [{ type: "text" as const, text: "ok" }];
    });

    const client = await connectedClient();
    await client.callTool({ name: "fetch", arguments: { url: "https://example.com/" } });

    expect(capturedOnProgress).toBeUndefined();

    await client.close();
  });
});

describe("server.ts - screenshotツールのMCP progress notifications配線", () => {
  it("progressTokenを指定した場合、core.tsのonProgress呼び出しがnotifications/progressとして届く", async () => {
    handleScreenshotToolMock.mockImplementation(async (input: { onProgress?: ((message: string) => void) | undefined }) => {
      input.onProgress?.("スクリーンショットを撮影しています…");
      return [{ type: "text" as const, text: "ok" }];
    });

    const client = await connectedClient();
    const received: Array<{ progress: number; message?: string }> = [];

    await client.callTool({ name: "screenshot", arguments: { url: "https://example.com/" } }, undefined, {
      onprogress: (p) => {
        received.push({ progress: p.progress, message: p.message });
      },
    });

    expect(received).toEqual([{ progress: 1, message: "スクリーンショットを撮影しています…" }]);

    await client.close();
  });

  it("onprogress未指定の場合、core.tsへ渡るonProgressはundefinedのまま(通知は一切発生しない)", async () => {
    let capturedOnProgress: unknown = "not-called";
    handleScreenshotToolMock.mockImplementation(async (input: { onProgress?: ((message: string) => void) | undefined }) => {
      capturedOnProgress = input.onProgress;
      return [{ type: "text" as const, text: "ok" }];
    });

    const client = await connectedClient();
    await client.callTool({ name: "screenshot", arguments: { url: "https://example.com/" } });

    expect(capturedOnProgress).toBeUndefined();

    await client.close();
  });
});

describe("server.ts - linksツールのMCP progress notifications配線", () => {
  it("progressTokenを指定した場合、discoverLinksのonProgress呼び出しがnotifications/progressとして届く", async () => {
    discoverLinksMock.mockImplementation(async (_url: string, _politeness: unknown, options: { onProgress?: ((message: string) => void) | undefined }) => {
      options.onProgress?.("アクセス間隔を確保するため待機しています…");
      return { source: "page" as const, links: [], truncated: false };
    });

    const client = await connectedClient();
    const received: Array<{ progress: number; message?: string }> = [];

    await client.callTool({ name: "links", arguments: { url: "https://example.com/" } }, undefined, {
      onprogress: (p) => {
        received.push({ progress: p.progress, message: p.message });
      },
    });

    expect(received).toEqual([{ progress: 1, message: "アクセス間隔を確保するため待機しています…" }]);

    await client.close();
  });

  it("onprogress未指定の場合、discoverLinksへ渡るonProgressはundefinedのまま(通知は一切発生しない。CLI経路と同じ後方互換の形)", async () => {
    let capturedOnProgress: unknown = "not-called";
    discoverLinksMock.mockImplementation(async (_url: string, _politeness: unknown, options: { onProgress?: ((message: string) => void) | undefined }) => {
      capturedOnProgress = options.onProgress;
      return { source: "page" as const, links: [], truncated: false };
    });

    const client = await connectedClient();
    await client.callTool({ name: "links", arguments: { url: "https://example.com/" } });

    expect(capturedOnProgress).toBeUndefined();

    await client.close();
  });
});
