/**
 * extract/qualityScore.ts — 品質スコアによるMarkdown/ピクセル自動切替の判定。
 *
 * plan.md §3-4「ハイブリッド自動切替」(Phase 2)+ J6画像文字検知(Phase 3)+
 * Phase 4: ブラウザ昇格時は実ジオメトリ(bounding box)から視覚要素占有率を計算する。
 * HTTP tier(静的HTML)は引き続きDOM構造から得られる安価な近似指標を用いる:
 *   - 抽出テキスト密度 = 抽出Markdown文字数 / レンダリング可視テキスト文字数
 *   - 視覚要素占有率 = (表セル+canvas+svg要素数) / 全「内容を持ちうる」要素数(近似)
 *     ブラウザ昇格時は実bounding boxの面積比(realVisualAreaRatio)で置き換える(Phase 4)
 *     いずれも表(td/th)由来分とcanvas/svg由来分を分離して評価する。表は抽出品質が
 *     十分ならスクショ切替の理由にしない(=誤判定対策)が、canvas/svgはテキスト代替が
 *     原理的に存在しないため常に評価する。
 *   - 抽出テキストの絶対量(extractedTokenEstimate)が十分あれば、密度低下・表由来の
 *     占有率超過のみを理由にしたscreenshot切替は行わない(J6・canvas/svgは対象外)。
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
  /**
   * Phase 4: ブラウザ昇格時のみ、実ジオメトリ(bounding box)から計算した
   * 表/canvas/svgの面積占有率(0-1)。指定時はDOM要素数ベースの近似より優先する。
   */
  realVisualAreaRatio?: number;
  /**
   * Phase 4: realVisualAreaRatioのうちtable要素のみが占める面積比(0-1)。
   * 指定時はrealVisualAreaRatioから表由来分とcanvas/svg由来分を分離し、表由来分にのみ
   * 抽出品質による免除(下記tableExtractedWell相当)を適用できるようにする。
   * 未指定時(realVisualAreaRatioのみ指定)は分離不能として従来通り合算値をそのまま扱う。
   */
  realTableAreaRatio?: number;
  /**
   * 抽出Markdown本文の概算トークン数(estimateTokens)。密度(比率)が低くても、
   * 抽出テキストの絶対量が既に十分あるページをscreenshotへ誤って切り替えないための判定に使う
   * (例: 官公庁サイト等、可視テキスト全体に対する抽出割合は低くても、抽出できた本文単体で
   * 十分読める量があるケース)。
   */
  extractedTokenEstimate: number;
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
// 表(td/th)由来の占有率を「抽出品質が悪い」と見なさず不問にするための密度の下限。
// GFMテーブルはパイプ/区切り行の分だけ文字数が可視テキストより膨らむため、表の内容が
// 取りこぼし無く抽出できていれば density は概ね1以上になる。1未満は可視テキストの
// 一部しか抽出できていない(=表が画像/レイアウト崩れ等で読み取れていない)ことを示すため
// 従来通り占有率超過を低品質理由として扱う。
const TABLE_DENSITY_OK_THRESHOLD = 1;
// 密度(比率)だけでは「可視テキストの大半が非本文(ナビ/装飾等)で占められるページ」で
// 抽出テキストの絶対量が十分でも低密度になり得る。抽出Markdownがこの概算トークン数以上
// あれば、密度低下のみを理由にしたscreenshot切替は行わない(数百tok目安の最小修正)。
const MIN_EXTRACTED_TOKENS_FOR_DENSITY_EXEMPTION = 500;
// J6: 「画像で情報を出しているページ」判定。画像面積が大きい"だけ"では正当な写真記事も
// 引っかかるため、alt欠落率(アクセシブルなテキスト代替が無い=デコード可能な情報が画像に閉じ込め
// られている可能性が高い)との組み合わせで判定する。
const IMG_AREA_RATIO_THRESHOLD = 0.3;
const IMG_MISSING_ALT_RATIO_THRESHOLD = 0.5;

/** 品質スコアを評価し、Markdown抽出で情報が失われていないかを判定する。 */
export function evaluateQuality(input: QualityScoreInput): QualityScoreResult {
  const density = input.visibleTextLength > 0 ? input.extractedTextLength / input.visibleTextLength : 1;
  // Phase 4: ブラウザ昇格時は実ジオメトリの面積比を優先し、無ければDOM要素数ベースの近似を使う
  const visualOccupancyRatio =
    input.realVisualAreaRatio ??
    (input.totalLeafElementCount > 0 ? (input.tableCellCount + input.canvasCount + input.svgCount) / input.totalLeafElementCount : 0);
  const imgMissingAltRatio = input.imgCount > 0 ? input.imgMissingAltCount / input.imgCount : 0;

  // 密度が低くても、抽出テキストの絶対量が既に十分(500tok目安)ある場合は密度のみを
  // 理由にしたscreenshot切替をしない(表/canvas/svg占有率・J6画像検知は密度に関わらず
  // このあとも評価するため、canvas/svg起因や極端な視覚依存の検出は損なわない)。
  const hasSubstantialExtractedText = input.extractedTokenEstimate >= MIN_EXTRACTED_TOKENS_FOR_DENSITY_EXEMPTION;

  if (density < DENSITY_THRESHOLD && !hasSubstantialExtractedText) {
    return {
      density,
      visualOccupancyRatio,
      imgMissingAltRatio,
      lowQuality: true,
      reason: `抽出テキスト密度が低いです(${density.toFixed(2)} < ${DENSITY_THRESHOLD})`,
    };
  }

  // 占有率が閾値超過でも、表(td/th)がGFMテーブルとして取りこぼし無く抽出できている
  // (density高、または抽出テキストの絶対量が十分)場合はスクショ切替の理由にしない。
  // 表は本来「画像でしか表現できないページ」の検出が目的であり、正しくMarkdown化
  // できた表まで巻き込むのは誤判定のため。canvas/svgはテキスト代替が原理的に存在
  // しないため、この免除の対象外(密度・抽出量に関わらず従来通り評価する)。
  const tableCellRatio = input.totalLeafElementCount > 0 ? input.tableCellCount / input.totalLeafElementCount : 0;
  const nonTableVisualRatio = input.totalLeafElementCount > 0 ? (input.canvasCount + input.svgCount) / input.totalLeafElementCount : 0;

  // 表由来分とcanvas/svg由来分を分離する。Phase4実ジオメトリはrealTableAreaRatioが
  // 併せて指定されている場合のみ分離可能(未指定時は分離不能として全量を
  // 「canvas/svg相当」= 免除対象外に倒し、従来通り安全側で評価する)。
  const tableRatio = input.realVisualAreaRatio !== undefined ? (input.realTableAreaRatio ?? 0) : tableCellRatio;
  const nonTableRatio =
    input.realVisualAreaRatio !== undefined
      ? Math.max(input.realVisualAreaRatio - (input.realTableAreaRatio ?? 0), 0)
      : nonTableVisualRatio;

  const tableExtractedWell = density >= TABLE_DENSITY_OK_THRESHOLD || hasSubstantialExtractedText;
  const occupancyForLowQualityCheck = tableExtractedWell ? nonTableRatio : tableRatio + nonTableRatio;

  if (occupancyForLowQualityCheck > VISUAL_OCCUPANCY_THRESHOLD) {
    return {
      density,
      visualOccupancyRatio,
      imgMissingAltRatio,
      lowQuality: true,
      // code-reviewer指摘: reasonには判定に実際に使った値(occupancyForLowQualityCheck)を
      // 表示する。tableExtractedWell=true(表は取りこぼし無く抽出済み)の場合はcanvas/svg
      // 由来分のみで判定しているため、旧来の合算値visualOccupancyRatioを表示すると
      // 「表が原因」と誤解させてしまう。
      reason: `表/canvas/svgの要素占有率が高いです(${occupancyForLowQualityCheck.toFixed(2)} > ${VISUAL_OCCUPANCY_THRESHOLD})`,
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
