import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * code-reviewer指摘: guardPublicAddress(src/fetcher/http.ts)がdns.lookup()失敗を
 * NetworkErrorへラップし忘れていたバグの回帰テスト(既存のssrf.test.ts/networkError.test.ts
 * はIPリテラル分岐、またはfetch()自体の失敗しかカバーしておらず、guardPublicAddress内の
 * dnsLookup呼び出しそのものの失敗は未カバーだった)。
 * node:dns/promisesのlookupをモックし、ENOTFOUND相当のエラーを投げさせて検証する。
 */
const lookupMock = vi.fn();

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: (...args: Parameters<typeof actual.lookup>) => lookupMock(...args),
  };
});

const { guardPublicAddress } = await import("../src/fetcher/http.js");
const { NetworkError, PrivateAddressError } = await import("../src/errors.js");

beforeEach(() => {
  lookupMock.mockReset();
});

describe("guardPublicAddress - dns.lookup()失敗の分類", () => {
  it("ENOTFOUND(存在しないホスト)は生のErrorではなくNetworkError(dns)になる", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND no-such-host.invalid"), { code: "ENOTFOUND" });
    lookupMock.mockRejectedValue(dnsError);

    const rejection = guardPublicAddress("http://no-such-host.invalid/");
    await expect(rejection).rejects.toBeInstanceOf(NetworkError);
    await expect(rejection).rejects.toMatchObject({ kind: "dns" });
  });

  it("EAI_AGAINも同様にNetworkError(dns)になる", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo EAI_AGAIN example.jp"), { code: "EAI_AGAIN" });
    lookupMock.mockRejectedValue(dnsError);

    await expect(guardPublicAddress("http://example.jp/")).rejects.toMatchObject({ kind: "dns" });
  });

  it("dns.lookup()が正常に解決した場合は従来通りprivate/予約アドレス判定を行う", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(guardPublicAddress("http://internal.example.com/")).rejects.toBeInstanceOf(PrivateAddressError);
  });
});
