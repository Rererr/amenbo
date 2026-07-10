/**
 * extract/pruning.ts — J4 CJK本文スコアラー + fit-pruning。
 *
 * Readabilityの本文判定ヒューリスティック(英語の単語数/カンマ数前提)は、
 * スペース区切りの無い日本語では機能しにくい。代わりに
 *   - 句読点密度(、。等。日本語文の「文らしさ」の代替指標)
 *   - CJK文字比率
 *   - リンク密度(ナビ/ランキング/広告枠ほど高くなる)
 * でブロックをスコアリングし、低価値ブロック(ナビ/ランキング/広告枠/フッター相当:
 * リンク密度高・句読点密度低)をMarkdown化前にDOMから除去する。
 */

interface BlockTextStats {
  /** ブロック内の全テキスト。 */
  text: string;
  /** ブロック内のリンク(<a>)テキストのみ。 */
  linkText: string;
}

export interface BlockScore {
  /** 句読点(、。!?等)がテキストに占める割合(0-1)。 */
  punctuationDensity: number;
  /** CJK文字(かな/カナ/漢字)がテキストに占める割合(0-1)。 */
  cjkRatio: number;
  /** リンクテキストが全体テキストに占める割合(0-1)。 */
  linkDensity: number;
  /** 総合スコア。0以上を本文らしいブロックとみなす。 */
  score: number;
}

const PUNCTUATION_PATTERN = /[、。!?！?.,]/gu;

function isCjkChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x3040 && cp <= 0x309f) || // ひらがな
    (cp >= 0x30a0 && cp <= 0x30ff) || // カタカナ
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK統合漢字拡張A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK統合漢字
    (cp >= 0xf900 && cp <= 0xfaff) // CJK互換漢字
  );
}

// スコア係数(設計判断): 句読点密度を最重視(日本語では「文」の存在そのものが本文らしさの
// 最も強いシグナル)、リンク密度は本文らしさを大きく減点する要因、CJK比率は補助的な弱いシグナル
// (日本語のナビ/フッターも漢字を含むため単独では本文/非本文を判別できない)。
const PUNCTUATION_WEIGHT = 40;
const CJK_WEIGHT = 1;
const LINK_WEIGHT = 5;

/** J4: ブロックのテキスト統計からスコアを算出する(純関数)。 */
export function scoreBlock(stats: BlockTextStats): BlockScore {
  const text = stats.text.trim();
  const length = text.length;
  if (length === 0) {
    return { punctuationDensity: 0, cjkRatio: 0, linkDensity: 0, score: 0 };
  }

  const punctuationCount = (text.match(PUNCTUATION_PATTERN) ?? []).length;
  const punctuationDensity = punctuationCount / length;

  let cjkCount = 0;
  for (const ch of text) {
    if (isCjkChar(ch)) cjkCount++;
  }
  const cjkRatio = cjkCount / length;

  const linkTextLength = stats.linkText.trim().length;
  const linkDensity = Math.min(linkTextLength / length, 1);

  const score = punctuationDensity * PUNCTUATION_WEIGHT + cjkRatio * CJK_WEIGHT - linkDensity * LINK_WEIGHT;

  return { punctuationDensity, cjkRatio, linkDensity, score };
}

export interface PruneOptions {
  /** これ未満の文字数のブロックはスコアリング対象外(除去しない)。既定20文字。 */
  minTextLength?: number;
  /** このスコア未満のブロックを低価値と判定する。既定0。 */
  scoreThreshold?: number;
}

const DEFAULT_MIN_TEXT_LENGTH = 20;
const DEFAULT_SCORE_THRESHOLD = 0;

/** 常に除去対象とする非本文タグ(セマンティックに明確なナビ/フッター等)。 */
const ALWAYS_PRUNE_TAGS = new Set(["NAV", "ASIDE", "FOOTER", "HEADER", "FORM"]);
/** J4スコアで評価する候補タグ(div soup対応: セマンティックタグを持たない場合)。 */
const SCORE_CANDIDATE_TAGS = new Set(["DIV", "SECTION", "UL", "OL"]);

/** pruneLowValueBlocksが要求するDOM要素の最小インターフェース(linkedom/ブラウザDOM双方と構造的に互換)。 */
export interface PruneHostElement {
  tagName: string;
  children: ArrayLike<PruneHostElement>;
  textContent: string;
  remove(): void;
  querySelectorAll(selector: string): ArrayLike<{ textContent: string }>;
}

function collectLinkText(element: PruneHostElement): string {
  return Array.from(element.querySelectorAll("a"))
    .map((a) => a.textContent)
    .join("");
}

/**
 * DOM上の低価値ブロックを除去する(document.body等をrootに渡す想定)。
 * 常に除去するタグ(nav/aside/footer/header/form)はその場で除去し子孫を再帰評価しない。
 * それ以外は先に子孫を再帰評価してから自身をスコアリングするボトムアップ走査にする
 * (ページ全体が単一のラッパーdivに包まれている実サイト構成では、内部のnav/footer等を
 * 先に除去してからでないとラッパー全体が「リンク密度の高い1ブロック」として誤って
 * 丸ごと刈られてしまうため。トップダウンのままだと本文まで巻き添えで消える回帰があった)。
 *
 * 戻り値は「独立して刈られた部分木の数」。ある要素が最終的に丸ごと除去される場合、
 * その内部で先に個別除去された子孫(nav/footer等)は既に除去済みの部分木に含まれて
 * しまっており、外側の除去と二重にカウントすべきではない。そのため子の内部除去数
 * (descendantPrunedCount)は、その子自身が生き残った場合にのみ合算し、子自身が
 * 除去された場合は破棄して「1(その子1個の除去)」として数える。
 */
export function pruneLowValueBlocks(root: PruneHostElement, options: PruneOptions = {}): number {
  const minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;

  const walk = (element: PruneHostElement): number => {
    let prunedCount = 0;

    for (const child of Array.from(element.children)) {
      const tag = child.tagName;

      if (ALWAYS_PRUNE_TAGS.has(tag)) {
        child.remove();
        prunedCount++;
        continue;
      }

      // 先に子孫を刈ってから自身を評価する(ボトムアップ)。子孫のnav/footer等が
      // 除去された後の「クリーンな」テキスト/リンク密度で自身のスコアを判定するため。
      const descendantPrunedCount = walk(child);

      if (SCORE_CANDIDATE_TAGS.has(tag)) {
        const text = child.textContent ?? "";
        if (text.trim().length >= minTextLength) {
          const stats: BlockTextStats = { text, linkText: collectLinkText(child) };
          if (scoreBlock(stats).score < scoreThreshold) {
            child.remove();
            // 子自身が丸ごと除去されるため、内部の個別除去数は合算しない(二重カウント回避)。
            prunedCount++;
            continue;
          }
        }
      }

      // 子は生き残ったので、その内部で独立して除去されたぶんはそのまま加算する。
      prunedCount += descendantPrunedCount;
    }

    return prunedCount;
  };

  return walk(root);
}
