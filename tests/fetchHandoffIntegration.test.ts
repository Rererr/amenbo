import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupCacheDir } from "./helpers/tempCache.js";

/**
 * handoff(HTML以外の応答)を、ハンドラ(handleFetchTool)を通して確かめる。
 * 利用者に見える契約(本文が返るか、続きのページを読めるか、size の意味)は、整形関数の単体
 * テストだけでは取得層との組み合わせの誤り(圧縮後の Content-Length 等)を捕まえられない。
 */

const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-handoff-integration-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { handleFetchTool, cache } = await import("../src/core.js");
const { formatHandoffResponse } = await import("../src/formatting.js");
const { setAddressPolicyForTests } = await import("../src/fetcher/http.js");

const MARKDOWN_LINES = Array.from({ length: 300 }, (_, i) => `- 項目 ${i}: Markdown 版の本文がページ送りで最後まで読めるかを確かめる行`);
const MARKDOWN = `# 配布されたMarkdown\n\n${MARKDOWN_LINES.join("\n")}\n\n最後の行の目印 END-OF-MARKDOWN\n`;
const PLAIN_TEXT = `${"plain text line for size check\n".repeat(2000)}`;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const routes: Record<string, Handler> = {
  "/robots.txt": (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("User-agent: *\nAllow: /\n");
  },
  "/doc.md": (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(MARKDOWN);
  },
  "/gzipped.txt": (_req, res) => {
    const body = gzipSync(Buffer.from(PLAIN_TEXT));
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Encoding": "gzip", "Content-Length": String(body.length) });
    res.end(body);
  },
};

const server: Server = createServer((req, res) => {
  const handler = routes[(req.url ?? "/").split("?")[0] ?? "/"];
  if (handler) {
    handler(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
setAddressPolicyForTests(() => false);

afterAll(async () => {
  setAddressPolicyForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupCacheDir(cacheDir, () => cache.close());
});

async function fetchText(input: Parameters<typeof handleFetchTool>[0]): Promise<string> {
  const content = await handleFetchTool(input);
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("handoff の size", () => {
  it("圧縮して送られた応答は、Content-Length(圧縮後の転送量)でなく受け取った本文の大きさを出す", async () => {
    const text = await fetchText({ url: `${origin}/gzipped.txt` });

    expect(text).toContain(`size: ${Buffer.byteLength(PLAIN_TEXT)}\n`);
  }, 30_000);

  it("途中で読むのをやめ、全体の大きさも分からないときは、取得した量を全体の大きさとして出さない", () => {
    const bytes = new TextEncoder().encode("a".repeat(100));
    const text = formatHandoffResponse(
      { handoff: true, finalUrl: `${origin}/x.txt`, status: 200, contentType: "text/plain", bytes, declaredSize: null, truncated: true, etag: null, lastModified: null, cacheControl: null },
      8000,
    );

    expect(text).toMatch(/^size: 不明\(先頭100バイトまで取得/m);
  });
});

describe("text/markdown の応答", () => {
  it("本文をプレビューとして返す(curl の案内だけにしない)", async () => {
    const text = await fetchText({ url: `${origin}/doc.md` });

    expect(text).toContain("mode_used: handoff");
    expect(text).toContain("# 配布されたMarkdown");
    expect(text).toContain("項目 0:");
  }, 30_000);

  it("max_tokens を超えた本文は page で続きを読め、最後のページに末尾がある", async () => {
    const first = await fetchText({ url: `${origin}/doc.md`, max_tokens: 1000 });
    const totalPages = Number(/page: 1 of (\d+)/.exec(first)?.[1]);
    expect(totalPages).toBeGreaterThan(1);
    expect(first).not.toContain("END-OF-MARKDOWN");

    const last = await fetchText({ url: `${origin}/doc.md`, max_tokens: 1000, page: totalPages });
    expect(last).toContain(`page: ${totalPages} of ${totalPages}`);
    expect(last).toContain("END-OF-MARKDOWN");
  }, 30_000);
});
