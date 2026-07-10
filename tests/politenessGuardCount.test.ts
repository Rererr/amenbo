import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "../src/screenshot.js";

/**
 * code-reviewer指摘: mode: screenshot早期return経路(fetchツール)・独立screenshotツール経路
 * それぞれで、politeness.guardが期待回数だけ呼ばれることを検証する。
 * 前者はhandleFetchTool冒頭の1回のみ(resolveScreenshot内はskipGuardで省略)、
 * 後者はresolveScreenshot内の1回(事前guardが無い経路のため)になるはず。
 * 誤って二重呼び出しになる回帰(このタスクで修正した不具合)を防ぐ。
 *
 * 実ブラウザ起動・実robots.txtネットワークアクセスを避けるため、screenshot.tsの
 * captureTiledScreenshotをモックし、politeness.guard自体もモックする(実ネットワークに
 * 依存せず呼び出し回数だけを検証する)。
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

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-guard-count-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { handleFetchTool, handleScreenshotTool, politeness } = await import("../src/core.js");

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("politeness.guard呼び出し回数(screenshot経路の二重guard回帰防止)", () => {
  let guardSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    guardSpy = vi.spyOn(politeness, "guard").mockResolvedValue(undefined);
  });

  afterEach(() => {
    guardSpy.mockRestore();
  });

  it("fetchツールのmode: screenshot早期return経路はguardを1回のみ呼ぶ(handleFetchTool冒頭のみ)", async () => {
    await handleFetchTool({ url: "https://example.com/", mode: "screenshot" });
    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy).toHaveBeenCalledWith("https://example.com/");
  });

  it("独立screenshotツール経路はguardを1回のみ呼ぶ(resolveScreenshot内。事前guardが無いため)", async () => {
    await handleScreenshotTool({ url: "https://example.com/" });
    expect(guardSpy).toHaveBeenCalledTimes(1);
    expect(guardSpy).toHaveBeenCalledWith("https://example.com/");
  });
});
