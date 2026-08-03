/**
 * extract/pruning.ts — J4 本文スコアラー + fit-pruning。
 *
 * Readabilityの本文判定ヒューリスティック(英語の単語数/カンマ数前提)は、
 * スペース区切りの無い日本語では機能しにくい。代わりに
 *   - 文・節の区切り(、。,.等)の語あたりの個数(「文」で書かれているかの指標)
 *   - Unicode文字比率(\p{L}。英字・CJK等を問わない)
 *   - リンク密度(ナビ/ランキング/広告枠ほど高くなる)
 * でブロックをスコアリングし、低価値ブロック(ナビ/ランキング/広告枠/フッター相当:
 * リンク密度高・区切り密度低)をMarkdown化前にDOMから除去する。
 *
 * 3指標はいずれも特定言語の文字種・表記習慣に依存しない形で定義する(Unicodeプロパティと
 * UAX#29の語分割)。区切りの個数を文字数で割ると、1文字あたりの情報量が多いCJKの密度が
 * 構造的に高く出て、同じ構造の本文でも言語によって本文/非本文の判定境界がずれる
 * (実測: 日本語0.66 / 英語0.30 と、リンクへの許容度が2倍以上ずれていた)。
 */

interface BlockTextStats {
  /** ブロック内の全テキスト。 */
  text: string;
  /** ブロック内のリンク(<a>)テキストのみ。 */
  linkText: string;
}

export interface BlockScore {
  /** 文・節の区切り(、。,.!?等)の語あたりの個数(0-1に丸める)。 */
  clauseBreaksPerWord: number;
  /** Unicode文字(英字・CJK等、\p{L}に一致する文字)がテキストに占める割合(0-1)。 */
  letterRatio: number;
  /** リンクテキストが全体テキストに占める割合(0-1)。 */
  linkDensity: number;
  /** 総合スコア。0以上を本文らしいブロックとみなす。 */
  score: number;
}

// 文・節の区切りはUnicodeのTerminal_Punctuation(、。,.!?、全角記号、デーヴァナーガリーの
// ダンダ等)で捉える。記号を個別に列挙すると、漏れた表記体系の本文が「文の無いテキスト」と
// 見なされる(全角?(U+FF1F)が列挙漏れしていた)。ただしコロン類は除く: 「1964年: 東京」形式の
// リンク一覧(ナビゲーションボックス・パンくず)で高密度に現れ、文の存在の証拠にならないため。
const CLAUSE_BREAK_CLASS = String.raw`[\p{Terminal_Punctuation}--[;:；：؛]]`;
// 数値内部の記号(1.1、1,000、3.14.6)は文の区切りではない。目次の節番号やバージョン番号だけで
// リンク一覧が本文と誤判定されるため、両隣が数字のものを除く。
const CLAUSE_BREAK_PATTERN = new RegExp(
  String.raw`(?<!\p{Nd})${CLAUSE_BREAK_CLASS}|${CLAUSE_BREAK_CLASS}(?!\p{Nd})`,
  "gv",
);
// 結合文字(\p{M})も文字として数える(NFD分解形のアクセント記号等で比率が不当に下がらないように)。
const LETTER_PATTERN = /[\p{L}\p{M}]/gu;
// UAX#29の語分割。スペース区切りの無い言語(日本語/中国語/タイ語等)にはICUの辞書分割が働くため、
// 「語」を分母に取れば文字あたり情報量の言語差を通さずに済む。
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

// スコア係数(設計判断): 区切りの密度を最重視(「文」の存在そのものが本文らしさの最も強い
// シグナル)、リンク密度は本文らしさを大きく減点する要因、文字比率は補助的な弱いシグナル
// (日本語のナビ/フッターも漢字を含み、英語のナビ/フッターも英字を含むため単独では
// 本文/非本文を判別できない)。CLAUSE_BREAK_WEIGHTは、Wikipedia実ページの本文段落
// (ja/en/de/ko/zh/fr)で日本語ページの判定境界が文字数分母時代と一致する値に較正している。
const CLAUSE_BREAK_WEIGHT = 22;
const LETTER_WEIGHT = 1;
const LINK_WEIGHT = 5;

function countWords(text: string): number {
  let count = 0;
  for (const segment of WORD_SEGMENTER.segment(text)) {
    if (segment.isWordLike === true) count++;
  }
  return count;
}

/** J4: ブロックのテキスト統計からスコアを算出する(純関数)。 */
export function scoreBlock(stats: BlockTextStats): BlockScore {
  const text = stats.text.trim();
  // 分母はコードポイント数で数える。正規表現matchの分子(コードポイント単位)と単位を揃えないと、
  // 補助面の文字(CJK拡張B等のサロゲートペア)を含むテキストで比率が過小評価される。
  const length = [...text].length;
  if (length === 0) {
    return { clauseBreaksPerWord: 0, letterRatio: 0, linkDensity: 0, score: 0 };
  }

  const clauseBreakCount = (text.match(CLAUSE_BREAK_PATTERN) ?? []).length;
  const wordCount = countWords(text);
  const clauseBreaksPerWord = wordCount === 0 ? 0 : Math.min(clauseBreakCount / wordCount, 1);

  const letterCount = (text.match(LETTER_PATTERN) ?? []).length;
  const letterRatio = letterCount / length;

  const linkTextLength = [...stats.linkText.trim()].length;
  const linkDensity = Math.min(linkTextLength / length, 1);

  const score = clauseBreaksPerWord * CLAUSE_BREAK_WEIGHT + letterRatio * LETTER_WEIGHT - linkDensity * LINK_WEIGHT;

  return { clauseBreaksPerWord, letterRatio, linkDensity, score };
}

export interface PruneOptions {
  /** これ未満の文字数のブロックはスコアリング対象外(除去しない)。既定20文字。 */
  minTextLength?: number;
  /** このスコア未満のブロックを低価値と判定する。既定0。 */
  scoreThreshold?: number;
}

const DEFAULT_MIN_TEXT_LENGTH = 20;
const DEFAULT_SCORE_THRESHOLD = 0;

/**
 * 常に除去対象とする非本文タグ(セマンティックに明確なナビ/フッター等)。
 * header/asideはここに含めない: HTML5では<article>/<section>/<main>内にネストして
 * 「そのセクション自身の見出しブロック」としても使われる(WordPress/Ghost/Hugo系ブログの
 * 標準構成 <article><header><h1>タイトル</h1><time>日付</time></header>...</article>)ため、
 * 記事内ネストの場合は下記INSIDE_ARTICLE_PRUNE_TAGSで個別に扱う。
 */
const ALWAYS_PRUNE_TAGS = new Set(["NAV", "FOOTER", "FORM"]);
/**
 * ページレベル(article/section/main の外)でのみ常に除去するタグ。記事内ネストの場合は
 * 除去せずスコアリング対象にも入れず温存し、Readabilityの本文判定に委ねる。
 */
const PAGE_LEVEL_ONLY_PRUNE_TAGS = new Set(["HEADER", "ASIDE"]);
/** insideArticleをtrueにする(=以降の子孫をネスト扱いにする)セマンティックコンテナタグ。 */
const ARTICLE_CONTAINER_TAGS = new Set(["ARTICLE", "SECTION", "MAIN"]);
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
 * 常に除去するタグ(nav/footer/form)はその場で除去し子孫を再帰評価しない。
 * header/asideはページレベル(article/section/main の外)でのみ常に除去し、記事内ネストは
 * 温存する(詳細はPAGE_LEVEL_ONLY_PRUNE_TAGSのコメント参照)。それ以外は先に子孫を
 * 再帰評価してから自身をスコアリングするボトムアップ走査にする
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

  const walk = (element: PruneHostElement, insideArticle: boolean): number => {
    let prunedCount = 0;

    for (const child of Array.from(element.children)) {
      const tag = child.tagName;

      if (ALWAYS_PRUNE_TAGS.has(tag)) {
        child.remove();
        prunedCount++;
        continue;
      }

      // header/asideはページレベル(article/section/main の外)でのみ常に除去する。
      // 記事内ネストは「そのセクションの見出しブロック」として温存し、子孫の再帰評価も行わない
      // (Readabilityの本文判定に委ねるため、スコアリング対象にも入れない)。
      if (PAGE_LEVEL_ONLY_PRUNE_TAGS.has(tag)) {
        if (!insideArticle) {
          child.remove();
          prunedCount++;
        }
        continue;
      }

      // 自身がarticle/section/mainなら、子孫はネスト扱い(insideArticle=true)にする。
      const childInsideArticle = insideArticle || ARTICLE_CONTAINER_TAGS.has(tag);

      // 先に子孫を刈ってから自身を評価する(ボトムアップ)。子孫のnav/footer等が
      // 除去された後の「クリーンな」テキスト/リンク密度で自身のスコアを判定するため。
      const descendantPrunedCount = walk(child, childInsideArticle);

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

  // rootそのものがarticle/section/main(アダプタのcontentSelectorsがそれらに一致する場合等)
  // であれば、その直下の子もネスト扱い(insideArticle=true)から開始する。
  return walk(root, ARTICLE_CONTAINER_TAGS.has(root.tagName));
}
