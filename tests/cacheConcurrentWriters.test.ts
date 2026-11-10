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
  opening: Promise<void>;
  ready: Promise<void>;
  exit: Promise<{ code: number | null; stderr: string }>;
}

function startWriter(id: string, dir: string = cacheDir): Writer {
  const child = spawn(process.execPath, ["--import", "tsx", writerScript, dir, id], { cwd: repoRoot });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const waiters: Array<{ marker: string; resolve: () => void }> = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const waiter of waiters) if (stdout.includes(waiter.marker)) waiter.resolve();
  });
  const waitFor = (marker: string) =>
    new Promise<void>((resolve, reject) => {
      waiters.push({ marker, resolve });
      child.once("exit", (code) => reject(new Error(`書き込み役 ${id} が "${marker}" の前に終了しました(code=${code}): ${stderr}`)));
    });
  const opening = waitFor("opening");
  const ready = waitFor("ready");
  // 待ち直しのテストは "ready" を待たないので、準備前の終了は exit のほうで確かめる。
  ready.catch(() => {});
  const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  return { child, opening, ready, exit };
}

describe("PageCache - 複数プロセスからの同時書き込み", () => {
  it("別プロセスが書き込みロックを持っている間も、全プロセスの書き込みが待って成功する", async () => {
    const writers = ["a", "b", "c"].map((id) => startWriter(id));
    await Promise.all(writers.map((writer) => writer.ready));

    // 全員の書き込みが親のロック中に始まるようにして、競合を毎回起こす。
    // 失敗しても閉じる(開いたままだとWindowsで一時ディレクトリを消せない)。
    const holder = new DatabaseSync(join(cacheDir, "cache.sqlite"));
    try {
      holder.exec("BEGIN IMMEDIATE");
      for (const writer of writers) writer.child.stdin.write("go\n");
      await new Promise((resolve) => setTimeout(resolve, 300));
      holder.exec("COMMIT");

      const results = await Promise.all(writers.map((writer) => writer.exit));
      for (const writer of writers) writer.child.stdin.end();

      for (const result of results) expect(result.code, result.stderr).toBe(0);
      const row = holder.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number };
      expect(Number(row.n)).toBe(60);
    } finally {
      holder.close();
    }
  }, 30_000);

  it("まだWALでないDBを別プロセスがロックしている間に開いても、待ち直して起動できる", async () => {
    // WALへの切り替えはbusy_timeoutを待たずに失敗するので、待ち直しが無いと子は終了コード1になる。
    const dir = mkdtempSync(join(tmpdir(), "amenbo-wal-switch-test-"));
    const holder = new DatabaseSync(join(dir, "cache.sqlite"));
    let locked = false;
    try {
      holder.exec("CREATE TABLE existing (a INTEGER)");
      holder.exec("BEGIN IMMEDIATE");
      locked = true;
      const writer = startWriter("wal", dir);
      writer.child.stdin.end("go\n");
      await writer.opening;
      await new Promise((resolve) => setTimeout(resolve, 300));
      holder.exec("COMMIT");
      locked = false;

      const result = await writer.exit;
      expect(result.code, result.stderr).toBe(0);
    } finally {
      if (locked) holder.exec("ROLLBACK");
      holder.close();
      cleanupCacheDir(dir);
    }
  }, 30_000);
});
