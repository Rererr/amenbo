/**
 * extract/geometry.ts — Phase 4 ジオメトリ抽出(構造化が甘いdiv soup/テーブルレイアウト対策)。
 *
 * Readability+J4スコアの抽出結果が貧弱(本文が短い)かつJ7アダプタが非該当のページに対する
 * 最終フォールバック。ブラウザ昇格時に採取したテキストブロック(要素単位。真の意味での
 * テキストノード粒度ではなく、p/li/td等の「テキストを直接持つリーフ要素」単位で近似する)の
 * bounding boxから、縦方向に連続し水平位置(左端)が揃うブロック群を1つの「カラム」として
 * クラスタリングし、最もテキスト量の多いクラスタを主コンテンツ領域とみなす。
 *
 * 「セマンティックなDOMではなくレンダリング結果の見た目(ジオメトリ)を一次情報にする」
 * というplan.mdの前提認識(§0)を素朴な形で実装したもの。
 */

export interface TextBlockGeometry {
  /** ブラウザ側でDOM要素に付与した一時id(data-amenbo-gid)。DOM再選択に使う。 */
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** このブロック自身の直接テキスト長(トリム後)。 */
  textLength: number;
}

export interface GeometryCluster {
  blockIds: number[];
  totalTextLength: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 表/canvas/svg等の視覚要素のbounding box(J6/Phase4の視覚要素占有率の実測に使う)。 */
export interface VisualElementGeometry {
  tag: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** ブラウザ昇格時に採取する、ページ全体のジオメトリスナップショット。 */
export interface PageGeometrySnapshot {
  textBlocks: TextBlockGeometry[];
  visualElements: VisualElementGeometry[];
  pageWidth: number;
  pageHeight: number;
}

/**
 * 表/canvas/svgのbounding box面積の合計 / ページ全体面積(0-1)。
 * Phase 2まではDOM要素数ベースの近似だった「視覚要素占有率」を、実ジオメトリで置き換える。
 * 要素同士の重なりは考慮しない単純合計(重なりは稀なため許容する近似)。
 */
export function computeVisualAreaRatio(visualElements: VisualElementGeometry[], pageWidth: number, pageHeight: number): number {
  const pageArea = pageWidth * pageHeight;
  if (pageArea <= 0) return 0;
  const visualArea = visualElements.reduce((sum, el) => sum + el.width * el.height, 0);
  return Math.min(visualArea / pageArea, 1);
}

/** 直前ブロックとの縦方向ギャップが、直前後の平均ブロック高さの何倍まで許容されるか。 */
const MAX_VERTICAL_GAP_RATIO = 2.5;
/** 同じカラムとみなす左端座標のズレ許容(px)。 */
const HORIZONTAL_ALIGN_TOLERANCE_PX = 40;

function buildCluster(blocks: TextBlockGeometry[]): GeometryCluster {
  const totalTextLength = blocks.reduce((sum, b) => sum + b.textLength, 0);
  const left = Math.min(...blocks.map((b) => b.x));
  const right = Math.max(...blocks.map((b) => b.x + b.width));
  const top = Math.min(...blocks.map((b) => b.y));
  const bottom = Math.max(...blocks.map((b) => b.y + b.height));
  return { blockIds: blocks.map((b) => b.id), totalTextLength, top, bottom, left, right };
}

interface OpenColumn {
  blocks: TextBlockGeometry[];
  lastX: number;
  lastBottom: number;
  lastHeight: number;
}

/**
 * テキストブロック群を、縦方向に連続し左端座標が揃うクラスタ(カラム)へ分割する(純関数)。
 * テキスト量の多い順にソートして返す(先頭が最も本文らしいクラスタ)。
 *
 * 実装上の注意: y昇順に処理する際、複数カラム(本文とサイドバー等)が同じy範囲に
 * 交互に出現しうるため、「直前に処理した1ブロックとだけ」比較する単純な線形走査では
 * カラムが混ざってしまう。そのため現在「進行中」の全カラム候補(OpenColumn)を保持し、
 * 各ブロックについて左端座標が近い進行中カラムを探して追加する(見つからなければ新規カラム)。
 */
export function clusterTextBlocks(blocks: TextBlockGeometry[]): GeometryCluster[] {
  const sorted = [...blocks]
    .filter((b) => b.textLength > 0 && b.width > 0 && b.height > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  if (sorted.length === 0) return [];

  const openColumns: OpenColumn[] = [];

  for (const block of sorted) {
    const target = openColumns.find((column) => {
      const sameColumn = Math.abs(block.x - column.lastX) <= HORIZONTAL_ALIGN_TOLERANCE_PX;
      const verticalGap = block.y - column.lastBottom;
      const avgHeight = (column.lastHeight + block.height) / 2;
      return sameColumn && verticalGap <= Math.max(avgHeight, 1) * MAX_VERTICAL_GAP_RATIO;
    });

    if (target) {
      target.blocks.push(block);
      target.lastX = block.x;
      target.lastBottom = block.y + block.height;
      target.lastHeight = block.height;
    } else {
      openColumns.push({ blocks: [block], lastX: block.x, lastBottom: block.y + block.height, lastHeight: block.height });
    }
  }

  return openColumns.map((column) => buildCluster(column.blocks)).sort((a, b) => b.totalTextLength - a.totalTextLength);
}

/** 最もテキスト量が多い(=本文らしい)クラスタを主コンテンツ領域として選ぶ。無ければnull。 */
export function selectMainContentCluster(blocks: TextBlockGeometry[]): GeometryCluster | null {
  const clusters = clusterTextBlocks(blocks);
  return clusters[0] ?? null;
}
