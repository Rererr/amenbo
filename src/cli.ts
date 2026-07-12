#!/usr/bin/env node
/**
 * cli.ts — amenboのコマンドラインエントリ。MCPサーバー(server.ts)と同一のコア(core.ts)を
 * 共有し、シェルスクリプト/CI/デバッグ用途で同じfetch/links/screenshotをコマンドとして使えるようにする。
 *
 * - 引数なし、または `amenbo serve` はMCPサーバーとして起動する(既存の.mcp.jsonの
 *   `"command": "amenbo"` との後方互換のため最重要)。
 * - `amenbo fetch/links/screenshot <url> [options]` は対応するcore.tsのハンドラを呼び、
 *   TextBlockはそのまま標準出力へ、ImageBlock(スクリーンショット/スキャンPDF画像)は
 *   --out-dir配下へファイル保存しパスを列挙する(エージェント/ユーザーがそのまま開けるように)。
 * - `amenbo install-browser` はChromium遅延化(postinstall廃止)対応で追加したコマンド。
 *   core.tsは経由せず、installBrowser.tsが同梱playwrightのCLIをspawnする。
 * - 引数パース(parseCliArgs)は純関数として切り出し、ユニットテストできるようにしている。
 * - キャッシュ・差分応答・レート制御の状態はMCPサーバーと同じ ~/.cache/amenbo (cache.ts)を
 *   共有する。CLIは1コマンド=1プロセスのため、politenessのドメイン毎レート制御は
 *   core.ts側でcacheをstoreとして注入したPolitenessManagerがプロセス間永続化する。
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveCacheDir } from "./cache.js";
import {
  cache,
  formatLinksResponse,
  handleFetchTool,
  handleScreenshotTool,
  politeness,
  resolvePackageVersion,
  type FetchToolInput,
  type ImageBlock,
  type ScreenshotToolInput,
  type TextBlock,
} from "./core.js";
import { AmenboError } from "./errors.js";
import { closeBrowser } from "./fetcher/browser.js";
import { installBrowser } from "./installBrowser.js";
import { discoverLinks } from "./links.js";
import { MAX_SCALE, MIN_SCALE } from "./screenshot.js";
import { runServer } from "./server.js";

// ---- 引数パース(純関数。ユニットテスト対象) ----

/** 引数の使い方が不正な場合に投げる(cli.ts側でusageを表示しexit code 2にする)。 */
export class CliUsageError extends Error {}

const FETCH_MODES = ["auto", "markdown", "outline", "screenshot"] as const;
export type CliFetchMode = (typeof FETCH_MODES)[number];

export type ParsedCommand =
  | { kind: "serve" }
  | { kind: "version" }
  | { kind: "help"; topic?: "fetch" | "links" | "screenshot" | "install-browser" }
  | { kind: "install-browser" }
  | ParsedFetchCommand
  | ParsedLinksCommand
  | ParsedScreenshotCommand;

export interface ParsedFetchCommand {
  kind: "fetch";
  url: string;
  mode?: CliFetchMode;
  selector?: string;
  section?: string;
  page?: number;
  maxTokens?: number;
  forceFull?: boolean;
  outDir?: string;
}

export interface ParsedLinksCommand {
  kind: "links";
  url: string;
  filter?: string;
}

export interface ParsedScreenshotCommand {
  kind: "screenshot";
  url: string;
  viewportOnly?: boolean;
  width?: number;
  scale?: number;
  outDir?: string;
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliUsageError(`${flag}は正の整数で指定してください: ${raw}`);
  }
  return n;
}

function parsePositiveFloat(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliUsageError(`${flag}は正の数値で指定してください: ${raw}`);
  }
  return n;
}

/**
 * レビュー指摘対応(Low): --scaleはparsePositiveFloatを通すだけで[0.5,1.0]範囲を検証しておらず、
 * `--scale 3.0`のような範囲外値がscreenshot.ts clampScaleで黙って1.0にクランプされていた。
 * MCP側はzod .min(0.5).max(1.0)で明示的にエラーになるため、CLIも同じ強度の検証で揃える。
 */
function parseScreenshotScale(raw: string): number {
  const n = parsePositiveFloat(raw, "--scale");
  if (n < MIN_SCALE || n > MAX_SCALE) {
    throw new CliUsageError(`--scaleは${MIN_SCALE}〜${MAX_SCALE}の範囲で指定してください: ${raw}`);
  }
  return n;
}

function requireUrl(positionals: string[], command: string): string {
  const url = positionals[0];
  if (!url) {
    throw new CliUsageError(`${command}: URLを指定してください`);
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`${command}: 不明な引数です: ${positionals[1]}`);
  }
  return url;
}

/** node:util parseArgsの例外(不明なオプション等)をCliUsageErrorへ変換する。 */
function safeParseArgs<const T extends Record<string, { type: "string" | "boolean"; short?: string }>>(
  args: string[],
  command: string,
  options: T,
): { values: Partial<{ [K in keyof T]: T[K]["type"] extends "boolean" ? boolean : string }>; positionals: string[] } {
  try {
    // node:util parseArgsは第2型引数を渡さなくてもoptions定義から値の型を推論するが、
    // このジェネリックラッパー越しだと推論が効かないため戻り値側で明示キャストする。
    const result = parseArgs({ args, allowPositionals: true, options });
    return result as unknown as { values: Partial<{ [K in keyof T]: T[K]["type"] extends "boolean" ? boolean : string }>; positionals: string[] };
  } catch (error) {
    throw new CliUsageError(`${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFetchArgs(args: string[]): ParsedCommand {
  const { values, positionals } = safeParseArgs(args, "fetch", {
    mode: { type: "string" },
    selector: { type: "string" },
    section: { type: "string" },
    page: { type: "string" },
    "max-tokens": { type: "string" },
    "force-full": { type: "boolean" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  });

  if (values.help) return { kind: "help", topic: "fetch" };

  const url = requireUrl(positionals, "fetch");

  if (values.mode !== undefined && !(FETCH_MODES as readonly string[]).includes(values.mode)) {
    throw new CliUsageError(`fetch: --modeは${FETCH_MODES.join("/")}のいずれかで指定してください: ${values.mode}`);
  }

  return {
    kind: "fetch",
    url,
    ...(values.mode !== undefined ? { mode: values.mode as CliFetchMode } : {}),
    ...(values.selector !== undefined ? { selector: values.selector } : {}),
    ...(values.section !== undefined ? { section: values.section } : {}),
    ...(values.page !== undefined ? { page: parsePositiveInt(values.page, "--page") } : {}),
    ...(values["max-tokens"] !== undefined ? { maxTokens: parsePositiveInt(values["max-tokens"], "--max-tokens") } : {}),
    ...(values["force-full"] ? { forceFull: true } : {}),
    ...(values["out-dir"] !== undefined ? { outDir: values["out-dir"] } : {}),
  };
}

function parseLinksArgs(args: string[]): ParsedCommand {
  const { values, positionals } = safeParseArgs(args, "links", {
    filter: { type: "string" },
    help: { type: "boolean", short: "h" },
  });

  if (values.help) return { kind: "help", topic: "links" };

  const url = requireUrl(positionals, "links");
  return {
    kind: "links",
    url,
    ...(values.filter !== undefined ? { filter: values.filter } : {}),
  };
}

function parseScreenshotArgs(args: string[]): ParsedCommand {
  const { values, positionals } = safeParseArgs(args, "screenshot", {
    "viewport-only": { type: "boolean" },
    width: { type: "string" },
    scale: { type: "string" },
    "out-dir": { type: "string" },
    help: { type: "boolean", short: "h" },
  });

  if (values.help) return { kind: "help", topic: "screenshot" };

  const url = requireUrl(positionals, "screenshot");
  return {
    kind: "screenshot",
    url,
    ...(values["viewport-only"] ? { viewportOnly: true } : {}),
    ...(values.width !== undefined ? { width: parsePositiveInt(values.width, "--width") } : {}),
    ...(values.scale !== undefined ? { scale: parseScreenshotScale(values.scale) } : {}),
    ...(values["out-dir"] !== undefined ? { outDir: values["out-dir"] } : {}),
  };
}

function parseInstallBrowserArgs(args: string[]): ParsedCommand {
  const { values, positionals } = safeParseArgs(args, "install-browser", { help: { type: "boolean", short: "h" } });

  if (values.help) return { kind: "help", topic: "install-browser" };
  if (positionals.length > 0) {
    throw new CliUsageError(`install-browser: 不明な引数です: ${positionals[0]}`);
  }
  return { kind: "install-browser" };
}

/** CLI引数(process.argv.slice(2)相当)をコマンドへパースする純関数。 */
export function parseCliArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) return { kind: "serve" };

  const [first, ...rest] = argv;

  if (first === "--version" || first === "-v") return { kind: "version" };
  if (first === "--help" || first === "-h") return { kind: "help" };
  if (first === "serve") return { kind: "serve" };
  if (first === "fetch") return parseFetchArgs(rest);
  if (first === "links") return parseLinksArgs(rest);
  if (first === "screenshot") return parseScreenshotArgs(rest);
  if (first === "install-browser") return parseInstallBrowserArgs(rest);

  throw new CliUsageError(`不明なコマンドです: ${first}`);
}

// ---- ヘルプ/usage文言 ----

function usageText(): string {
  return [
    "amenbo [command] [options]",
    "",
    "Commands:",
    "  serve                          MCPサーバーとして起動する(既定。引数省略時と同じ)",
    "  fetch <url> [options]          ページをMarkdownとして取得する",
    "  links <url> [options]          ページ内のリンクを列挙する(sitemap/RSS優先)",
    "  screenshot <url> [options]     ページのスクリーンショットを撮影する",
    "  install-browser                スクリーンショット/SPA取得に必要なChromiumをインストールする(初回のみ)",
    "",
    "Options:",
    "  -h, --help       ヘルプを表示する",
    "  -v, --version    バージョンを表示する",
    "",
    "各コマンドの詳細は `amenbo <command> --help` を参照してください。",
  ].join("\n");
}

function fetchHelpText(): string {
  return [
    "amenbo fetch <url> [options]",
    "",
    "Options:",
    "  --mode <auto|markdown|outline|screenshot>   取得モード(既定 auto)",
    "  --selector <css>                            本文を絞り込むCSSセレクタ",
    "  --section <id>                              outlineで得たsection ID。その節のMarkdownのみ返す",
    "  --page <n>                                  ページ番号(既定 1)",
    "  --max-tokens <n>                             1ページの概算トークン上限(既定 8000)",
    "  --force-full                                 差分応答(unchanged/diff)と定型ブロック除去を無効化し常に全文を返す",
    "  --out-dir <dir>                              screenshot切替時の画像保存先(既定 $AMENBO_CACHE_DIR/screenshots-cli/、未設定時は ~/.cache/amenbo/screenshots-cli/)",
  ].join("\n");
}

function linksHelpText(): string {
  return ["amenbo links <url> [options]", "", "Options:", "  --filter <pattern>   URL/リンクテキストの部分一致、または*を使ったglob"].join("\n");
}

function screenshotHelpText(): string {
  return [
    "amenbo screenshot <url> [options]",
    "",
    "Options:",
    "  --viewport-only     最初のビューポート分のみ撮影する(既定はfullPage)",
    "  --width <n>         タイル幅px(既定 1280)",
    "  --scale <x>         解像度スケール(0.5〜1.0、既定 1.0)。小さいほど画像トークンが減る",
    "  --out-dir <dir>     画像保存先(既定 カレントディレクトリ)",
  ].join("\n");
}

function installBrowserHelpText(): string {
  return [
    "amenbo install-browser",
    "",
    "スクリーンショット撮影やSPA(JavaScriptレンダリング必須)ページの取得に必要なChromiumを",
    "インストールする(初回のみ、約170MBのダウンロード)。通常のHTTP取得(fetch/linksの大半)は",
    "この操作なしで動作する。amenboに同梱されたバージョンのplaywright CLIを使うため、",
    "バージョン不一致は起こらない。",
  ].join("\n");
}

function helpText(topic: "fetch" | "links" | "screenshot" | "install-browser" | undefined): string {
  if (topic === "fetch") return fetchHelpText();
  if (topic === "links") return linksHelpText();
  if (topic === "screenshot") return screenshotHelpText();
  if (topic === "install-browser") return installBrowserHelpText();
  return usageText();
}

// ---- 出力(TextBlockはstdout、ImageBlockはファイル保存) ----

/**
 * レビュー指摘対応(Medium・ユーザー確定仕様): `amenbo fetch`(mode auto)が品質低下でscreenshotへ
 * 自動切替した場合の画像既定保存先。以前はoutDir未指定時にprocess.cwd()を使っており、
 * リポジトリ直下等カレントディレクトリを黙って汚していた。cache.tsのキャッシュディレクトリ
 * 解決ロジック(AMENBO_CACHE_DIR ?? ~/.cache/amenbo)を再利用し、その配下のscreenshots-cli/へ
 * 保存する(実撮影キャッシュのscreenshots/とは別ディレクトリ)。screenshotサブコマンドは
 * 明示的な視覚確認用途のため対象外(--out-dir未指定時は従来通りcwd)。
 */
function resolveFetchScreenshotDir(): string {
  return join(resolveCacheDir(), "screenshots-cli");
}

/** ファイル名として安全なホスト名(取れなければ"page")。amenbo-<hostname>-<連番>.pngの命名に使う。 */
function hostnameForFilename(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^A-Za-z0-9.-]/g, "_") || "page";
  } catch {
    return "page";
  }
}

/** TextBlockは標準出力へ、ImageBlockはoutDir配下へ保存しパスを列挙する。テスト用export。 */
export function writeBlocks(blocks: Array<TextBlock | ImageBlock>, url: string, outDir: string): void {
  const hostname = hostnameForFilename(url);
  const savedPaths: string[] = [];
  let sequence = 0;

  for (const block of blocks) {
    if (block.type === "text") {
      process.stdout.write(`${block.text}\n`);
      continue;
    }
    sequence++;
    if (savedPaths.length === 0) {
      mkdirSync(outDir, { recursive: true });
    }
    const extension = block.mimeType === "image/png" ? "png" : "bin";
    const filePath = join(outDir, `amenbo-${hostname}-${sequence}.${extension}`);
    writeFileSync(filePath, Buffer.from(block.data, "base64"));
    savedPaths.push(filePath);
  }

  if (savedPaths.length > 0) {
    process.stdout.write(`\n画像を保存しました:\n${savedPaths.map((filePath) => `- ${filePath}`).join("\n")}\n`);
  }
}

// ---- 実行 ----

async function dispatch(command: ParsedFetchCommand | ParsedLinksCommand | ParsedScreenshotCommand): Promise<void> {
  if (command.kind === "fetch") {
    const input: FetchToolInput = {
      url: command.url,
      ...(command.mode !== undefined ? { mode: command.mode } : {}),
      ...(command.selector !== undefined ? { selector: command.selector } : {}),
      ...(command.section !== undefined ? { section: command.section } : {}),
      ...(command.page !== undefined ? { page: command.page } : {}),
      ...(command.maxTokens !== undefined ? { max_tokens: command.maxTokens } : {}),
      ...(command.forceFull !== undefined ? { force_full: command.forceFull } : {}),
    };
    const blocks = await handleFetchTool(input);
    writeBlocks(blocks, command.url, command.outDir ?? resolveFetchScreenshotDir());
    return;
  }

  if (command.kind === "links") {
    const result = await discoverLinks(command.url, politeness, command.filter !== undefined ? { filter: command.filter } : {});
    process.stdout.write(`${formatLinksResponse(command.url, result)}\n`);
    return;
  }

  const input: ScreenshotToolInput = {
    url: command.url,
    fullPage: !command.viewportOnly,
    ...(command.width !== undefined ? { width: command.width } : {}),
    ...(command.scale !== undefined ? { scale: command.scale } : {}),
  };
  const blocks = await handleScreenshotTool(input);
  writeBlocks(blocks, command.url, command.outDir ?? process.cwd());
}

/** CLIのメイン処理。テスト用export(引数を受け取り終了コードを返す純粋な形にしてある)。 */
export async function run(argv: string[]): Promise<number> {
  let command: ParsedCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${usageText()}\n`);
      return 2;
    }
    throw error;
  }

  if (command.kind === "help") {
    process.stdout.write(`${helpText(command.topic)}\n`);
    return 0;
  }
  if (command.kind === "version") {
    process.stdout.write(`${resolvePackageVersion()}\n`);
    return 0;
  }
  if (command.kind === "serve") {
    // MCPサーバーはstdioで待受け続けるプロセスのため、closeBrowser/cache.closeは呼ばない
    // (呼ぶとサーバー起動直後にキャッシュ/ブラウザが使えなくなる)。
    await runServer();
    return 0;
  }

  try {
    if (command.kind === "install-browser") {
      return await installBrowser();
    }
    await dispatch(command);
    return 0;
  } catch (error) {
    if (error instanceof AmenboError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      console.error(error);
    }
    return 1;
  } finally {
    // playwrightのブラウザが開いたままだとプロセスがハングするため、サブコマンド完了後は
    // 確実にクローズしてから終了する(1実行=1プロセスのCLIではプロセス終了時のcloseに頼れない)。
    await closeBrowser();
    cache.close();
  }
}

/**
 * server.tsのisDirectlyExecutedと同様、テストからparseCliArgs等をimportした際にrun()が走らないようにするガード。
 * npm/npx経由の実行ではprocess.argv[1]がnode_modules/.bin配下のシンボリックリンクのパスになるため、
 * realpathSyncで解決してからfileURLToPath(import.meta.url)と比較する。
 */
function isDirectlyExecuted(): boolean {
  return typeof process.argv[1] === "string" && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
}

if (isDirectlyExecuted()) {
  run(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
