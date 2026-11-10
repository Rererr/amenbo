import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { PageCache } from "../../src/cache.js";

/**
 * tests/cacheConcurrentWriters.test.ts の子プロセス。同じキャッシュを開いたら "ready" を出し、
 * 標準入力に "go" が来たら書き込みを始める(全員の書き込みを親が持つロックの最中に揃えるため)。
 * WALへの切り替えがロックで失敗したら、その都度 "blocked" を出す(親が、子が待ち直しに入ったと
 * 確かめてからロックを手放せるように。時間を置いて待つ形にしないため)。
 * 失敗はエラー文を標準エラーへ出して終了コード1で知らせる。
 */
const execStatement = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string): void {
  try {
    execStatement.call(this, sql);
  } catch (error) {
    if (/journal_mode/i.test(sql)) process.stdout.write("blocked\n");
    throw error;
  }
};

const [cacheDir, writerId] = process.argv.slice(2);
if (!cacheDir || !writerId) {
  process.stderr.write("usage: concurrentCacheWriter <cacheDir> <writerId>\n");
  process.exit(2);
}

try {
  const cache = new PageCache({ cacheDir });
  process.stdout.write("ready\n");
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim() !== "go") continue;
    for (let i = 0; i < 20; i++) {
      cache.set({ url: `https://example.com/${writerId}/${i}`, etag: null, lastModified: null, markdown: `本文 ${i}`, metadata: {} });
      cache.setHostLastRequestAt("example.com", Date.now());
    }
    cache.close();
    process.stdout.write("done\n");
    break;
  }
  lines.close();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
