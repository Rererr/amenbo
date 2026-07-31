#!/usr/bin/env node
// dist/server.js に対してfetchツールを実URLで叩くE2Eスモーク。実環境検証主義に基づき、
// ユニットテストでは検出できないNodeバージョン依存・実サイト応答の劣化を機械的に捕捉する。
// ハーネスはbench/bench.mjsのmcpSession/initSessionを流用(dist/tokens.jsへの依存は持ち込まない)。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = join(rootDir, "dist", "server.js");
const CALL_TIMEOUT_MS = 120_000;

function mcpSession(cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  const notifications = [];
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
        else if (msg.method !== undefined) notifications.push(msg);
      } catch { /* 非JSON行は無視 */ }
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeoutMs = CALL_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, rpc, notify, notifications, getStderr: () => stderr };
}

// 進捗通知(notifications/progress)は実際の取得処理の中でしか発生しないため、取得を伴う
// このスモークでしか経路を確認できない。eraごとに通知の出口が別(新eraはserveStdioの
// subscriptionsルータを経由する)ため、legacy側と新era側の両方で到達を確かめる。
const PROGRESS_TOKEN = "e2e-progress";
const MODERN_VERSION = "2026-07-28";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "amenbo-ci-e2e", version: "0.0.1" },
};
// 実在しないTLD(RFC 2606の.invalid)へ同一ホスト2回投げる。1回目は間隔調整の対象が無く待機が
// 発生しないため進捗は出ない(実測)。収集先サイトを使わないのは、通知配線の確認のために
// 外部サイトへ追加の取得をかけたくないため。取得自体は必ず失敗するが、待機はその手前で起きる。
const PROGRESS_URLS = ["https://amenbo-e2e-progress.invalid/", "https://amenbo-e2e-progress.invalid/x"];

function progressCount(s) {
  return s.notifications.filter(
    (n) => n.method === "notifications/progress" && n.params?.progressToken === PROGRESS_TOKEN,
  ).length;
}

/** 同一セッションで2回取得を試み、進捗通知が届いた件数を返す(取得の成否は問わない)。 */
async function probeProgress(s, extraMeta) {
  for (const url of PROGRESS_URLS) {
    const resp = await s.rpc("tools/call", {
      name: "fetch",
      arguments: { url },
      _meta: { ...extraMeta, progressToken: PROGRESS_TOKEN },
    }, CALL_TIMEOUT_MS);
    if (resp.error) throw new Error(`tools/callがJSON-RPCエラー: ${JSON.stringify(resp.error).slice(0, 300)}`);
  }
  return progressCount(s);
}

/** ハンドシェイク無し(2026-07-28)のセッションで進捗通知が届くことを確認する。 */
async function checkModernProgress() {
  const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-e2e-modern-"));
  const s = mcpSession("node", [SERVER_PATH], { AMENBO_CACHE_DIR: cacheDir });
  try {
    const count = await probeProgress(s, MODERN_META);
    if (count === 0) return "modern-progress: notifications/progress が0件(新eraで進捗通知が塞がっている)";
    console.log(`OK modern-progress (${MODERN_VERSION}): 進捗通知${count}件`);
    return null;
  } catch (e) {
    return `modern-progress: ${String(e)}`;
  } finally {
    s.child.kill();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

async function initSession(s) {
  const r = await s.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "amenbo-ci-e2e", version: "0.0.1" },
  }, 60_000);
  if (r.error) throw new Error(`initialize failed: ${JSON.stringify(r.error)}`);
  s.notify("notifications/initialized", {});
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const CASES = [
  {
    id: "wikipedia-table",
    url: "https://ja.wikipedia.org/wiki/%E9%83%BD%E9%81%93%E5%BA%9C%E7%9C%8C%E3%81%AE%E4%BA%BA%E5%8F%A3%E4%B8%80%E8%A6%A7",
    check: (text) => /^\|.*\|$/m.test(text) || "Markdown表(|区切り)が含まれていない",
  },
  {
    id: "aozora-shiftjis",
    url: "https://www.aozora.gr.jp/cards/000148/files/789_14547.html",
    check: (text) => text.includes("吾輩") || "文字化けの疑い(「吾輩」を含まない)",
  },
  {
    id: "robots-txt-handoff",
    // code-reviewer指摘: 以前はmhlw.go.jp系(kaigokensaku)を使っており、csv-handoffケースと
    // 合わせてmhlw.go.jpに2件集中していた(1ドメインのWAFブロックでCI全体が落ちるリスク集中)。
    // qiita.com/robots.txtがtext/plainハンドオフになることをdist/server.js直叩きで実証済み
    // (2026-07-11)。4ケースが4ドメイン(wikipedia/aozora/qiita/mhlw)に分散するよう変更した。
    url: "https://qiita.com/robots.txt",
    check: (text) => text.includes("mode_used: handoff") || "ハンドオフ応答になっていない(mode_used: handoffなし)",
  },
  {
    id: "csv-handoff",
    url: "https://www.mhlw.go.jp/content/12300000/jigyosho_110.csv",
    check: (text) => text.includes("mode_used: handoff") || "ハンドオフ応答になっていない(mode_used: handoffなし)",
  },
];

async function main() {
  const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-e2e-"));
  const s = mcpSession("node", [SERVER_PATH], { AMENBO_CACHE_DIR: cacheDir });
  const failures = [];
  try {
    await initSession(s);
    for (const c of CASES) {
      const started = Date.now();
      try {
        const resp = await s.rpc("tools/call", { name: "fetch", arguments: { url: c.url } }, CALL_TIMEOUT_MS);
        const ms = Date.now() - started;
        if (resp.error) {
          failures.push(`${c.id}: RPCエラー ${JSON.stringify(resp.error).slice(0, 500)}`);
          console.log(`NG ${c.id} (${ms}ms): RPCエラー`);
          continue;
        }
        if (resp.result?.isError) {
          const text = textOf(resp.result);
          failures.push(`${c.id}: isError=true ${text.slice(0, 500)}`);
          console.log(`NG ${c.id} (${ms}ms): isError=true`);
          continue;
        }
        const text = textOf(resp.result);
        const checkResult = c.check(text);
        if (checkResult !== true) {
          failures.push(`${c.id}: ${checkResult}`);
          console.log(`NG ${c.id} (${ms}ms): ${checkResult}`);
          continue;
        }
        console.log(`OK ${c.id} (${ms}ms): ${text.slice(0, 80).replace(/\n/g, " ")}...`);
      } catch (e) {
        failures.push(`${c.id}: ${String(e)}`);
        console.log(`NG ${c.id}: ${String(e)}`);
      }
    }
    try {
      const legacyProgress = await probeProgress(s, undefined);
      if (legacyProgress === 0) {
        failures.push("legacy-progress: notifications/progress が0件(2025系で進捗通知が塞がっている)");
        console.log("NG legacy-progress: 進捗通知が0件");
      } else {
        console.log(`OK legacy-progress: 進捗通知${legacyProgress}件`);
      }
    } catch (e) {
      failures.push(`legacy-progress: ${String(e)}`);
      console.log(`NG legacy-progress: ${String(e)}`);
    }
  } finally {
    s.child.kill();
    rmSync(cacheDir, { recursive: true, force: true });
  }

  const modernFailure = await checkModernProgress();
  if (modernFailure !== null) {
    failures.push(modernFailure);
    console.log(`NG ${modernFailure}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length}件が失敗しました:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`\nOK: 取得${CASES.length}件 + 進捗通知2era すべて成功`);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
