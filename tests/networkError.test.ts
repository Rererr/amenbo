import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch } from "undici";
import { NetworkError } from "../src/errors.js";
import { httpGet } from "../src/fetcher/http.js";

// src/fetcher/http.tsはグローバルfetchではなくnpmパッケージundiciのfetchを直接importして使う
// (Node 20〜24の同梱undiciとnpm undici v8 Agentのハンドラプロトコル不整合を避けるため)。
// そのためテストのモックもglobalThis.fetchではなくundiciモジュールのfetch exportを差し替える。
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});
const fetchMock = vi.mocked(undiciFetch);

function makeError(message: string, code?: string, cause?: unknown): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string; cause?: unknown };
  if (code) err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

describe("機能A: NetworkError.fromCause - undici causeチェーンの分類", () => {
  it("dns: ENOTFOUNDをdnsに分類し、screenshotヒントを付けない", () => {
    const dnsError = makeError("getaddrinfo ENOTFOUND initial.inc", "ENOTFOUND");
    const wrapped = makeError("fetch failed", undefined, dnsError);

    const error = NetworkError.fromCause("https://initial.inc/", wrapped);

    expect(error.kind).toBe("dns");
    expect(error.message).toContain("接続に失敗しました(DNS解決失敗): https://initial.inc/");
    expect(error.message).not.toContain("mode: screenshot");
  });

  it("dns: EAI_AGAINもdnsに分類する", () => {
    const dnsError = makeError("getaddrinfo EAI_AGAIN example.jp", "EAI_AGAIN");
    const error = NetworkError.fromCause("https://example.jp/", dnsError);
    expect(error.kind).toBe("dns");
  });

  it("tls: CERT_HAS_EXPIREDをtlsに分類し、screenshotヒントを付ける", () => {
    const tlsError = makeError("certificate has expired", "CERT_HAS_EXPIRED");
    const wrapped = makeError("fetch failed", undefined, tlsError);

    const error = NetworkError.fromCause("https://initial.inc/", wrapped);

    expect(error.kind).toBe("tls");
    expect(error.message).toBe(
      "接続に失敗しました(TLS/証明書エラー): https://initial.inc/ — サイト側がボットアクセスを遮断している可能性があります。mode: screenshot(ブラウザ経由)で再試行すると通る場合があります",
    );
  });

  it("tls: ERR_TLS_で始まるコードもtlsに分類する", () => {
    const tlsError = makeError("unable to verify", "ERR_TLS_CERT_ALTNAME_INVALID");
    const error = NetworkError.fromCause("https://example.jp/", tlsError);
    expect(error.kind).toBe("tls");
    expect(error.message).toContain("mode: screenshot");
  });

  it("connection: ECONNREFUSEDをconnectionに分類し、screenshotヒントを付ける", () => {
    const connError = makeError("connect ECONNREFUSED 1.2.3.4:443", "ECONNREFUSED");
    const wrapped = makeError("fetch failed", undefined, connError);

    const error = NetworkError.fromCause("https://example.jp/", wrapped);

    expect(error.kind).toBe("connection");
    expect(error.message).toContain("接続拒否/リセット");
    expect(error.message).toContain("mode: screenshot");
  });

  it("connection: ECONNRESET/ETIMEDOUT/EHOSTUNREACHもconnectionに分類する", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"]) {
      const error = NetworkError.fromCause("https://example.jp/", makeError("boom", code));
      expect(error.kind).toBe("connection");
    }
  });

  it("connection: ERR_HTTP2_STREAM_ERROR(実機検証: initial.incがNGHTTP2_INTERNAL_ERRORで失敗した実例)をconnectionに分類し、screenshotヒントを付ける", () => {
    const http2Error = makeError("Stream closed with error code NGHTTP2_INTERNAL_ERROR", "ERR_HTTP2_STREAM_ERROR");
    const wrapped = makeError("fetch failed", undefined, http2Error);

    const error = NetworkError.fromCause("https://initial.inc/", wrapped);

    expect(error.kind).toBe("connection");
    expect(error.message).toContain("mode: screenshot");
  });

  it("unknown: 認識できないコードは生メッセージを保持し、ヒントを付けない", () => {
    const weirdError = makeError("something odd happened", "EWEIRD");
    const wrapped = makeError("fetch failed", undefined, weirdError);

    const error = NetworkError.fromCause("https://example.jp/", wrapped);

    expect(error.kind).toBe("unknown");
    expect(error.message).toContain("something odd happened");
    expect(error.message).not.toContain("mode: screenshot");
  });

  it("unknown: codeプロパティが無い場合は最も深いメッセージを保持する", () => {
    const error = NetworkError.fromCause("https://example.jp/", new Error("fetch failed"));
    expect(error.kind).toBe("unknown");
    expect(error.message).toContain("fetch failed");
  });

  it("循環したcauseチェーンでも無限ループせず既定深さで打ち切る", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a; // 循環

    expect(() => NetworkError.fromCause("https://example.jp/", a)).not.toThrow();
  });
});

describe("機能A: guardedFetch(httpGet経由) - fetch失敗時にNetworkErrorへ分類する", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it("DNS解決失敗のcauseチェーンを持つfetch失敗はNetworkError(dns)になる", async () => {
    const dnsError = makeError("getaddrinfo ENOTFOUND initial.inc", "ENOTFOUND");
    fetchMock.mockRejectedValue(makeError("fetch failed", undefined, dnsError));

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).rejects.toMatchObject({
      constructor: NetworkError,
      kind: "dns",
    });
  });

  it("TLS拒否のcauseチェーンを持つfetch失敗はNetworkError(tls)になる", async () => {
    const tlsError = makeError("self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT");
    fetchMock.mockRejectedValue(makeError("fetch failed", undefined, tlsError));

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).rejects.toMatchObject({
      constructor: NetworkError,
      kind: "tls",
    });
  });
});
