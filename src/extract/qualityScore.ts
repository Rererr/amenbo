/**
 * extract/qualityScore.ts — 品質スコアによるMarkdown/ピクセル自動切替の判定。
 *
 * plan.md §3-4「ハイブリッド自動切替」のPhase 2実装。
 * 実際のピクセル/ジオメトリ計測(bounding box等)はPhase 4スコープのため、
 * ここではDOM構造から得られる安価な近似指標を用いる:
 *   - 抽出テキスト密度 = 抽出Markdown文字数 / レンダリング可視テキスト文字数
 *   - 視覚要素占有率 = (表セル+canvas+svg要素数) / 全「内容を持ちうる」要素数
 * のいずれかが閾値を割ればMarkdown抽出で情報が失われていると判断し、
 * スクリーンショットへの切替を提案する。
 */

export interface QualityScoreInput {
  /** extractMarkdown後のMarkdown本文の文字数。 */
  extractedTextLength: number;
  /** レンダリング結果(script/style除く)の可視テキスト文字数。 */
  visibleTextLength: number;
  /** 表セル(td/th)要素数。 */
  tableCellCount: number;
  /** canvas要素数。 */
  canvasCount: number;
  /** svg要素数。 */
  svgCount: number;
  /** 内容を持ちうる要素の総数(視覚要素占有率の分母)。 */
  totalLeafElementCount: number;
}

export interface QualityScoreResult {
  density: number;
  visualOccupancyRatio: number;
  lowQuality: boolean;
  reason: string | null;
}

// 設計判断(plan.md §3-4に明記の閾値をそのまま採用)
const DENSITY_THRESHOLD = 0.6;
const VISUAL_OCCUPANCY_THRESHOLD = 0.3;

/** 品質スコアを評価し、Markdown抽出で情報が失われていないかを判定する。 */
export function evaluateQuality(input: QualityScoreInput): QualityScoreResult {
  const density = input.visibleTextLength > 0 ? input.extractedTextLength / input.visibleTextLength : 1;
  const visualOccupancyRatio =
    input.totalLeafElementCount > 0
      ? (input.tableCellCount + input.canvasCount + input.svgCount) / input.totalLeafElementCount
      : 0;

  if (density < DENSITY_THRESHOLD) {
    return {
      density,
      visualOccupancyRatio,
      lowQuality: true,
      reason: `抽出テキスト密度が低いです(${density.toFixed(2)} < ${DENSITY_THRESHOLD})`,
    };
  }

  if (visualOccupancyRatio > VISUAL_OCCUPANCY_THRESHOLD) {
    return {
      density,
      visualOccupancyRatio,
      lowQuality: true,
      reason: `表/canvas/svgの要素占有率が高いです(${visualOccupancyRatio.toFixed(2)} > ${VISUAL_OCCUPANCY_THRESHOLD})`,
    };
  }

  return { density, visualOccupancyRatio, lowQuality: false, reason: null };
}
