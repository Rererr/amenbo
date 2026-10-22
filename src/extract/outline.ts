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
const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

interface HeadingLine {
  lineIndex: number;
  level: number;
  text: string;
}

/** フェンスコードブロック内は見出しとして扱わないよう考慮しつつ、見出し行を収集する。 */
function findHeadingLines(lines: string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  let inFence = false;

  lines.forEach((line, lineIndex) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const match = HEADING_PATTERN.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      headings.push({ lineIndex, level: match[1].length, text: match[2].trim() });
    }
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
    }
    if (ownOwner) ownOwner.ownLines.push(...contentLines);
  }

  return emitted.map((section) => ({
    id: section.id,
    level: section.level,
    heading: section.heading,
    ancestors: section.ancestors,
    content: section.lines.join("\n"),
    // 末尾の空行の有無は意味的な差ではないため、比較用のownContentはtrimして正規化する
    // (前後の節の増減で「次の見出しの直前の空行の数」が変わるだけの見かけ上の差分を防ぐ)
    ownContent: section.ownLines.join("\n").trim(),
  }));
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

/** 節の内容から、見出し行を除いた本文の冒頭1文を抜き出す。 */
function extractExcerpt(content: string): string {
  const bodyLines = content.split("\n").filter((line) => !HEADING_PATTERN.test(line));
  const body = stripMarkdownLinks(bodyLines.join("\n")).trim();
  if (body.length === 0) return "";

  // 最初の文末記号を含む行の、行頭から文末記号までを1文とする。`/[^。!?\n]*[。!?]/u`で書くと
  // 文末記号の無い行で開始位置ごとに行末まで走査し直し、長い行で二次時間になる。
  const sentenceEnd = body.search(/[。!?]/u);
  const raw =
    sentenceEnd === -1
      ? (body.split("\n").find((l) => l.trim().length > 0) ?? "")
      : body.slice(body.lastIndexOf("\n", sentenceEnd) + 1, sentenceEnd + 1);
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
      excerpt: extractExcerpt(section.content),
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
