import { createInterface } from "node:readline";
import { PageCache } from "../../src/cache.js";

/**
 * tests/cacheConcurrentWriters.test.ts の子プロセス。開く直前に "opening"、同じキャッシュを開いたら "ready" を出し、
 * 標準入力に "go" が来たら書き込みを始める(全員の書き込みを親が持つロックの最中に揃えるため)。
 * 失敗はエラー文を標準エラーへ出して終了コード1で知らせる。
 */
const [cacheDir, writerId] = process.argv.slice(2);
if (!cacheDir || !writerId) {
  process.stderr.write("usage: concurrentCacheWriter <cacheDir> <writerId>\n");
  process.exit(2);
}

try {
  process.stdout.write("opening\n");
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
