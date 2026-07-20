#!/usr/bin/env node
// package.json / server.json (トップレベル+packages[].version) / (任意で)タグ の版数一致を検証する。
// リリース時の同期漏れ(v0.6.0全配布実害あり)を機械的に検出するためのゲート。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relPath) {
  const abs = join(rootDir, relPath);
  return JSON.parse(readFileSync(abs, "utf8"));
}

function parseTagArg(argv) {
  const idx = argv.indexOf("--tag");
  if (idx === -1) return null;
  const raw = argv[idx + 1];
  if (!raw) {
    throw new Error("--tag オプションには値が必要です(例: --tag v0.1.5)");
  }
  return raw.replace(/^refs\/tags\//, "").replace(/^v/, "");
}

function main() {
  const pkg = readJson("package.json");
  const server = readJson("server.json");
  const lockfile = readJson("package-lock.json");
  const tagVersion = parseTagArg(process.argv.slice(2));

  const entries = [
    { label: "package.json", version: pkg.version },
    { label: "server.json (top-level)", version: server.version },
    { label: "package-lock.json (top-level)", version: lockfile.version },
    { label: "package-lock.json packages[\"\"]", version: lockfile.packages?.[""]?.version },
  ];
  for (const [i, p] of (server.packages ?? []).entries()) {
    entries.push({ label: `server.json packages[${i}].version`, version: p.version });
  }
  if (tagVersion !== null) {
    entries.push({ label: "git tag", version: tagVersion });
  }

  // code-reviewer指摘: package.json/server.json双方でversionキーが欠落すると
  // entries.map((e) => e.version) が全てundefinedになり、Setのサイズが1のまま
  // 「一致している」と誤って成功してしまう。各エントリが非空文字列であることを
  // 先に検証し、欠落していれば「どのファイルのどのフィールドが欠落か」を明示して失敗させる。
  // USER_AGENT検証より前に実行することで、pkg.version を使う前に存在確認を行う。
  const missing = entries.filter((e) => typeof e.version !== "string" || e.version.trim().length === 0);
  if (missing.length > 0) {
    const detail = missing.map((e) => `  - ${e.label}: バージョンが欠落しています(値: ${JSON.stringify(e.version)})`).join("\n");
    console.error(`バージョンフィールドの欠落を検出しました:\n${detail}`);
    process.exit(1);
  }

  // USER_AGENT から major.minor を抽出して検証
  const httpContent = readFileSync(join(rootDir, "src/fetcher/http.ts"), "utf8");
  const uaMatch = httpContent.match(/export const USER_AGENT = "amenbo\/([\d.]+)/);
  if (!uaMatch) {
    console.error("USER_AGENT定数が見つかるか、形式が期待と異なります (src/fetcher/http.ts)");
    process.exit(1);
  }
  const userAgentVersion = uaMatch[1];
  const pkgMajorMinor = pkg.version.split(".").slice(0, 2).join(".");
  if (userAgentVersion !== pkgMajorMinor) {
    console.error(
      `USER_AGENT版数の不一致を検出しました:\n` +
        `  - package.json (major.minor): ${pkgMajorMinor}\n` +
        `  - src/fetcher/http.ts USER_AGENT: ${userAgentVersion}`
    );
    process.exit(1);
  }

  const versions = new Set(entries.map((e) => e.version));
  if (versions.size > 1) {
    const detail = entries.map((e) => `  - ${e.label}: ${e.version}`).join("\n");
    console.error(`バージョン不一致を検出しました:\n${detail}`);
    process.exit(1);
  }

  console.log(`OK: 全バージョンが一致しています (${pkg.version})`);
}

main();
