#!/usr/bin/env node
// amenbo競合ベンチハーネス: MCP系はJSON-RPC stdio直叩き、Jina/pixelshotは別経路。
// 出力: 結果JSON(1ツール×1URLごと)を results.json に保存。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../dist/tokens.js";

const URLS = [
  { id: "zenn", url: "https://zenn.dev/avaintelligence/articles/b7d4743a448485", cat: "CJK技術記事(表+コード)" },
  { id: "wiki", url: "https://ja.wikipedia.org/wiki/%E9%83%BD%E9%81%93%E5%BA%9C%E7%9C%8C%E3%81%AE%E4%BA%BA%E5%8F%A3%E4%B8%80%E8%A6%A7", cat: "表の多いページ" },
  { id: "aozora", url: "https://www.aozora.gr.jp/cards/000148/files/789_14547.html", cat: "Shift_JIS長文" },
  { id: "gov", url: "https://www.mhlw.go.jp/stf/kaigo-kouhyou_opendata.html", cat: "官公庁HTML" },
  { id: "pdf", url: "https://www.mhlw.go.jp/content/000778218.pdf", cat: "PDF" },
  { id: "csv", url: "https://www.mhlw.go.jp/content/12300000/jigyosho_110.csv", cat: "CSV(非HTML)" },
  { id: "err", url: "https://initial.inc/", cat: "HTTP/2遮断(エラー)" },
];

const CALL_TIMEOUT_MS = 120_000;

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
  const rpc = (method, params, timeoutMs = CALL_TIMEOUT_MS) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, rpc, notify, getStderr: () => stderr };
}

async function initSession(s, name) {
  const r = await s.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "amenbo-bench", version: "0.0.1" },
  }, 60_000);
  if (r.error) throw new Error(`${name} initialize failed: ${JSON.stringify(r.error)}`);
  s.notify("notifications/initialized", {});
}

function summarizeContent(result) {
  // MCP tools/call result → テキスト連結・画像枚数・トークン概算
  const out = { text: "", images: 0, imageTokens: 0 };
  const content = result?.content ?? [];
  for (const c of content) {
    if (c.type === "text") out.text += c.text + "\n";
    else if (c.type === "image") {
      out.images++;
      // base64画像: サイズからトークン概算はできないため、バイト数記録のみ(後段でw*h/750計算はpixelshotのみ)
      out.imageTokens += Math.round((c.data?.length ?? 0) * 0.75 / 3); // 粗い下限見積り(参考値)
    }
  }
  out.textTokens = estimateTokens(out.text);
  return out;
}

async function runMcpTool({ label, cmd, args, env, toolName, buildArgs }) {
  const results = [];
  const s = mcpSession(cmd, args, env);
  try {
    await initSession(s, label);
    for (const t of URLS) {
      const started = Date.now();
      let rec = { tool: label, id: t.id, url: t.url };
      try {
        const resp = await s.rpc("tools/call", { name: toolName, arguments: buildArgs(t.url) });
        const ms = Date.now() - started;
        if (resp.error) {
          rec = { ...rec, ok: false, ms, error: JSON.stringify(resp.error).slice(0, 2000) };
        } else {
          const sum = summarizeContent(resp.result);
          const isErr = resp.result?.isError === true;
          rec = {
            ...rec, ok: !isErr, ms,
            textTokens: sum.textTokens, images: sum.images,
            head: sum.text.slice(0, 400),
            tableRows: (sum.text.match(/^\|.*\|$/gm) || []).length,
            codeBlocks: (sum.text.match(/^```/gm) || []).length / 2,
          };
          if (isErr) rec.error = sum.text.slice(0, 2000);
        }
      } catch (e) {
        rec = { ...rec, ok: false, ms: Date.now() - started, error: String(e).slice(0, 500) };
      }
      console.error(`[${label}] ${t.id}: ok=${rec.ok} tok=${rec.textTokens ?? "-"} ms=${rec.ms}`);
      results.push(rec);
    }
  } finally {
    s.child.kill();
  }
  return results;
}

async function runJina() {
  const results = [];
  for (const t of URLS) {
    const started = Date.now();
    let rec = { tool: "jina", id: t.id, url: t.url };
    try {
      const res = await fetch(`https://r.jina.ai/${t.url}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const text = await res.text();
      const ms = Date.now() - started;
      rec = {
        ...rec, ok: res.ok, ms, status: res.status,
        textTokens: estimateTokens(text), head: text.slice(0, 400),
        tableRows: (text.match(/^\|.*\|$/gm) || []).length,
        codeBlocks: (text.match(/^```/gm) || []).length / 2,
      };
      if (!res.ok) rec.error = text.slice(0, 1000);
    } catch (e) {
      rec = { ...rec, ok: false, ms: Date.now() - started, error: String(e).slice(0, 500) };
    }
    console.error(`[jina] ${t.id}: ok=${rec.ok} tok=${rec.textTokens ?? "-"} ms=${rec.ms}`);
    results.push(rec);
    await new Promise(r => setTimeout(r, 3000)); // レート制限回避
  }
  return results;
}

function runPixelshot() {
  const results = [];
  for (const t of URLS) {
    const outDir = mkdtempSync(join(tmpdir(), "pxl-"));
    const started = Date.now();
    let rec = { tool: "pixelshot", id: t.id, url: t.url };
    try {
      execFileSync("pixelshot", [t.url, "--output", outDir, "--wait-network-idle", "--tile-height", "1024"],
        { timeout: CALL_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
      const ms = Date.now() - started;
      // タイル画像を集計: トークン = w*h/750 (Claude視覚トークン概算)
      let images = 0, visionTokens = 0, bytes = 0;
      const walk = (dir) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) { walk(p); continue; }
          if (!/\.(jpe?g|png)$/i.test(f)) continue;
          images++;
          bytes += statSync(p).size;
          const dim = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", p]).toString();
          const w = Number(/pixelWidth: (\d+)/.exec(dim)?.[1] ?? 0);
          const h = Number(/pixelHeight: (\d+)/.exec(dim)?.[1] ?? 0);
          visionTokens += Math.ceil((w * h) / 750);
        }
      };
      walk(outDir);
      rec = { ...rec, ok: images > 0, ms, images, visionTokens, bytes, outDir };
    } catch (e) {
      rec = { ...rec, ok: false, ms: Date.now() - started, error: String(e.stderr ?? e).slice(0, 800), outDir };
    }
    console.error(`[pixelshot] ${t.id}: ok=${rec.ok} imgs=${rec.images ?? 0} visTok=${rec.visionTokens ?? "-"} ms=${rec.ms}`);
    results.push(rec);
  }
  return results;
}

const which = process.argv[2] ?? "all";
const all = [];

if (which === "all" || which === "amenbo") {
  const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-bench-"));
  all.push(...await runMcpTool({
    label: "amenbo", cmd: "node", args: ["../dist/server.js"],
    env: { AMENBO_CACHE_DIR: cacheDir },
    toolName: "fetch", buildArgs: (url) => ({ url }),
  }));
}
if (which === "all" || which === "fetch") {
  all.push(...await runMcpTool({
    label: "mcp-server-fetch", cmd: "uvx", args: ["mcp-server-fetch"], env: {},
    toolName: "fetch", buildArgs: (url) => ({ url }),
  }));
}
if (which === "all" || which === "playwright") {
  all.push(...await runMcpTool({
    label: "playwright-mcp", cmd: "npx", args: ["-y", "@playwright/mcp@latest"], env: {},
    toolName: "browser_navigate", buildArgs: (url) => ({ url }),
  }));
}
if (which === "all" || which === "jina") all.push(...await runJina());
if (which === "all" || which === "pixelshot") all.push(...runPixelshot());

const outPath = join(".", `results-${which}.json`);
writeFileSync(outPath, JSON.stringify(all, null, 2));
console.error(`saved: ${outPath}`);
