import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpStatusError } from "../src/errors.js";
import { httpGet, httpGetBinary } from "../src/fetcher/http.js";

const originalFetch = globalThis.fetch;

// Fetch仕様上、204/205/304は "null body status" であり Node の Response コンストラクタは
// 空文字列すら受け付けない(bodyはnullでなければならない)ため、その場合のみnullにする。
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function mockResponse(status: number, headers: Record<string, string> = {}, body = ""): Response {
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, { status, headers });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe("httpGet - 304 Not Modified", () => {
  it("304は300-399のリダイレクト範囲に含まれるが、リダイレクトとして誤検知せずstatus 304を返す(回帰テスト)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(304, { etag: '"abc"' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGet("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.status).toBe(304);
    expect(result.html).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("httpGetBinaryでも304を正しく扱う(リダイレクトとして誤検知しない)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(304, {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGetBinary("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.status).toBe(304);
  });
});

describe("httpGet - 通常のリダイレクト", () => {
  it("Locationヘッダ付きの302は追跡して最終的なレスポンスを返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(302, { location: "http://93.184.216.34/next" }))
      .mockResolvedValueOnce(mockResponse(200, { "content-type": "text/html; charset=utf-8" }, "<html><body>ok</body></html>"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGet("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("http://93.184.216.34/next");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Locationヘッダの無い300番台(304以外)はHttpStatusErrorを投げる", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(302, {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).rejects.toThrow(HttpStatusError);
  });
});

describe("httpGet - 非2xx", () => {
  it("404はHttpStatusErrorを投げる", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(404, {}, "not found"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).rejects.toThrow(HttpStatusError);
  });
});
