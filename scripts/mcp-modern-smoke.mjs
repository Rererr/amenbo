#!/usr/bin/env node
// dist/server.js を子プロセス起動し、2026-07-28 era(ハンドシェイク無し)での疎通を確認するスモーク。
// mcp-init-smoke.mjs が2025系(initialize)の後方互換を守るのに対し、こちらは新era側を守る。
// 両方を並べて置くことで、serveStdioのera判定がどちらかに倒れる退行を機械的に検出する。
//
// 新eraのリクエストはヘッダを持たないstdioでは params._meta の予約キーだけがera判定材料になる
// (protocolVersion と clientCapabilities が必須)。ハーネスはmcp-init-smoke.mjsと同形。
//
// ここでは取得を伴わないプロトコル面だけを見る。新eraでの進捗通知の到達確認は実際の取得が要る
// ため、外部ネットワークに依存してよいe2e-smoke.mjs側に置いてある(このスモークが載るpnpmジョブを
// 収集先サイトの都合で赤くしないため)。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// publishしたtarballを展開した先など、リポジトリ外のdistへ向けられるようにする
// (release-check.ymlがインストール済みパッケージに対してこのスモークを流す)。
const SERVER_PATH = process.env.AMENBO_SMOKE_SERVER ?? join(rootDir, "dist", "server.js");
const TIMEOUT_MS = 30_000;

const MODERN_VERSION = "2026-07-28";
const envelope = (protocolVersion) => ({
  "io.modelcontextprotocol/protocolVersion": protocolVersion,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "amenbo-ci-modern-smoke", version: "0.0.1" },
});

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
  const rpc = (method, params, protocolVersion = MODERN_VERSION) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, TIMEOUT_MS);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    const body = { ...params, _meta: { ...envelope(protocolVersion), ...params._meta } };
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: body }) + "\n");
  });
  return { child, rpc, notifications, getStderr: () => stderr };
}

function fail(message, session) {
  throw new Error(`${message}\nstderr:\n${session.getStderr().slice(0, 2000)}`);
}

/** ハンドシェイク無しでツール・プロンプトが引けることを確認する。 */
async function checkModernSession() {
  const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-modern-smoke-"));
  const s = mcpSession("node", [SERVER_PATH], { AMENBO_CACHE_DIR: cacheDir });
  try {
    const tools = await s.rpc("tools/list", {});
    if (tools.error) fail(`tools/list failed: ${JSON.stringify(tools.error)}`, s);
    const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
    if (names.join(",") !== "fetch,links,screenshot") {
      fail(`tools/list が想定外です: ${names.join(",")}`, s);
    }

    const prompts = await s.rpc("prompts/list", {});
    if (prompts.error) fail(`prompts/list failed: ${JSON.stringify(prompts.error)}`, s);
    const promptNames = (prompts.result?.prompts ?? []).map((p) => p.name);
    if (promptNames.join(",") !== "usage") {
      fail(`prompts/list が想定外です: ${promptNames.join(",")}`, s);
    }

    // 一覧が引けるだけでは、新eraでツールを1本も呼べない状態を見逃す。
    // ネットワークへ出ないよう、スキーム検証で確実に弾かれるURLで呼び出し経路だけを確認する。
    const call = await s.rpc("tools/call", { name: "fetch", arguments: { url: "file:///etc/passwd" } });
    if (call.error) fail(`tools/call がプロトコルエラーになりました: ${JSON.stringify(call.error)}`, s);
    if (call.result?.isError !== true) {
      fail(`非対応スキームがツールエラーになりません: ${JSON.stringify(call.result).slice(0, 300)}`, s);
    }

    console.log(`OK: modern era (${MODERN_VERSION}) — tools=${names.join(",")} prompts=${promptNames.join(",")} tools/call=isError`);
  } finally {
    s.child.kill();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

/** 未対応のプロトコル版を名乗った場合に、静かに旧eraへ落ちず明示的に拒否されることを確認する。 */
async function checkUnsupportedRevision() {
  const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-modern-smoke-reject-"));
  const s = mcpSession("node", [SERVER_PATH], { AMENBO_CACHE_DIR: cacheDir });
  try {
    const r = await s.rpc("tools/list", {}, "2099-01-01");
    if (!r.error) fail(`未対応バージョンが受理されました: ${JSON.stringify(r.result).slice(0, 200)}`, s);
    if (r.error.code !== -32022) {
      fail(`想定と異なるエラーコードです(-32022を期待): ${JSON.stringify(r.error)}`, s);
    }
    console.log(`OK: 未対応バージョンは -32022 で拒否 — supported=${JSON.stringify(r.error.data?.supported)}`);
  } finally {
    s.child.kill();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

await checkModernSession();
await checkUnsupportedRevision();
