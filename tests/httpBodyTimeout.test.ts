import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { FetchTimeoutError } from "../src/errors.js";
import { httpGet, setAddressPolicyForTests } from "../src/fetcher/http.js";

/**
 * タイムアウトはヘッダ受信前に起きるとは限らない。ヘッダだけ返して本文を送り続けないサーバー
 * (よくある障害の形)では、Abortはfetch()ではなくボディ読み取り中に届く。
 * この経路が接続断と同じNetworkErrorに分類されると、利用者側は「回線の問題」と
 * 「遅くて打ち切った」を区別できない。
 */

// ループバックはSSRFガードの拒否対象。テストの間だけ判定を外し、必ず元へ戻す。
setAddressPolicyForTests(() => false);

const server: Server = createServer((req, res) => {
  if (req.url === "/silent") return; // ヘッダすら返さない(ボット対策で応答を保留するサイトの形)
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.write("<html><body>"); // ヘッダと本文の一部だけ返し、以降は送らない
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(async () => {
  setAddressPolicyForTests(null);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("ボディ読み取り中のタイムアウト", () => {
  it("ヘッダ受信後に本文が止まった場合もFetchTimeoutErrorになる(ブラウザ再試行の案内は付けない)", async () => {
    const error = await httpGet(`${origin}/stalled`, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchTimeoutError);
    expect((error as FetchTimeoutError).stage).toBe("body");
    expect((error as Error).message).not.toContain("mode: screenshot");
  });

  it("応答が1バイトも届かない場合は応答なしと明示し、ブラウザ経由の再試行を案内する", async () => {
    const error = await httpGet(`${origin}/silent`, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchTimeoutError);
    expect((error as FetchTimeoutError).stage).toBe("response");
    expect((error as Error).message).toContain("応答なし");
    expect((error as Error).message).toContain("mode: screenshot");
  });
});
