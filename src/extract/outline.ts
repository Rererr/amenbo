/**
 * extract/outline.ts — outlineモード。
 *
 * 変換済みMarkdownから見出しツリー(h1-h4)を抽出し、各節の冒頭1文+概算トークン数を
 * 返す(数百トークンに収める段階開示)。各節にはsection IDを付与し、
 * fetchツールの `section` パラメータでその節のMarkdown本文のみを取得できるようにする。
 *
 * 設計判断: section IDは見出しテキストのスラッグ化ではなく連番("s1","s2",...)にする。
 * 日本語見出しはローマ字化が一意に定まらずスラッグが不安定になるため、
 * 連番の方が単純・決定的で `section` パラメータとして扱いやすい。
 */
import { createFenceScanner } from "../markdownFence.js";
import { estimateTokens } from "../tokens.js";

export interface OutlineSection {
  id: string;
  level: number;
  heading: string;
  excerpt: string;
  tokens: number;
}

export interface OutlineResult {
  sections: OutlineSection[];
  totalTokens: number;
}

const MAX_OUTLINE_LEVEL = 4;
const EXCERPT_MAX_LENGTH = 80;
/**
 * 見出し行(`/^(#{1,6})\s+(.*)$/`)を判定する。正規表現のままにしないのは、`\s`に含まれ`.`に含まれない
 * 行終端文字(\r・U+2028・U+2029)が後ろにあると、`\s+`を1文字ずつ戻すたびに`.*`を走査し直し、
 * 長い空白の連続で二次時間になるから。`#`と空白の連続をどこで区切っても結果は変わらないため、
 * 前半を最長で取り、残りに行終端文字が無いかだけを見る。
 */
function matchHeading(line: string): { level: number; text: string } | null {
  const prefix = /^(#{1,6})\s+/.exec(line);
  if (!prefix?.[1]) return null;
  const text = line.slice(prefix[0].length);
  if (/[\n\r\u2028\u2029]/.test(text)) return null;
  return { level: prefix[1].length, text };
}

interface HeadingLine {
  lineIndex: number;
  level: number;
  text: string;
}

/** フェンスコードブロック内は見出しとして扱わないよう考慮しつつ、見出し行を収集する。 */
function findHeadingLines(lines: string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  const inCode = createFenceScanner();

  lines.forEach((line, lineIndex) => {
    if (inCode(line)) return;

    const heading = matchHeading(line);
    if (heading) headings.push({ lineIndex, level: heading.level, text: heading.text.trim() });
  });

  return headings;
}

/** 節の祖先見出し1つ分(breadcrumb用)。 */
export interface HeadingRef {
  level: number;
  heading: string;
}

export interface MarkdownSection {
  id: string;
  level: number;
  heading: string;
  /**
   * この節を内包する上位見出しの連なり(浅い順)。leaf節を単独取得したときに
   * 「この内容が何に属すか」の文脈(記事のargument構造)を失わないためのbreadcrumb。
   * トップレベル節では空配列。
   */
  ancestors: HeadingRef[];
  /** 見出し行自身+ネストした子見出しを含む、この節の全内容(Markdown)。fetchツールのsection取得用。 */
  content: string;
  /**
   * 見出し行自身+子見出し(h5/h6等、outlineには現れないもの含む)を挟まない直接の内容のみ。
   * 子節の変更が親節にも「変更あり」として伝播してしまうのを避けるため、diff.ts専用に用意する。
   */
  ownContent: string;
}

interface OpenSection extends MarkdownSection {
  lines: string[];
  ownLines: string[];
}

/**
 * 見出し行を境界に、ネストを考慮した節データを構築する。
 * 見出しが1つも無いページは、全文を単一のsection "s1" として扱う。
 * 最初の見出しより前に内容があれば、それを冒頭の節 "s0" として先頭に置く。
 * diff.ts(§3-3 差分応答)からも再利用される共通処理。
 */
export function splitSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split("\n");
  const headings = findHeadingLines(lines);

  if (headings.length === 0) {
    if (markdown.trim().length === 0) return [];
    return [{ id: "s1", level: 1, heading: "(見出しなし)", ancestors: [], content: markdown, ownContent: markdown }];
  }

  const stack: OpenSection[] = [];
  const emitted: OpenSection[] = [];
  let counter = 0;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (!heading) continue;

    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) {
      stack.pop();
    }

    counter++;
    const headingLine = lines[heading.lineIndex] ?? `${"#".repeat(heading.level)} ${heading.text}`;
    // whileループで上位より浅い見出しをpop済みのため、この時点のstackは丁度この節の祖先。
    const ancestors: HeadingRef[] = stack.map((open) => ({ level: open.level, heading: open.heading }));
    const section: OpenSection = {
      id: `s${counter}`,
      level: heading.level,
      heading: heading.text,
      ancestors,
      lines: [],
      ownLines: [],
      content: "",
      ownContent: "",
    };

    for (const open of stack) open.lines.push(headingLine);
    section.lines.push(headingLine);
    stack.push(section);
    if (heading.level <= MAX_OUTLINE_LEVEL) emitted.push(section);

    // h5/h6等outlineに現れない深い見出しの内容は、直近のemitted(h1-h4)祖先のownContentへ
    // 折り畳む(独立したdiffエントリを持たない代わりに、変更が検知されない事態を防ぐ)
    const ownOwner = [...stack].reverse().find((open) => open.level <= MAX_OUTLINE_LEVEL) ?? null;
    if (ownOwner) ownOwner.ownLines.push(headingLine);

    const contentStart = heading.lineIndex + 1;
    const contentEnd = headings[i + 1]?.lineIndex ?? lines.length;
    const contentLines = lines.slice(contentStart, contentEnd);
    for (const line of contentLines) {
      for (const open of stack) open.lines.push(line);
      // push(...contentLines)は引数展開のため、節が約15万行を超えるとスタックが溢れる。
      ownOwner?.ownLines.push(line);
    }
  }

  const sections = emitted.map((section) => ({
    id: section.id,
    level: section.level,
    heading: section.heading,
    ancestors: section.ancestors,
    content: section.lines.join("\n"),
    // 末尾の空行の有無は意味的な差ではないため、比較用のownContentはtrimして正規化する
    // (前後の節の増減で「次の見出しの直前の空行の数」が変わるだけの見かけ上の差分を防ぐ)
    ownContent: section.ownLines.join("\n").trim(),
  }));

  const preamble = lines.slice(0, headings[0]?.lineIndex ?? 0).join("\n").trim();
  // 冒頭を"s1"にしないのは、冒頭の有無で既存の節の番号がずれないようにするため。
  if (preamble.length > 0) {
    sections.unshift({ id: "s0", level: 1, heading: "(冒頭)", ancestors: [], content: preamble, ownContent: preamble });
  }
  return sections;
}

/**
 * リンク先(URL)部分の照合。`[^)]*`だと`\)`のような
 * エスケープされた括弧やWikipediaのFileリンク等の生の丸括弧で最初の`)`に
 * 早期マッチし、URLの残りがexcerptにプレーンテキストとして漏れる
 * (実測: `en.wikipedia.org/wiki/Tokyo`のoutlineで`.svg)`等の断片が複数節に露出)。
 * エスケープシーケンス(`\\.`)と1階層までバランスした生の括弧を許容して回避する
 * (CommonMarkは3階層までのネスト推奨だが、excerptの装飾除去用途では1階層で十分)。
 *
 * 正規表現`(?:\\.|[^()\\]|\([^()]*\))*\)`と同じ結果を返す。3つの選択肢は先頭1文字が重ならないので
 * 照合経路は1本に決まり、位置ごとの結果は開始位置に依らない。正規表現のままにしないのは、
 * `](`ごとに末尾まで照合し直すため`[](\)`の繰り返しのような入力で二次時間になるから。
 * 位置ごとの結果をmemoに残し、各位置を1回だけ判定して線形に保つ。
 */
const PAREN = /[()]/g;

function createDestinationMatcher(text: string): (from: number) => number {
  const memo = new Map<number, number>();
  return (from) => {
    const path: number[] = [];
    let pos = from;
    let end = -1;
    while (pos < text.length) {
      const known = memo.get(pos);
      if (known !== undefined) {
        end = known;
        break;
      }
      path.push(pos);
      const ch = text[pos];
      if (ch === ")") {
        end = pos + 1;
        break;
      }
      if (ch === "\\") {
        // 正規表現の`.`と同じく行終端文字はエスケープできない。
        if (pos + 1 >= text.length || "\n\r\u2028\u2029".includes(text[pos + 1] ?? "")) break;
        pos += 2;
      } else if (ch === "(") {
        PAREN.lastIndex = pos + 1;
        const next = PAREN.exec(text);
        if (next?.[0] !== ")") break;
        pos = next.index + 1;
      } else {
        pos++;
      }
    }
    for (const visited of path) memo.set(visited, end);
    return end;
  };
}

/**
 * `opener`(`[`か`![`)から始まる`opener label](destination)`をlabelへ置き換える。
 * `/\[([^\]]*)\]\(…\)/g`と同じ結果を返す。正規表現のままにしないのは、`[`ごとに次の`]`まで
 * 走査し直すため`[`が多く`](…)`が続かない入力で二次時間になるから。
 * 同じ`]`へ行き着く`[`の判定結果を使い回して線形に保つ。
 */
function replaceLinksWithLabel(text: string, opener: "[" | "!["): string {
  const matchDestination = createDestinationMatcher(text);
  let out = "";
  let copied = 0;
  let close = -1;
  let tailEnd = -1;
  let start = text.indexOf(opener);
  while (start !== -1) {
    const labelStart = start + opener.length;
    if (close < labelStart) {
      close = text.indexOf("]", labelStart);
      if (close === -1) break;
      tailEnd = text[close + 1] === "(" ? matchDestination(close + 2) : -1;
    }
    if (tailEnd === -1) {
      start = text.indexOf(opener, start + 1);
      continue;
    }
    out += text.slice(copied, start) + text.slice(labelStart, close);
    copied = tailEnd;
    start = text.indexOf(opener, tailEnd);
  }
  return out + text.slice(copied);
}

/**
 * Markdownのリンク/画像記法をテキストのみへ変換する(excerpt専用)。
 *
 * レビュー指摘対応: outlineのexcerptに`[text](url)`や`![alt](url)`、`(#cite_note-…)`等の
 * リンク記法がそのまま残ると、Wikipedia等で抜粋がURLだらけになりトークンノイズになる
 * (実測: `[臭腺](//ja.wikipedia.org/wiki/臭腺?...`のような露出)。excerptはあくまで
 * 見出し直下の要約1文であり、リンク先URLに意味は無いためテキストのみ残す。
 * 本文(section取得時のmarkdown)には手を加えず、excerpt生成時のみ適用する。
 */
function stripMarkdownLinks(text: string): string {
  return replaceLinksWithLabel(replaceLinksWithLabel(text, "!["), "[");
}

const LETTER = /\p{L}/u;
// Terminal_Punctuationは読点やコンマも含み文の途中で切れるため、文末はSentence_Terminalで判定する。
const SENTENCE_TERMINAL = /\p{Sentence_Terminal}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACELESS_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;
const OPENING_OR_SPACE = /[\s\p{Ps}\p{Pi}]/u;
// 行末のコロンの次の空でない行が、コードのフェンスかリストで始まる。
const BLOCK_AFTER_COLON = /(?:[ \t]*\n)+[ \t]*(?:`{3}|~{3}|[-*+][ \t]|\d+[.)][ \t])/y;
// 行末のコロンを文末とみなすのに要る、コロンまでの語の文字の数。ラベル(「最終更新日:」「**定員**:」)を除く。
// 後ろがコードかリストなら短い導入文(「次のとおり:」)も認め、それ以外は文と呼べる長さを求める。
const MIN_WORD_CHARS_BEFORE_COLON = 6;
const MIN_WORD_CHARS_BEFORE_COLON_WITHOUT_BLOCK = 20;

/**
 * 半角のピリオドは、直後が語の文字でなく、直前が空白や開き括弧でないときだけ文末にする
 * (`3.14`・`example.com`・`Apple Inc.の`・`「.」`は切らず、`document.¶`・`[RFC5234].`は切る)。半角の!?は、直後が語の文字でなければ
 * 文末にし、語の間に空白を置かない日本語・中国語の文字が続くときも文末にする(「完了!次に」)。
 * 全角の記号はいつでも文末。
 */
function endsWithTerminal(mark: string, previous: string | undefined, next: string | undefined): boolean {
  if (mark >= "\u0080") return true;
  const nextIsWord = next !== undefined && WORD_CHAR.test(next);
  if (mark === ".") return previous !== undefined && !OPENING_OR_SPACE.test(previous) && !nextIsWord;
  return !nextIsWord || SPACELESS_SCRIPT.test(next ?? "");
}

/**
 * 最初の文末の直後の位置を返す(無ければ-1)。行頭から文字(\p{L})が1つも無いうちの記号は
 * 文末にしない(番号付きリストの`1.`、節番号の`9.3.`)。
 */
function findSentenceEnd(text: string): number {
  let sawLetter = false;
  let wordChars = 0;
  const charAt = (index: number): string | undefined => {
    const codePoint = text.codePointAt(index);
    return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
  };
  let previous: string | undefined;
  for (let i = 0; i < text.length; ) {
    const ch = charAt(i) ?? "";
    const before = previous;
    previous = ch;
    i += ch.length;
    if (ch === "\n") {
      sawLetter = false;
      wordChars = 0;
    } else if (WORD_CHAR.test(ch)) {
      wordChars++;
      if (LETTER.test(ch)) sawLetter = true;
    } else if (!sawLetter) {
      continue;
    } else if (SENTENCE_TERMINAL.test(ch)) {
      if (endsWithTerminal(ch, before, charAt(i))) return i;
    } else if ((ch === ":" || ch === "：") && wordChars >= MIN_WORD_CHARS_BEFORE_COLON && /^[ \t]*(?:\n|$)/.test(text.slice(i, i + 80))) {
      // 行末のコロンは、後ろのコードやリストを導く文の終わり(「looks like this:」)。
      if (wordChars >= MIN_WORD_CHARS_BEFORE_COLON_WITHOUT_BLOCK) return i;
      BLOCK_AFTER_COLON.lastIndex = i;
      if (BLOCK_AFTER_COLON.test(text)) return i;
    }
  }
  return -1;
}

/** 節の自分の内容(子節を含まない)から、見出し行を除いた本文の冒頭1文を抜き出す。 */
function extractExcerpt(ownContent: string): string {
  const bodyLines = ownContent.split("\n").filter((line) => matchHeading(line) === null);
  const body = stripMarkdownLinks(bodyLines.join("\n")).trim();
  if (body.length === 0) return "";

  // 最初の文末記号を含む行の、行頭から文末記号までを1文とする。
  const sentenceEnd = findSentenceEnd(body);
  const raw =
    sentenceEnd === -1
      ? (body.split("\n").find((l) => l.trim().length > 0) ?? "")
      : body.slice(body.lastIndexOf("\n", sentenceEnd - 1) + 1, sentenceEnd);
  return raw.trim().slice(0, EXCERPT_MAX_LENGTH);
}

/** 見出しツリー(h1-h4)+各節冒頭1文+概算トークン数の一覧を作る。 */
export function buildOutline(markdown: string): OutlineResult {
  const sections = splitSections(markdown);
  return {
    sections: sections.map((section) => ({
      id: section.id,
      level: section.level,
      heading: section.heading,
      excerpt: extractExcerpt(section.ownContent),
      tokens: estimateTokens(section.content),
    })),
    totalTokens: estimateTokens(markdown),
  };
}

/** section IDに対応する節(祖先breadcrumb含む)を取得する。無ければnull。 */
export function findSection(markdown: string, sectionId: string): MarkdownSection | null {
  const sections = splitSections(markdown);
  return sections.find((section) => section.id === sectionId) ?? null;
}

/** section IDに対応する節のMarkdown本文(ネストした子見出しを含む)を取得する。無ければnull。 */
export function extractSection(markdown: string, sectionId: string): string | null {
  return findSection(markdown, sectionId)?.content ?? null;
}

/**
 * 節の祖先見出しを ` › ` 区切りのbreadcrumb文字列にする。祖先が無ければnull。
 * leaf節を単独取得したときに「この内容が何に属すか」をヘッダで補うために使う。
 */
export function formatBreadcrumb(ancestors: HeadingRef[]): string | null {
  if (ancestors.length === 0) return null;
  // 見出しにMarkdownリンク記法が残るとbreadcrumbがURL断片で汚れる(MDN等の
  // アンカー付き見出し)。excerptと同様、リンク先URLに意味は無いためテキストのみ残す。
  return ancestors.map((a) => stripMarkdownLinks(a.heading).trim()).join(" › ");
}
