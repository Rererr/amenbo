import { describe, expect, it } from "vitest";
import {
  clusterTextBlocks,
  computeVisualAreaRatio,
  selectMainContentCluster,
  type TextBlockGeometry,
  type VisualElementGeometry,
} from "../src/extract/geometry.js";

function block(id: number, x: number, y: number, width: number, height: number, textLength: number): TextBlockGeometry {
  return { id, x, y, width, height, textLength };
}

function visual(tag: string, x: number, y: number, width: number, height: number): VisualElementGeometry {
  return { tag, x, y, width, height };
}

describe("clusterTextBlocks", () => {
  it("空配列は空クラスタ一覧を返す", () => {
    expect(clusterTextBlocks([])).toEqual([]);
  });

  it("縦に連続し左端が揃うブロックは1つのクラスタになる", () => {
    const blocks = [block(1, 100, 0, 400, 20, 50), block(2, 100, 30, 400, 20, 60), block(3, 100, 60, 400, 20, 40)];
    const clusters = clusterTextBlocks(blocks);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.blockIds.sort()).toEqual([1, 2, 3]);
    expect(clusters[0]?.totalTextLength).toBe(150);
  });

  it("左右に離れた2カラム(サイドバーと本文)は別クラスタになる", () => {
    const sidebar = [block(1, 0, 0, 200, 20, 10), block(2, 0, 30, 200, 20, 10)];
    const main = [block(3, 300, 0, 500, 20, 100), block(4, 300, 30, 500, 20, 100)];
    const clusters = clusterTextBlocks([...sidebar, ...main]);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    // テキスト量の多い順にソートされるため、先頭は本文側クラスタ
    expect(clusters[0]?.blockIds.sort()).toEqual([3, 4]);
  });

  it("縦方向に大きく離れたブロックは別クラスタに分割される", () => {
    const blocks = [
      block(1, 100, 0, 400, 20, 50),
      block(2, 100, 30, 400, 20, 50),
      // 大きな空白の後、無関係な別ブロック(フッター等)
      block(3, 100, 2000, 400, 20, 5),
    ];
    const clusters = clusterTextBlocks(blocks);
    expect(clusters.length).toBe(2);
  });

  it("テキスト量の多いクラスタが先頭に来るようソートされる", () => {
    const small = [block(1, 0, 0, 100, 20, 5)];
    const large = [block(2, 300, 0, 100, 20, 500)];
    const clusters = clusterTextBlocks([...small, ...large]);
    expect(clusters[0]?.blockIds).toEqual([2]);
    expect(clusters[1]?.blockIds).toEqual([1]);
  });

  it("テキスト長・幅・高さが0以下のブロックは無視する", () => {
    const blocks = [block(1, 0, 0, 100, 20, 0), block(2, 0, 0, 0, 20, 10), block(3, 0, 0, 100, 0, 10)];
    expect(clusterTextBlocks(blocks)).toEqual([]);
  });

  it("クラスタのbounding boxが全ブロックを包含する", () => {
    const blocks = [block(1, 100, 0, 400, 20, 10), block(2, 120, 30, 380, 20, 10)];
    const clusters = clusterTextBlocks(blocks);
    const cluster = clusters[0]!;
    expect(cluster.top).toBe(0);
    expect(cluster.bottom).toBe(50);
    expect(cluster.left).toBe(100);
    expect(cluster.right).toBeGreaterThanOrEqual(500);
  });
});

describe("selectMainContentCluster", () => {
  it("最もテキスト量の多いクラスタを返す", () => {
    const nav = [block(1, 0, 0, 100, 20, 5), block(2, 0, 30, 100, 20, 5)];
    const article = [block(3, 200, 0, 600, 30, 300), block(4, 200, 40, 600, 30, 300), block(5, 200, 80, 600, 30, 300)];
    const winner = selectMainContentCluster([...nav, ...article]);
    expect(winner?.blockIds.sort()).toEqual([3, 4, 5]);
    expect(winner?.totalTextLength).toBe(900);
  });

  it("ブロックが無ければnullを返す", () => {
    expect(selectMainContentCluster([])).toBeNull();
  });
});

describe("computeVisualAreaRatio", () => {
  it("表/canvas/svgの面積合計をページ面積で割った比率を返す", () => {
    const ratio = computeVisualAreaRatio([visual("table", 0, 0, 500, 400)], 1000, 1000);
    expect(ratio).toBeCloseTo(0.2);
  });

  it("複数要素の面積を単純合計する", () => {
    const ratio = computeVisualAreaRatio([visual("table", 0, 0, 500, 200), visual("canvas", 0, 0, 500, 200)], 1000, 1000);
    expect(ratio).toBeCloseTo(0.2);
  });

  it("視覚要素が無ければ0", () => {
    expect(computeVisualAreaRatio([], 1000, 1000)).toBe(0);
  });

  it("ページ面積が0以下なら0(0除算を避ける)", () => {
    expect(computeVisualAreaRatio([visual("table", 0, 0, 100, 100)], 0, 0)).toBe(0);
  });

  it("比率は1を超えない(要素の重なりで面積合計がページ面積を超えるケース)", () => {
    const ratio = computeVisualAreaRatio([visual("table", 0, 0, 900, 900), visual("canvas", 0, 0, 900, 900)], 1000, 1000);
    expect(ratio).toBe(1);
  });
});
