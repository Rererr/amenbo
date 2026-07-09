/**
 * extract/qualityScore.ts — 品質スコアによるMarkdown/ピクセル自動切替の判定。
 *
 * plan.md §3-4「ハイブリッド自動切替」(Phase 2)+ J6画像文字検知(Phase 3)。
 * 実際のピクセル/ジオメトリ計測(bounding box等)はPhase 4スコープのため、
 * ここではDOM構造から得られる安価な近似指標を用いる:
 *   - 抽出テキスト密度 = 抽出Markdown文字数 / レンダリング可視テキスト文字数
 *   - 視覚要素占有率 = (表セル+canvas+svg要素数) / 全「内容を持ちうる」要素数
 *   - J6 画像文字検知 = img面積占有率(width/height属性からの近似) と alt欠落率
 *     (「バナー/画像化料金表」等、画像で情報を出しているページの検知)
 * いずれかが閾値を割れば/超えればMarkdown抽出で情報が失われていると判断し、
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
  /** img要素数(J6)。 */
  imgCount: number;
  /** alt属性が全く無いimg要素数(J6。alt=""の意図的な装飾指定は除く)。 */
  imgMissingAltCount: number;
  /** img要素のwidth/height属性から見積もった合計面積 / 基準ページ面積(0-1、J6)。 */
  imgAreaRatio: number;
}

export interface QualityScoreResult {
  density: number;
  visualOccupancyRatio: number;
  imgMissingAltRatio: number;
  lowQuality: boolean;
  reason: string | null;
}

// 設計判断(plan.md §3-4に明記の閾値をそのまま採用)
const DENSITY_THRESHOLD = 0.6;
const VISUAL_OCCUPANCY_THRESHOLD = 0.3;
// J6: 「画像で情報を出しているページ」判定。画像面積が大きい"だけ"では正当な写真記事も
// 引っかかるため、alt欠落率(アクセシブルなテキスト代替が無い=デコード可能な情報が画像に閉じ込め
// られている可能性が高い)との組み合わせで判定する。
const IMG_AREA_RATIO_THRESHOLD = 0.3;
const IMG_MISSING_ALT_RATIO_THRESHOLD = 0.5;

/** 品質スコアを評価し、Markdown抽出で情報が失われていないかを判定する。 */
export function evaluateQuality(input: QualityScoreInput): QualityScoreResult {
  const density = input.visibleTextLength > 0 ? input.extractedTextLength / input.visibleTextLength : 1;
  const visualOccupancyRatio =
    input.totalLeafElementCount > 0
      ? (input.tableCellCount + input.canvasCount + input.svgCount) / input.totalLeafElementCount
      : 0;
  const imgMissingAltRatio = input.imgCount > 0 ? input.imgMissingAltCount / input.imgCount : 0;

  if (density < DENSITY_THRESHOLD) {
    return {
      density,
      visualOccupancyRatio,
      imgMissingAltRatio,
      lowQuality: true,
      reason: `抽出テキスト密度が低いです(${density.toFixed(2)} < ${DENSITY_THRESHOLD})`,
    };
  }

  if (visualOccupancyRatio > VISUAL_OCCUPANCY_THRESHOLD) {
    return {
      density,
      visualOccupancyRatio,
      imgMissingAltRatio,
      lowQuality: true,
      reason: `表/canvas/svgの要素占有率が高いです(${visualOccupancyRatio.toFixed(2)} > ${VISUAL_OCCUPANCY_THRESHOLD})`,
    };
  }

  if (input.imgAreaRatio > IMG_AREA_RATIO_THRESHOLD && imgMissingAltRatio > IMG_MISSING_ALT_RATIO_THRESHOLD) {
    return {
      density,
      visualOccupancyRatio,
      imgMissingAltRatio,
      lowQuality: true,
      reason: `J6: 画像で情報を提供しているページの可能性があります(画像面積比${input.imgAreaRatio.toFixed(2)} > ${IMG_AREA_RATIO_THRESHOLD}, alt欠落率${imgMissingAltRatio.toFixed(2)} > ${IMG_MISSING_ALT_RATIO_THRESHOLD})`,
    };
  }

  return { density, visualOccupancyRatio, imgMissingAltRatio, lowQuality: false, reason: null };
}
