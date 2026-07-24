import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * MCP prompts capability: server.ts側の`usage`プロンプト登録を、実際のMCP Client +
 * InMemoryTransportを使った統合テストで検証する。README.en.md の推奨プロンプトブロックとの
 * 同期は、README実ファイルからフェンス内を抽出して完全一致で保証する(README.md の
 * 日本語ブロックは訳文のため機械同期の対象外。内容の連動は人が保つ)。
 */

// core.tsはモジュール読み込み時にPageCache(node:sqlite)を既定のキャッシュディレクトリに生成する
// 副作用を持つため、実ユーザーのキャッシュを汚さないよう一時ディレクトリへ退避してからimportする。
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-server-usage-prompt-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { server } = await import("../src/server.js");
const { cache } = await import("../src/core.js");

afterAll(() => {
  // Windows CI対応: 開いたままのSQLiteファイルハンドルを解放してから削除する
  // (詳細はtests/helpers/tempCache.tsのコメント参照)。
  cleanupCacheDir(cacheDir, () => cache.close());
});

async function connectedClient(): Promise<InstanceType<typeof Client>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "amenbo-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("server.ts - usageプロンプト", () => {
  it("prompts/listにusageが1件だけ含まれる", async () => {
    const client = await connectedClient();

    const { prompts } = await client.listPrompts();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ name: "usage", title: "How to use amenbo efficiently" });

    await client.close();
  });

  it("prompts/get(usage)がREADME.en.mdの推奨プロンプトブロックと完全一致するテキストをuserメッセージ1件で返す", async () => {
    const client = await connectedClient();

    const result = await client.getPrompt({ name: "usage" });

    expect(result.messages).toHaveLength(1);
    const [message] = result.messages;
    expect(message?.role).toBe("user");
    expect(message?.content).toMatchObject({ type: "text" });
    const text = message?.content.type === "text" ? message.content.text : "";

    // Windows CIではcheckout時のautocrlfでREADMEがCRLFになるため、LF固定の
    // USAGE_PROMPT_TEXTと比較する前に正規化する(改行差は「同期ドリフト」ではない)。
    const readme = readFileSync(new URL("../README.en.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const fencedBlock = readme.match(/```markdown\n(## Use amenbo for web fetching[\s\S]*?)\n```/)?.[1];
    if (fencedBlock === undefined) {
      throw new Error("README.en.mdの推奨プロンプトブロックが見つかりません(見出し文言かフェンスの変更を確認してください)");
    }
    expect(text).toBe(fencedBlock);

    await client.close();
  });
});
