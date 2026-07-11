#!/usr/bin/env node
// dist/server.js を子プロセス起動し、MCP initializeハンドシェイクのみを確認するスモーク。
// pnpm 10でのネイティブビルドブロック等、install〜build後の起動可否リグレッションを検出する目的。
// ハーネスはbench/bench.mjsのmcpSession/initSessionを流用(dist/tokens.jsへの依存は持ち込まない)。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = join(rootDir, "dist", "server.js");
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
  const s = mcpSession("node", [SERVER_PATH], {});
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
    console.log("OK: initialize handshake succeeded");
  } finally {
    s.child.kill();
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
