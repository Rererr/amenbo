import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch } from "undici";
import { HttpStatusError, InvalidUrlError, PayloadTooLargeError, RobotsDeniedError } from "../src/errors.js";
import { httpGet, httpGetBinary } from "../src/fetcher/http.js";

// src/fetcher/http.tsはグローバルfetchではなくnpmパッケージundiciのfetchを直接importして使う
// (Node 20〜24の同梱undiciとnpm undici v8 Agentのハンドラプロトコル不整合を避けるため)。
// そのためテストのモックもglobalThis.fetchではなくundiciモジュールのfetch exportを差し替える。
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});
const fetchMock = vi.mocked(undiciFetch);

// Fetch仕様上、204/205/304は "null body status" であり Node の Response コンストラクタは
// 空文字列すら受け付けない(bodyはnullでなければならない)ため、その場合のみnullにする。
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function mockResponse(status: number, headers: Record<string, string> = {}, body = ""): Response {
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, { status, headers });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("httpGet - 304 Not Modified", () => {
  it("304は300-399のリダイレクト範囲に含まれるが、リダイレクトとして誤検知せずstatus 304を返す(回帰テスト)", async () => {
    fetchMock.mockResolvedValue(mockResponse(304, { etag: '"abc"' }) as never);

    const result = await httpGet("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.status).toBe(304);
    expect(result.html).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("httpGetBinaryでも304を正しく扱う(リダイレクトとして誤検知しない)", async () => {
    fetchMock.mockResolvedValue(mockResponse(304, {}) as never);

    const result = await httpGetBinary("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.status).toBe(304);
  });
});

describe("httpGet - 通常のリダイレクト", () => {
  it("Locationヘッダ付きの302は追跡して最終的なレスポンスを返す", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(302, { location: "http://93.184.216.34/next" }) as never)
      .mockResolvedValueOnce(mockResponse(200, { "content-type": "text/html; charset=utf-8" }, "<html><body>ok</body></html>") as never);

    const result = await httpGet("http://93.184.216.34/", { timeoutMs: 5000 });
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("http://93.184.216.34/next");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Locationヘッダの無い300番台(304以外)はHttpStatusErrorを投げる", async () => {
    fetchMock.mockResolvedValue(mockResponse(302, {}) as never);

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).rejects.toThrow(HttpStatusError);
  });
});

describe("httpGet - 非2xx", () => {
  it("404はHttpStatusErrorを投げる", async () => {
    fetchMock.mockResolvedValue(mockResponse(404, {}, "not found") as never);

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).rejects.toThrow(HttpStatusError);
  });
});

describe("httpGet - N3: リダイレクト先URLが不正な形式", () => {
  it("Locationヘッダの形式が不正な場合、生のTypeErrorではなくInvalidUrlErrorを投げる", async () => {
    fetchMock.mockResolvedValue(mockResponse(302, { location: "http://[::1" }) as never);

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).rejects.toThrow(InvalidUrlError);
  });
});

describe("httpGet/httpGetBinary - M1: レスポンスボディのサイズ上限(OOM DoS対策)", () => {
  it("Content-Lengthヘッダが上限を超える場合、ボディを読む前にPayloadTooLargeErrorを投げる", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { "content-type": "text/html", "content-length": "999999999" }, "dummy") as never);

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000, maxBytes: 100 })).rejects.toThrow(PayloadTooLargeError);
  });

  it("Content-Lengthが無く実際の受信量が上限を超える場合、ストリーミング中に打ち切ってPayloadTooLargeErrorを投げる(ヘッダ詐称対策)", async () => {
    const bigChunk = new Uint8Array(200).fill(97); // "a" * 200
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
    fetchMock.mockResolvedValue(response as never);

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000, maxBytes: 100 })).rejects.toThrow(PayloadTooLargeError);
  });

  it("上限以下のボディは通常通り取得できる", async () => {
    fetchMock.mockResolvedValue(mockResponse(200, { "content-type": "text/html; charset=utf-8" }, "<html>ok</html>") as never);

    const result = await httpGet("http://93.184.216.34/", { timeoutMs: 5000, maxBytes: 1000 });
    expect(result.html).toContain("ok");
  });

  it("httpGetBinaryでも同様にストリーミング中のサイズ超過を検知する", async () => {
    const bigChunk = new Uint8Array(200).fill(1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigChunk);
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "application/pdf" } });
    fetchMock.mockResolvedValue(response as never);

    await expect(httpGetBinary("http://93.184.216.34/x.pdf", { timeoutMs: 5000, maxBytes: 100 })).rejects.toThrow(PayloadTooLargeError);
  });
});

describe("httpGet - checkRobots(レビュー指摘対応: リダイレクト着地先の別オリジンrobots確認)", () => {
  it("同一オリジン内リダイレクトはcheckRobotsを呼ばない(初回URLのpoliteness.guardで確認済みのため)", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(302, { location: "http://93.184.216.34/next" }) as never)
      .mockResolvedValueOnce(mockResponse(200, { "content-type": "text/html" }, "<html>ok</html>") as never);
    const checkRobots = vi.fn().mockResolvedValue(undefined);

    await httpGet("http://93.184.216.34/", { timeoutMs: 5000, checkRobots });

    expect(checkRobots).not.toHaveBeenCalled();
  });

  it("別オリジンへのリダイレクトは着地先URLでcheckRobotsを呼ぶ", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(302, { location: "http://93.184.216.35/next" }) as never)
      .mockResolvedValueOnce(mockResponse(200, { "content-type": "text/html" }, "<html>ok</html>") as never);
    const checkRobots = vi.fn().mockResolvedValue(undefined);

    const result = await httpGet("http://93.184.216.34/", { timeoutMs: 5000, checkRobots });

    expect(checkRobots).toHaveBeenCalledTimes(1);
    expect(checkRobots).toHaveBeenCalledWith("http://93.184.216.35/next");
    expect(result.finalUrl).toBe("http://93.184.216.35/next");
  });

  it("checkRobotsが拒否(RobotsDeniedError)を投げた場合、fetch全体が失敗し着地先への実際のfetchは行われない", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(302, { location: "http://93.184.216.35/next" }) as never);
    const checkRobots = vi.fn().mockRejectedValue(new RobotsDeniedError("http://93.184.216.35/next"));

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000, checkRobots })).rejects.toThrow(RobotsDeniedError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 着地先(2ホップ目)への実fetchは発生しない
  });

  it("checkRobots未指定でも従来通り動作する(完全後方互換)", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(302, { location: "http://93.184.216.35/next" }) as never)
      .mockResolvedValueOnce(mockResponse(200, { "content-type": "text/html" }, "<html>ok</html>") as never);

    await expect(httpGet("http://93.184.216.34/", { timeoutMs: 5000 })).resolves.toMatchObject({ status: 200 });
  });
});
