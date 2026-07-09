import { afterEach, describe, expect, it, vi } from "vitest";

// C2: DNS rebinding(TOCTOU)対策の回帰テスト。
//
// guardPublicAddress(事前検証)は node:dns/promises の lookup を使い、実接続(fetchの
// dispatcher)は node:dns の callback版 lookup(ssrfSafeLookup)を使う。この2つを別々に
// モックすることで、「事前検証時点ではpublicアドレスだが、実接続時点のDNS解決だけが
// privateアドレスを返す」というDNS rebinding攻撃を副作用なく(実ネットワークアクセス無しで)
// 再現できる。ssrfSafeLookupが接続時点で拒否していなければ、この呼び出しは
// 何もしていないサーバーへの接続(ETIMEDOUT等)としてPrivateAddressError以外のエラーで
// 失敗するか、そもそも成功してしまう。

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    // 事前検証(guardPublicAddress)はpublicアドレスを返す(通過する)
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  };
});

vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    // 実接続時点の解決(ssrfSafeLookup内部)はprivateアドレスを返す(rebindingを模す)
    lookup: (_hostname: string, options: unknown, callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void) => {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    },
  };
});

const { httpGet, httpGetBinary } = await import("../src/fetcher/http.js");
const { PrivateAddressError } = await import("../src/errors.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("C2: TOCTOU対策(DNS rebinding)", () => {
  it("事前検証(public)を通過しても、実接続時のDNS解決がprivateアドレスを返す場合は接続時点で拒否する(httpGet)", async () => {
    await expect(httpGet("http://rebind.example.test/", { timeoutMs: 3000 })).rejects.toThrow(PrivateAddressError);
  });

  it("httpGetBinaryでも同様に接続時点で拒否する", async () => {
    await expect(httpGetBinary("http://rebind.example.test/file.pdf", { timeoutMs: 3000 })).rejects.toThrow(PrivateAddressError);
  });
});
