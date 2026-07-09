import { describe, expect, it } from "vitest";
import { isPrivateOrReservedIp } from "../src/fetcher/http.js";

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
});
