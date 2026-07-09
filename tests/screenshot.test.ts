import { describe, expect, it } from "vitest";
import { computeTiles, isTileCaptureTruncated } from "../src/screenshot.js";

describe("computeTiles", () => {
  it("ページ高さがタイル高さ以下なら1タイルになる", () => {
    const tiles = computeTiles(1280, 800, 1280, 1080);
    expect(tiles).toEqual([{ x: 0, y: 0, width: 1280, height: 800 }]);
  });

  it("ページ高さがタイル高さの倍数ちょうどならその数だけタイルになる", () => {
    const tiles = computeTiles(1280, 2160, 1280, 1080);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 1280, height: 1080 });
    expect(tiles[1]).toEqual({ x: 0, y: 1080, width: 1280, height: 1080 });
  });

  it("端数がある場合、最後のタイルは端数の高さになる", () => {
    const tiles = computeTiles(1280, 2500, 1280, 1080);
    expect(tiles).toHaveLength(3);
    expect(tiles[2]).toEqual({ x: 0, y: 2160, width: 1280, height: 340 });
  });

  it("ページ幅がタイル幅より狭い場合はページ幅に合わせる", () => {
    const tiles = computeTiles(800, 500, 1280, 1080);
    expect(tiles[0]?.width).toBe(800);
  });

  it("全タイルのx座標は0で統一される(横方向には分割しない)", () => {
    const tiles = computeTiles(1280, 5000, 1280, 1080);
    expect(tiles.every((t) => t.x === 0)).toBe(true);
  });

  it("極端に長いページはMAX_TILES枚で打ち切られる(トークン予算保護)", () => {
    const tiles = computeTiles(1280, 1_000_000, 1280, 1080);
    expect(tiles.length).toBeLessThanOrEqual(10);
  });

  it("ページ高さが0でも最低1タイルは返す", () => {
    const tiles = computeTiles(1280, 0, 1280, 1080);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.height).toBeGreaterThan(0);
  });
});

describe("isTileCaptureTruncated(N7: MAX_TILES切り捨ての明示)", () => {
  it("ページが短くタイル枚数が十分な場合はfalse", () => {
    expect(isTileCaptureTruncated(800, computeTiles(1280, 800, 1280, 1080).length, 1080)).toBe(false);
  });

  it("MAX_TILES(10)で切り捨てられる長さのページではtrueになる", () => {
    const pageHeight = 1_000_000;
    const tiles = computeTiles(1280, pageHeight, 1280, 1080);
    expect(tiles.length).toBeLessThanOrEqual(10);
    expect(isTileCaptureTruncated(pageHeight, tiles.length, 1080)).toBe(true);
  });

  it("ちょうどタイル高さの倍数で切り捨てが発生しない場合はfalse", () => {
    const pageHeight = 1080 * 3;
    const tiles = computeTiles(1280, pageHeight, 1280, 1080);
    expect(isTileCaptureTruncated(pageHeight, tiles.length, 1080)).toBe(false);
  });
});
