import { describe, expect, it } from "vitest";
import { InvalidUrlError, PrivateAddressError } from "../src/errors.js";
import { assertHttpScheme, guardPublicAddress, isPrivateOrReservedIp } from "../src/fetcher/http.js";

describe("isPrivateOrReservedIp(SSRF対策)", () => {
  it("グローバルなIPv4アドレスは拒否しない", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
  });

  it("プライベート/ループバック/リンクローカルIPv4アドレスを拒否する", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("169.254.1.1")).toBe(true);
    expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
    expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true); // CGNAT
  });

  it("グローバルなIPv6アドレスは拒否しない", () => {
    expect(isPrivateOrReservedIp("2001:4860:4860::8888")).toBe(false);
  });

  it("ループバック/ユニークローカル/リンクローカルIPv6アドレスを拒否する", () => {
    expect(isPrivateOrReservedIp("::1")).toBe(true);
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
  });

  it("IPv4-mapped IPv6アドレスは埋め込みIPv4側で判定する", () => {
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("IPv4-compatible IPv6(deprecated, ::/96)も埋め込みIPv4側で判定する", () => {
    // `::127.0.0.1` = ::7f00:1。loopbackを指す埋め込みIPv4なので拒否する。
    expect(isPrivateOrReservedIp("::127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::169.254.169.254")).toBe(true);
  });

  it("NAT64 well-known prefix(64:ff9b::/96)も埋め込みIPv4側で判定する", () => {
    expect(isPrivateOrReservedIp("64:ff9b::7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateOrReservedIp("64:ff9b::a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isPrivateOrReservedIp("64:ff9b::808:808")).toBe(false); // 8.8.8.8(公開)
  });
});

describe("guardPublicAddress(C1: browser.ts/screenshot.tsが共通利用するスキーム+アドレス検証)", () => {
  it("file:スキームはInvalidUrlErrorで拒否する", async () => {
    await expect(guardPublicAddress("file:///etc/passwd")).rejects.toThrow(InvalidUrlError);
  });

  it("data:スキームはInvalidUrlErrorで拒否する", async () => {
    await expect(guardPublicAddress("data:text/html,<script>alert(1)</script>")).rejects.toThrow(InvalidUrlError);
  });

  it("IPリテラルのループバックアドレス(http)はPrivateAddressErrorで拒否する", async () => {
    await expect(guardPublicAddress("http://127.0.0.1/")).rejects.toThrow(PrivateAddressError);
  });

  it("メタデータエンドポイント相当のリンクローカルアドレスはPrivateAddressErrorで拒否する", async () => {
    await expect(guardPublicAddress("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(PrivateAddressError);
  });

  it("IPv6のIPリテラルアドレスはDNSを経由せず直接判定する(ループバック)", async () => {
    await expect(guardPublicAddress("http://[::1]/")).rejects.toThrow(PrivateAddressError);
  });
});

describe("assertHttpScheme(公開品質バグ修正: robots.txt取得/ブラウザ起動より前段の軽量スキーム検証)", () => {
  it("http(s)のURLは同期的に検証を通り、URLオブジェクトを返す", () => {
    expect(assertHttpScheme("https://example.com/").protocol).toBe("https:");
    expect(assertHttpScheme("http://example.com/").protocol).toBe("http:");
  });

  it("file:スキームはDNS解決を伴わず同期的にInvalidUrlErrorを投げる", () => {
    expect(() => assertHttpScheme("file:///etc/passwd")).toThrow(InvalidUrlError);
  });

  it("data:スキームも同様に拒否する", () => {
    expect(() => assertHttpScheme("data:text/html,<script>alert(1)</script>")).toThrow(InvalidUrlError);
  });
});
