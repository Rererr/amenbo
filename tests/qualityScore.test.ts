import { describe, expect, it } from "vitest";
import { evaluateQuality, type QualityScoreInput } from "../src/extract/qualityScore.js";

function baseInput(overrides: Partial<QualityScoreInput> = {}): QualityScoreInput {
  return {
    extractedTextLength: 900,
    visibleTextLength: 1000,
    tableCellCount: 2,
    canvasCount: 0,
    svgCount: 0,
    totalLeafElementCount: 50,
    ...overrides,
  };
}

describe("evaluateQuality", () => {
  it("抽出テキスト密度が高く視覚要素占有率も低い通常記事はlowQuality=false", () => {
    const result = evaluateQuality(baseInput());
    expect(result.lowQuality).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("抽出テキスト密度が0.6未満だとlowQuality=true(密度理由)", () => {
    const result = evaluateQuality(baseInput({ extractedTextLength: 300, visibleTextLength: 1000 }));
    expect(result.lowQuality).toBe(true);
    expect(result.reason).toContain("密度");
  });

  it("表/canvas/svgの要素占有率が0.3を超えるとlowQuality=true(占有率理由)", () => {
    const result = evaluateQuality(baseInput({ tableCellCount: 40, totalLeafElementCount: 50 }));
    expect(result.lowQuality).toBe(true);
    expect(result.reason).toContain("占有率");
  });

  it("visibleTextLengthが0の場合はdensityを1として扱いdensity起因のlowQualityにはしない", () => {
    const result = evaluateQuality(baseInput({ extractedTextLength: 0, visibleTextLength: 0 }));
    expect(result.density).toBe(1);
  });

  it("totalLeafElementCountが0の場合はvisualOccupancyRatioを0として扱う", () => {
    const result = evaluateQuality(baseInput({ totalLeafElementCount: 0, tableCellCount: 0 }));
    expect(result.visualOccupancyRatio).toBe(0);
  });

  it("閾値ちょうど(density=0.6)は低品質と判定しない(未満のみ)", () => {
    const result = evaluateQuality(baseInput({ extractedTextLength: 600, visibleTextLength: 1000 }));
    expect(result.lowQuality).toBe(false);
  });
});
