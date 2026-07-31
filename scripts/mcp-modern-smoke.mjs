#!/usr/bin/env node
// dist/server.js を子プロセス起動し、2026-07-28 era(ハンドシェイク無し)での疎通を確認するスモーク。
// mcp-init-smoke.mjs が2025系(initialize)の後方互換を守るのに対し、こちらは新era側を守る。
// 両方を並べて置くことで、serveStdioのera判定がどちらかに倒れる退行を機械的に検出する。
//
// 新eraのリクエストはヘッダを持たないstdioでは params._meta の予約キーだけがera判定材料になる
// (protocolVersion と clientCapabilities が必須)。ハーネスはmcp-init-smoke.mjsと同形。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = join(rootDir, "dist", "server.js");
const TIMEOUT_MS = 30_000;

const MODERN_VERSION = "2026-07-28";
const envelope = (protocolVersion) => ({
  "io.modelcontextprotocol/protocolVersion": protocolVersion,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "amenbo-ci-modern-smoke", version: "0.0.1" },
});

// 実在しないTLD(RFC 2606の.invalid)を使うのは、外部サイトへ負荷をかけずにpolitenessと
// エラーラッピングの経路を通すため。取得は必ず失敗するが、進捗通知はその手前で出る。
const UNREACHABLE_URL = "https://amenbo-modern-smoke.invalid/";

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

/** ハンドシェイク無しでツール・プロンプトが引けること、進捗通知が新era経路でも届くことを確認する。 */
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

    // 同一ホストへ2回続けて投げると、2回目はpolitenessの待機が必ず入り進捗が出る
    // (1回目は間隔調整の対象が無いため出ないことがある)。
    const progressToken = "modern-smoke-1";
    for (const url of [UNREACHABLE_URL, `${UNREACHABLE_URL}x`]) {
      const call = await s.rpc("tools/call", { name: "fetch", arguments: { url }, _meta: { progressToken } });
      if (call.error) fail(`tools/call がJSON-RPCエラーになりました: ${JSON.stringify(call.error)}`, s);
    }
    const progress = s.notifications.filter(
      (n) => n.method === "notifications/progress" && n.params?.progressToken === progressToken,
    );
    if (progress.length === 0) {
      fail("notifications/progress が新eraで1件も届きませんでした(進捗通知の経路が塞がっている可能性)", s);
    }

    console.log(`OK: modern era (${MODERN_VERSION}) — tools=${names.join(",")} prompts=${promptNames.join(",")} progress=${progress.length}件`);
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
