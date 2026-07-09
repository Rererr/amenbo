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

interface SectionData {
  id: string;
  level: number;
  heading: string;
  /** 見出し行自身+ネストした子見出しを含む、この節の全内容(Markdown)。 */
  content: string;
}

interface OpenSection extends SectionData {
  lines: string[];
}

/**
 * 見出し行を境界に、ネストを考慮した節データを構築する(内部共通処理)。
 * 見出しが1つも無いページは、全文を単一のsection "s1" として扱う。
 */
function computeSections(markdown: string): SectionData[] {
  const lines = markdown.split("\n");
  const headings = findHeadingLines(lines);

  if (headings.length === 0) {
    if (markdown.trim().length === 0) return [];
    return [{ id: "s1", level: 1, heading: "(見出しなし)", content: markdown }];
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
    const section: OpenSection = {
      id: `s${counter}`,
      level: heading.level,
      heading: heading.text,
      lines: [],
      content: "",
    };

    for (const open of stack) open.lines.push(headingLine);
    section.lines.push(headingLine);
    stack.push(section);
    if (heading.level <= MAX_OUTLINE_LEVEL) emitted.push(section);

    const contentStart = heading.lineIndex + 1;
    const contentEnd = headings[i + 1]?.lineIndex ?? lines.length;
    for (const line of lines.slice(contentStart, contentEnd)) {
      for (const open of stack) open.lines.push(line);
    }
  }

  return emitted.map((section) => ({ id: section.id, level: section.level, heading: section.heading, content: section.lines.join("\n") }));
}

/** 節の内容から、見出し行を除いた本文の冒頭1文を抜き出す。 */
function extractExcerpt(content: string): string {
  const bodyLines = content.split("\n").filter((line) => !HEADING_PATTERN.test(line));
  const body = bodyLines.join("\n").trim();
  if (body.length === 0) return "";

  const sentenceMatch = /[^。!?\n]*[。!?]/u.exec(body);
  const raw = sentenceMatch ? sentenceMatch[0] : (body.split("\n").find((l) => l.trim().length > 0) ?? "");
  return raw.trim().slice(0, EXCERPT_MAX_LENGTH);
}

/** 見出しツリー(h1-h4)+各節冒頭1文+概算トークン数の一覧を作る。 */
export function buildOutline(markdown: string): OutlineResult {
  const sections = computeSections(markdown);
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

/** section IDに対応する節のMarkdown本文(ネストした子見出しを含む)を取得する。無ければnull。 */
export function extractSection(markdown: string, sectionId: string): string | null {
  const sections = computeSections(markdown);
  return sections.find((section) => section.id === sectionId)?.content ?? null;
}
