import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsupportedContentError } from "../src/errors.js";
import { fetchPage, type HandoffResult } from "../src/fetcher/index.js";
import { httpGetRouted } from "../src/fetcher/http.js";

const originalFetch = globalThis.fetch;

// Fetch仕様上、204/205/304は "null body status" であり Node の Response コンストラクタは
// 空文字列すら受け付けない(bodyはnullでなければならない)ため、その場合のみnullにする(httpGet.test.tsと同様)。
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function mockResponse(status: number, headers: Record<string, string> = {}, body = ""): Response {
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, { status, headers });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

describe("機能B: httpGetRouted - content-typeによるkind振り分け", () => {
  it("HTMLはkind: htmlで本文全体を返す(既存httpGetと同じ挙動)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { "content-type": "text/html; charset=utf-8" }, "<html><body>ok</body></html>"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGetRouted("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.kind).toBe("html");
    if (result.kind === "html") {
      expect(result.html).toContain("ok");
    }
  });

  it("content-typeヘッダが無い場合もHTML扱いにする(既存挙動と同じ)", async () => {
    // 文字列bodyを渡すとResponseコンストラクタがcontent-typeを自動補完してしまうため、
    // 「本当にヘッダが無い」状態を再現するにはReadableStream bodyを使う。
    const bytes = new TextEncoder().encode("<html>ok</html>");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: {} });
    const fetchMock = vi.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGetRouted("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.kind).toBe("html");
  });

  it("text/csvはkind: handoffになり、Content-LengthをdeclaredSizeとして返す", async () => {
    const csv = "id,name\n1,a\n2,b\n";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse(200, { "content-type": "text/csv; charset=utf-8", "content-length": String(csv.length) }, csv));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGetRouted("http://93.184.216.34/data.csv", { timeoutMs: 5000 });
    expect(result.kind).toBe("handoff");
    if (result.kind === "handoff") {
      expect(result.contentType).toContain("text/csv");
      expect(result.declaredSize).toBe(csv.length);
      expect(result.truncated).toBe(false);
      expect(new TextDecoder().decode(result.bytes)).toBe(csv);
    }
  });

  it("プレビュー上限(256KB)を超えるボディはtruncated: trueで打ち切る", async () => {
    const bigChunk = new Uint8Array(300 * 1024).fill(97); // 300KB > 256KBキャップ
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
    const fetchMock = vi.fn().mockResolvedValue(response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGetRouted("http://93.184.216.34/big.txt", { timeoutMs: 5000 });
    expect(result.kind).toBe("handoff");
    if (result.kind === "handoff") {
      expect(result.truncated).toBe(true);
      expect(result.bytes.length).toBe(256 * 1024);
    }
  });

  it("304はkind: notModifiedを返す(既存挙動と同じ)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(304, {}, ""));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await httpGetRouted("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.kind).toBe("notModified");
    expect(result.status).toBe(304);
  });
});

describe("機能B: fetchPage - 非HTMLコンテンツのハンドオフ", () => {
  it("text/csvはエラーを投げずHandoffResultを返す", async () => {
    const csv = "id,name\n1,a\n";
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { "content-type": "text/csv" }, csv));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchPage("http://93.184.216.34/data.csv", { timeoutMs: 5000 });
    expect("handoff" in result).toBe(true);
    if ("handoff" in result) {
      expect((result as HandoffResult).contentType).toContain("text/csv");
    }
  });

  it("application/zipもエラーを投げずHandoffResultを返す(メタデータのみ)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { "content-type": "application/zip" }, "PK\x03\x04"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchPage("http://93.184.216.34/archive.zip", { timeoutMs: 5000 });
    expect("handoff" in result).toBe(true);
  });

  it("URL拡張子で検出できないPDF(content-typeのみで判明)は既存通りUnsupportedContentErrorのままにする(回帰防止)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { "content-type": "application/pdf" }, "%PDF-1.4"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchPage("http://93.184.216.34/download", { timeoutMs: 5000 })).rejects.toThrow(UnsupportedContentError);
  });
});
