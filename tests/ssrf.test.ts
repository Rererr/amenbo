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

  it("6to4(2002::/16)はprefix直後の32bitに埋め込まれたIPv4側で判定する", () => {
    expect(isPrivateOrReservedIp("2002:7f00:1::")).toBe(true); // 127.0.0.1
    expect(isPrivateOrReservedIp("2002:a9fe:a9fe::")).toBe(true); // 169.254.169.254
    expect(isPrivateOrReservedIp("2002:808:808::")).toBe(false); // 8.8.8.8(公開)
  });

  it("IPv6マルチキャストを拒否する(IPv4の224.0.0.0/4と対称に扱う)", () => {
    expect(isPrivateOrReservedIp("ff02::1")).toBe(true); // 全ノード
    expect(isPrivateOrReservedIp("ff05::1:3")).toBe(true); // サイトローカルDHCPサーバ
    expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true); // IPv4側(既存の対称なルール)
  });

  it("特殊用途として予約されたIPv4/IPv6範囲を拒否する", () => {
    expect(isPrivateOrReservedIp("192.88.99.1")).toBe(true); // 6to4リレーエニーキャスト
    expect(isPrivateOrReservedIp("2001:db8::1")).toBe(true); // ドキュメント用
    expect(isPrivateOrReservedIp("2001::1")).toBe(true); // Teredo
    expect(isPrivateOrReservedIp("2001:2::1")).toBe(true); // ベンチマーク
    expect(isPrivateOrReservedIp("2001:10::1")).toBe(true); // ORCHID(廃止済み)
    expect(isPrivateOrReservedIp("100::1")).toBe(true); // Discard-Only
    expect(isPrivateOrReservedIp("100:0:0:1::1")).toBe(true); // Dummy IPv6 Prefix
    expect(isPrivateOrReservedIp("64:ff9b:1::7f00:1")).toBe(true); // NAT64 local-use
  });

  it("2001::/23内でも到達性のあるエニーキャストは拒否しない(過剰遮断の防止)", () => {
    expect(isPrivateOrReservedIp("2001:1::1")).toBe(false); // PCPエニーキャスト
    expect(isPrivateOrReservedIp("2001:3::1")).toBe(false); // AMT
    expect(isPrivateOrReservedIp("2001:4:112::1")).toBe(false); // AS112-v6
    expect(isPrivateOrReservedIp("2001:20::1")).toBe(false); // ORCHIDv2
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
