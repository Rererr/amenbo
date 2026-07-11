import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "../src/screenshot.js";

/**
 * MCP progress notifications: resolveScreenshot(screenshotツール/fetchツールのscreenshot経路
 * 共通)は、キャッシュmissで実際に撮影する直前にのみonProgressを呼ぶ(fresh cache時は呼ばない)。
 * politenessGuardCount.test.tsと同様、captureTiledScreenshotをモックして実ブラウザ起動を避ける。
 */

const fakeCaptureResult: CaptureResult = {
  finalUrl: "https://example.com/",
  pageWidth: 1280,
  pageHeight: 1080,
  tiles: [{ geometry: { x: 0, y: 0, width: 1280, height: 1080 }, png: Buffer.from("fake-png") }],
  truncated: false,
};

vi.mock("../src/screenshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screenshot.js")>();
  return {
    ...actual,
    captureTiledScreenshot: vi.fn(async () => fakeCaptureResult),
  };
});

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-screenshot-progress-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { handleScreenshotTool, politeness } = await import("../src/core.js");

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("resolveScreenshot - onProgress(MCP progress notifications)", () => {
  let guardSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    guardSpy = vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
  });

  afterEach(() => {
    guardSpy.mockRestore();
  });

  it("撮影開始直前に進捗通知が送られる", async () => {
    const onProgress = vi.fn();
    await handleScreenshotTool({ url: "https://example.com/unique-progress-1", onProgress });

    expect(onProgress).toHaveBeenCalledWith("スクリーンショットを撮影しています…");
  });

  it("onProgress未指定でも後方互換で動作する", async () => {
    await expect(handleScreenshotTool({ url: "https://example.com/unique-progress-2" })).resolves.toBeDefined();
  });
});
