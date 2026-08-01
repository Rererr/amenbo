#!/usr/bin/env node
// dist/server.js を子プロセス起動し、2025系(initializeハンドシェイク)での疎通を確認するスモーク。
// pnpm 10でのネイティブビルドブロック等、install〜build後の起動可否リグレッションを検出する目的。
// ハーネスはbench/bench.mjsのmcpSession/initSessionを流用(dist/tokens.jsへの依存は持ち込まない)。
//
// キャッシュは実行毎の一時ディレクトリを使う。既定の ~/.cache/amenbo を共有すると、
// 開発機に残っているDBの権限・ロック状態でMCPの疎通そのものが確認できなくなる
// (実際に "attempt to write a readonly database" でこのスモークが落ちる事例があった)。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// publishしたtarballを展開した先など、リポジトリ外のdistへ向けられるようにする
// (release-check.ymlがインストール済みパッケージに対してこのスモークを流す)。
const SERVER_PATH = process.env.AMENBO_SMOKE_SERVER ?? join(rootDir, "dist", "server.js");
const INIT_TIMEOUT_MS = 15_000;

function mcpSession(cmd, args, env) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
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
      } catch { /* 非JSON行は無視 */ }
    }
  });
  let nextId = 1;
  const rpc = (method, params, timeoutMs = INIT_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, rpc, notify, getStderr: () => stderr };
}

async function main() {
  const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-init-smoke-"));
  const s = mcpSession("node", [SERVER_PATH], { AMENBO_CACHE_DIR: cacheDir });
  try {
    const r = await s.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "amenbo-ci-smoke", version: "0.0.1" },
    });
    if (r.error) {
      throw new Error(`initialize failed: ${JSON.stringify(r.error)}\nstderr:\n${s.getStderr()}`);
    }
    const name = r.result?.serverInfo?.name;
    if (name !== "amenbo") {
      throw new Error(`serverInfo.name が想定外です: ${name}`);
    }
    s.notify("notifications/initialized", {});

    // ツール呼び出しの経路(入力検証→ハンドラ→エラーラッピング)まで確認する。
    // ハンドシェイクだけだと、ツールが1本も呼べない状態でも緑になってしまう。
    // ネットワークへ出ないよう、スキーム検証で確実に弾かれるURLを使う。
    const call = await s.rpc("tools/call", { name: "fetch", arguments: { url: "file:///etc/passwd" } });
    if (call.error) {
      throw new Error(`tools/call がプロトコルエラーになりました: ${JSON.stringify(call.error)}\nstderr:\n${s.getStderr()}`);
    }
    if (call.result?.isError !== true) {
      throw new Error(`非対応スキームがツールエラーになりません: ${JSON.stringify(call.result).slice(0, 300)}`);
    }
    console.log("OK: 2025系 — initializeハンドシェイクとtools/callが成功");
  } finally {
    s.child.kill();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
