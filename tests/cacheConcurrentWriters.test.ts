import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * MCPサーバー(1セッション1プロセス)とCLIは同じcache.sqliteを別々のプロセスから書く。
 * 書き込みが重なったとき、待たずに "database is locked" で失敗してはならない。
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const writerScript = fileURLToPath(new URL("./helpers/concurrentCacheWriter.ts", import.meta.url));
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-concurrent-writers-test-"));

afterAll(() => {
  cleanupCacheDir(cacheDir);
});

interface Writer {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  exit: Promise<{ code: number | null; stderr: string }>;
}

function startWriter(id: string): Writer {
  const child = spawn(process.execPath, ["--import", "tsx", writerScript, cacheDir, id], { cwd: repoRoot });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("ready")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`書き込み役 ${id} が準備前に終了しました(code=${code}): ${stderr}`)));
  });
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  return { child, ready, exit };
}

describe("PageCache - 複数プロセスからの同時書き込み", () => {
  it("別プロセスが書き込みロックを持っている間も、全プロセスの書き込みが待って成功する", async () => {
    const writers = ["a", "b", "c"].map(startWriter);
    await Promise.all(writers.map((writer) => writer.ready));

    // 全員の書き込みが親のロック中に始まるようにして、競合を毎回起こす。
    const holder = new DatabaseSync(join(cacheDir, "cache.sqlite"));
    holder.exec("BEGIN IMMEDIATE");
    for (const writer of writers) writer.child.stdin.write("go\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    holder.exec("COMMIT");

    const results = await Promise.all(writers.map((writer) => writer.exit));
    for (const writer of writers) writer.child.stdin.end();

    for (const result of results) expect(result.code, result.stderr).toBe(0);
    const row = holder.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number };
    expect(Number(row.n)).toBe(60);
    holder.close();
  }, 30_000);
});
