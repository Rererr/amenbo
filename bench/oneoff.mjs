// 単発amenbo呼び出し: node oneoff.mjs <url> [json-args]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-oneoff-"));
const child = spawn("node", ["../dist/server.js"], {
  env: { ...process.env, AMENBO_CACHE_DIR: cacheDir }, stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
let id = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  setTimeout(() => rej(new Error("timeout " + method)), 120000);
  pending.set(myId, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
});
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oneoff", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
const r = await rpc("tools/call", { name: process.env.TOOL || "fetch", arguments: { url, ...extra } });
const texts = (r.result?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
console.log("isError:", r.result?.isError === true);
console.log(texts.slice(0, Number(process.env.HEAD || 1500)));
child.kill();
process.exit(0);
