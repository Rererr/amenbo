import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * code-reviewer指摘: cli.test.ts はparseCliArgs(純関数)のみを検証しており、run()本体
 * (実際のディスパッチ・エラー分類・終了コード・後始末)が未検証だった。
 * core.ts(handleFetchTool等)・links.ts(discoverLinks)・server.ts(runServer)・
 * fetcher/browser.ts(closeBrowser)を全てモックし、実ネットワーク/実ブラウザ起動無しで
 * run()の主要経路を検証する。
 */
const handleFetchToolMock = vi.fn();
const handleScreenshotToolMock = vi.fn();
const discoverLinksMock = vi.fn();
const runServerMock = vi.fn();
const closeBrowserMock = vi.fn();
const cacheCloseMock = vi.fn();

// Windows CI対応: モックはexport上の`cache`を`{ close: cacheCloseMock }`へ丸ごと差し替えるため、
// このモック経由では実PageCacheのハンドルへ到達できない。importOriginal()が返す実core.tsの
// シングルトン(actual.cache)への参照をここで捕まえておき、afterAllでの後始末(Windowsでの
// SQLiteファイルロック回避)に使う(詳細はtests/helpers/tempCache.tsのコメント参照)。
let actualCache: { close: () => void } | null = null;

vi.mock("../src/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core.js")>();
  actualCache = actual.cache;
  return {
    ...actual,
    handleFetchTool: (...args: Parameters<typeof actual.handleFetchTool>) => handleFetchToolMock(...args),
    handleScreenshotTool: (...args: Parameters<typeof actual.handleScreenshotTool>) => handleScreenshotToolMock(...args),
    // cache/politenessはcore.tsのシングルトンを丸ごと差し替える(実SQLite/実ネットワークを避ける)。
    cache: { close: cacheCloseMock },
  };
});

vi.mock("../src/links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/links.js")>();
  return { ...actual, discoverLinks: (...args: Parameters<typeof actual.discoverLinks>) => discoverLinksMock(...args) };
});

vi.mock("../src/server.js", () => ({
  runServer: () => runServerMock(),
}));

vi.mock("../src/fetcher/browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/browser.js")>();
  return { ...actual, closeBrowser: () => closeBrowserMock() };
});

const installBrowserMock = vi.fn();
vi.mock("../src/installBrowser.js", () => ({
  installBrowser: () => installBrowserMock(),
}));

// core.tsはモジュール読み込み時にPageCacheを既定のキャッシュディレクトリに生成する副作用を持つ
// (上のvi.mockはimportOriginal()経由で実core.tsを一度読み込むため、この副作用は避けられない)。
// 実ユーザーのキャッシュを汚さないよう一時ディレクトリへ退避してからimportする。
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-cli-run-test-cache-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { run, writeBlocks } = await import("../src/cli.js");
const { RobotsDeniedError } = await import("../src/errors.js");

const outDir = mkdtempSync(join(tmpdir(), "amenbo-cli-run-test-out-"));

afterAll(() => {
  // Windows CI対応: 開いたままのSQLiteファイルハンドルを解放してから削除する
  // (詳細はtests/helpers/tempCache.tsのコメント参照)。outDirはSQLiteと無関係のため
  // closeCache不要だがベストエフォート削除の恩恵は共通で受けられる。
  cleanupCacheDir(cacheDir, () => actualCache?.close());
  cleanupCacheDir(outDir);
});

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  handleFetchToolMock.mockReset();
  handleScreenshotToolMock.mockReset();
  discoverLinksMock.mockReset();
  runServerMock.mockReset();
  closeBrowserMock.mockReset().mockResolvedValue(undefined);
  cacheCloseMock.mockReset();
  installBrowserMock.mockReset();
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

/** outDir配下に保存された唯一のファイル名を返す(ファイル名にはURL由来のハッシュが入る)。 */
function onlySavedName(dir: string): string {
  const names = readdirSync(dir);
  expect(names).toHaveLength(1);
  return names[0]!;
}

describe("run() - CLIサブコマンドの主要経路", () => {
  it("正常なfetchはexit code 0で終了し、TextBlockを標準出力へ書く", async () => {
    handleFetchToolMock.mockResolvedValue([{ type: "text", text: "hello" }]);

    const exitCode = await run(["fetch", "https://example.com/"]);

    expect(exitCode).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith("hello\n");
    expect(closeBrowserMock).toHaveBeenCalledTimes(1);
    expect(cacheCloseMock).toHaveBeenCalledTimes(1);
  });

  it("引数不正はexit code 2でusageをstderrへ書き、後始末(closeBrowser/cache.close)は呼ばない", async () => {
    const exitCode = await run(["fetch"]);

    expect(exitCode).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain("URLを指定してください");
    expect(closeBrowserMock).not.toHaveBeenCalled();
    expect(cacheCloseMock).not.toHaveBeenCalled();
  });

  it("AmenboErrorはメッセージのみstderrへ書きexit code 1になる(スタックトレースを出さない)", async () => {
    handleFetchToolMock.mockRejectedValue(new RobotsDeniedError("https://example.com/"));

    const exitCode = await run(["fetch", "https://example.com/"]);

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("robots.txt によりアクセスが拒否されています"));
    // AmenboError発生時もcloseBrowser/cache.closeによる後始末は必ず行われる
    expect(closeBrowserMock).toHaveBeenCalledTimes(1);
    expect(cacheCloseMock).toHaveBeenCalledTimes(1);
  });

  it("AmenboError以外のエラーはconsole.errorでスタック付きログを出しexit code 1になる", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    handleFetchToolMock.mockRejectedValue(new Error("boom"));

    const exitCode = await run(["fetch", "https://example.com/"]);

    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(closeBrowserMock).toHaveBeenCalledTimes(1);
    expect(cacheCloseMock).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it("ImageBlockは--out-dir配下へファイル保存し、保存パスを標準出力へ列挙する", async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71]);
    handleScreenshotToolMock.mockResolvedValue([
      { type: "text", text: "header" },
      { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
    ]);

    const exitCode = await run(["screenshot", "https://example.com/", "--out-dir", outDir]);

    expect(exitCode).toBe(0);
    const expectedPath = join(outDir, onlySavedName(outDir));
    expect(readFileSync(expectedPath)).toEqual(pngBytes);
    const writtenChunks = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(writtenChunks).toContain(expectedPath);
  });

  it("レビュー指摘対応(Medium): fetchがscreenshotへ自動切替した場合、--out-dir未指定時はcwdでなく$AMENBO_CACHE_DIR/screenshots-cli/配下へ保存する", async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71]);
    handleFetchToolMock.mockResolvedValue([
      { type: "text", text: "header" },
      { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" },
    ]);

    const exitCode = await run(["fetch", "https://example.com/"]);

    expect(exitCode).toBe(0);
    const screenshotsDir = join(cacheDir, "screenshots-cli");
    const expectedPath = join(screenshotsDir, onlySavedName(screenshotsDir));
    expect(readFileSync(expectedPath)).toEqual(pngBytes);
    const writtenChunks = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(writtenChunks).toContain(expectedPath);
  });

  it("レビュー指摘対応(Medium): fetchで--out-dirを明示指定した場合はそちらを尊重する(cwd/screenshots-cliではない)", async () => {
    const pngBytes = Buffer.from([137, 80, 78, 71]);
    handleFetchToolMock.mockResolvedValue([{ type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" }]);

    const exitCode = await run(["fetch", "https://example.com/", "--out-dir", outDir]);

    expect(exitCode).toBe(0);
    const expectedPath = join(outDir, onlySavedName(outDir));
    expect(readFileSync(expectedPath)).toEqual(pngBytes);
  });

  it("linksコマンドはdiscoverLinksの結果をformatLinksResponse経由で標準出力へ書く", async () => {
    discoverLinksMock.mockResolvedValue({
      source: "page",
      links: [{ url: "https://example.com/a", title: "A" }],
      truncated: false,
      preFilterCount: 1,
    });

    const exitCode = await run(["links", "https://example.com/"]);

    expect(exitCode).toBe(0);
    const writtenChunks = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(writtenChunks).toContain("https://example.com/a");
    expect(closeBrowserMock).toHaveBeenCalledTimes(1);
    expect(cacheCloseMock).toHaveBeenCalledTimes(1);
  });

  it("レビュー指摘対応: filterで全件落ちた場合、フィルタ前の件数を応答に明示する", async () => {
    discoverLinksMock.mockResolvedValue({
      source: "page",
      links: [],
      truncated: false,
      preFilterCount: 3,
    });

    const exitCode = await run(["links", "https://example.com/", "--filter", "nomatch"]);

    expect(exitCode).toBe(0);
    const writtenChunks = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(writtenChunks).toContain("フィルタ前 3 件");
  });

  it("レビュー指摘対応: フィルタ前も0件なら従来の「リンクが見つかりませんでした」のままにする", async () => {
    discoverLinksMock.mockResolvedValue({
      source: "page",
      links: [],
      truncated: false,
      preFilterCount: 0,
    });

    const exitCode = await run(["links", "https://example.com/"]);

    expect(exitCode).toBe(0);
    const writtenChunks = stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(writtenChunks).toContain("(リンクが見つかりませんでした)");
    expect(writtenChunks).not.toContain("フィルタ前");
  });

  it("install-browserコマンドはinstallBrowser()を呼び、その終了コードをそのまま返す", async () => {
    installBrowserMock.mockResolvedValue(0);

    const exitCode = await run(["install-browser"]);

    expect(exitCode).toBe(0);
    expect(installBrowserMock).toHaveBeenCalledTimes(1);
    expect(closeBrowserMock).toHaveBeenCalledTimes(1);
    expect(cacheCloseMock).toHaveBeenCalledTimes(1);
  });

  it("install-browserが非0終了した場合はその終了コードをそのまま返す", async () => {
    installBrowserMock.mockResolvedValue(1);

    const exitCode = await run(["install-browser"]);

    expect(exitCode).toBe(1);
  });

  it("serveコマンド(引数なし)はrunServerを呼び、closeBrowser/cache.closeは呼ばない(プロセス継続のため)", async () => {
    runServerMock.mockResolvedValue(undefined);

    const exitCode = await run([]);

    expect(exitCode).toBe(0);
    expect(runServerMock).toHaveBeenCalledTimes(1);
    expect(closeBrowserMock).not.toHaveBeenCalled();
    expect(cacheCloseMock).not.toHaveBeenCalled();
  });
});

describe("writeBlocks() - ImageBlockのファイル保存とパス生成", () => {
  /** outDir配下のPNGファイル名を列挙する。 */
  function savedNames(dir: string): string[] {
    return readdirSync(dir).sort();
  }

  it("複数のImageBlockは連番付きファイル名(amenbo-<hostname>-<URLハッシュ>-<連番>.png)で保存される", () => {
    const dir = mkdtempSync(join(tmpdir(), "amenbo-write-blocks-test-"));
    try {
      const png1 = Buffer.from([1, 2, 3]);
      const png2 = Buffer.from([4, 5, 6]);
      writeBlocks(
        [
          { type: "text", text: "header" },
          { type: "image", data: png1.toString("base64"), mimeType: "image/png" },
          { type: "image", data: png2.toString("base64"), mimeType: "image/png" },
        ],
        "https://blog.example.co.jp/posts/1",
        dir,
      );

      const names = savedNames(dir);
      expect(names).toHaveLength(2);
      expect(names[0]).toMatch(/^amenbo-blog\.example\.co\.jp-[0-9a-f]{12}-1\.png$/);
      expect(readFileSync(join(dir, names[0]!))).toEqual(png1);
      expect(readFileSync(join(dir, names[1]!))).toEqual(png2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同じホストの別ページを同じout-dirへ保存しても上書きしない", () => {
    const dir = mkdtempSync(join(tmpdir(), "amenbo-write-blocks-test-"));
    try {
      const first = Buffer.from([1]);
      const second = Buffer.from([2]);
      writeBlocks([{ type: "image", data: first.toString("base64"), mimeType: "image/png" }], "https://example.com/a", dir);
      writeBlocks([{ type: "image", data: second.toString("base64"), mimeType: "image/png" }], "https://example.com/b", dir);

      const names = savedNames(dir);
      expect(names).toHaveLength(2);
      expect(new Set(names.map((name) => readFileSync(join(dir, name)).toString("hex")))).toEqual(new Set(["01", "02"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同じURLの撮り直しは同じファイル名になる(これまで通り上書きされる)", () => {
    const dir = mkdtempSync(join(tmpdir(), "amenbo-write-blocks-test-"));
    try {
      writeBlocks([{ type: "image", data: Buffer.from([1]).toString("base64"), mimeType: "image/png" }], "https://example.com/a", dir);
      writeBlocks([{ type: "image", data: Buffer.from([2]).toString("base64"), mimeType: "image/png" }], "https://example.com/a", dir);

      const names = savedNames(dir);
      expect(names).toHaveLength(1);
      expect(readFileSync(join(dir, names[0]!))).toEqual(Buffer.from([2]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不正なURLでもhostnameは'page'にフォールバックし、保存自体は失敗しない", () => {
    const dir = mkdtempSync(join(tmpdir(), "amenbo-write-blocks-test-"));
    try {
      const png = Buffer.from([9]);
      writeBlocks([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], "not a url", dir);
      const names = savedNames(dir);
      expect(names[0]).toMatch(/^amenbo-page-[0-9a-f]{12}-1\.png$/);
      expect(readFileSync(join(dir, names[0]!))).toEqual(png);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("TextBlockのみの場合はファイルを作らない(outDir配下に何も生成しない)", () => {
    const dir = mkdtempSync(join(tmpdir(), "amenbo-write-blocks-test-"));
    try {
      writeBlocks([{ type: "text", text: "hello" }], "https://example.com/", dir);
      expect(stdoutSpy).toHaveBeenCalledWith("hello\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
