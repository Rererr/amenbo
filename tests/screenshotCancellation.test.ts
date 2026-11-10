import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "../src/screenshot.js";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * 同じ画面写真の同時要求をまとめた処理(SharedOperations)にも、取り消しの扱いが効くこと。
 * 撮影そのもの(captureTiledScreenshot)は差し替え、待ち行列(politeness.guard)とrobots.txtの取得は本物を通す。
 */

const fakeCaptureResult: CaptureResult = {
  finalUrl: "http://127.0.0.1/",
  pageWidth: 1280,
  pageHeight: 1080,
  tiles: [{ geometry: { x: 0, y: 0, width: 1280, height: 1080 }, png: Buffer.from("fake-png") }],
  truncated: false,
};

const captureMock = vi.fn(async () => fakeCaptureResult);
vi.mock("../src/screenshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screenshot.js")>();
  return { ...actual, captureTiledScreenshot: captureMock };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-screenshot-cancellation-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { cache, handleScreenshotTool } = await import("../src/core.js");
const { runCancellableBy } = await import("../src/politeness.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");

let server: Server;
let origin: string;

beforeAll(async () => {
  setAddressPolicyForTests(() => false);
  // robots.txt だけを返す(撮影は差し替えているので、ページへは要求が来ない)
  server = createServer((_req, res) => res.end(""));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setAddressPolicyForTests(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupCacheDir(cacheDir, () => cache.close());
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("同じ画面写真の同時要求の取り消し", () => {
  it("一方だけが取り消しても、取り消していない呼び出しは画面写真を受け取り、撮影は1回で済む", async () => {
    captureMock.mockClear();
    const url = `${origin}/shot-shared`;
    const a = new AbortController();
    const b = new AbortController();

    // robots.txt の取得から1秒の間隔を空けて撮影するので、その間に一方を取り消す
    const first = runCancellableBy(a.signal, () => handleScreenshotTool({ url }));
    first.catch(() => {});
    const second = runCancellableBy(b.signal, () => handleScreenshotTool({ url }));
    await sleep(100);
    a.abort();

    const content = await second;
    expect(content.some((c) => c.type === "image")).toBe(true);
    expect(captureMock).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("全員が順番待ちの間に取り消したら、撮影せずに取り消しとして返す", async () => {
    const { RequestCancelledError } = await import("../src/errors.js");
    captureMock.mockClear();
    const url = `${origin}/shot-all`;
    const a = new AbortController();
    const b = new AbortController();

    const first = runCancellableBy(a.signal, () => handleScreenshotTool({ url })).catch((e: unknown) => e);
    const second = runCancellableBy(b.signal, () => handleScreenshotTool({ url })).catch((e: unknown) => e);
    await sleep(100);
    a.abort();
    b.abort();

    expect(await first).toBeInstanceOf(RequestCancelledError);
    expect(await second).toBeInstanceOf(RequestCancelledError);
    await sleep(1500); // 取り消せていなければ、間隔(1秒)の後に撮影している時刻
    expect(captureMock).not.toHaveBeenCalled();
  }, 15_000);
});
