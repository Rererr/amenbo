/**
 * installBrowser.ts — `amenbo install-browser` サブコマンドの本体。
 *
 * Chromium遅延化(postinstall廃止)対応: package.jsonのpostinstallを撤去したため、
 * ブラウザが必要な操作(SPA昇格・screenshot)を使う利用者は、このコマンドで明示的に
 * 一度だけChromiumを取得する。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * amenboが依存する同梱playwrightパッケージのCLIエントリ(playwright/cli.js)を解決して
 * `install chromium` を実行する。playwrightのグローバル/別バージョンではなく、
 * amenboに同梱されたバージョンのCLIを使うことで、Chromiumのリビジョンとplaywright本体の
 * バージョンが食い違う事態を原理的に防ぐ。
 *
 * "playwright/cli.js" はplaywrightのpackage.json exportsマップにサブパスとして
 * 定義されていないため直接resolveできない。exportsに含まれる"playwright/package.json"を
 * resolveし、そのディレクトリからcli.js(package.json"bin"が指す実体)を組み立てる。
 */
export async function installBrowser(): Promise<number> {
  const packageJsonPath = createRequire(import.meta.url).resolve("playwright/package.json");
  const cliPath = join(dirname(packageJsonPath), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
