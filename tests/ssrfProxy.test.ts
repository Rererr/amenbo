import { request as httpRequest, createServer, type Server } from "node:http";
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSafeAddress, SsrfProxy } from "../src/fetcher/ssrfProxy.js";

/**
 * fetcher/ssrfProxy.ts のユニットテスト(Chromium非依存・完全オフライン)。
 * browser tierの接続時SSRF検証(DNS rebinding対策)の中核であるプロキシが、
 * private/予約IPへの接続を CONNECT / 平文HTTP の双方で遮断し、許可ホストは中継することを確認する。
 * 実接続の是非は resolve を注入して決定的に制御する。
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/** proxyへ生のリクエストを送り、応答の最初のステータス行を読む(拒否ケースの検証用)。 */
function rawStatusLine(proxyPort: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => socket.write(requestText));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const nl = buffer.indexOf("\r\n");
      if (nl !== -1) {
        socket.destroy();
        resolve(buffer.slice(0, nl));
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 4000);
  });
}

/** proxy経由(絶対URL request-target)で平文HTTP GETし、status/bodyを取得する。 */
function proxyHttpGet(proxyPort: number, absoluteUrl: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(absoluteUrl);
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: absoluteUrl, headers: { Host: target.host } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * proxyへCONNECTし、確立できたトンネルSocketを返す(非2xxはrejectする)。
 * 200応答ヘッダと同一TCPセグメントで先行到着したトンネルデータはhead引数に入り、
 * 以後のdataイベントには流れない(CIランナーでは書き込みが合体しやすく恒常的に発生する)ため、
 * unshiftでソケットの読み取りバッファへ戻してから返す。
 */
function proxyConnect(proxyPort: number, hostPort: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: hostPort });
    req.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        reject(new Error(`CONNECT status ${res.statusCode}`));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      resolve(socket as Socket);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("resolveSafeAddress", () => {
  it("公開IPリテラルはそのまま返す", async () => {
    expect(await resolveSafeAddress("8.8.8.8")).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("private/予約IPリテラルはnull(接続拒否)", async () => {
    expect(await resolveSafeAddress("127.0.0.1")).toBeNull();
    expect(await resolveSafeAddress("169.254.169.254")).toBeNull();
    expect(await resolveSafeAddress("10.0.0.1")).toBeNull();
    expect(await resolveSafeAddress("::1")).toBeNull();
  });
});

describe("SsrfProxy: CONNECT(HTTPS)", () => {
  it("private/予約アドレスへのCONNECTは403で拒否する", async () => {
    const proxy = new SsrfProxy();
    const port = await proxy.start();
    cleanups.push(() => proxy.close());

    const line = await rawStatusLine(port, "CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n");
    expect(line).toMatch(/^HTTP\/1\.1 403/);
  });

  it("許可ホストへのCONNECTはトンネルを確立し、上流のバイトを中継する", async () => {
    const upstream: TcpServer = createTcpServer((socket) => socket.end("UPSTREAM-OK"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const proxy = new SsrfProxy({ resolve: async () => ({ address: "127.0.0.1", family: 4 }) });
    const port = await proxy.start();
    cleanups.push(() => proxy.close());

    const tunnel = await proxyConnect(port, `allowed.test:${upstreamPort}`);
    const tunneled = await new Promise<string>((resolve) => {
      let data = "";
      tunnel.on("data", (c) => (data += c.toString("latin1")));
      tunnel.on("end", () => resolve(data));
    });
    tunnel.destroy();
    expect(tunneled).toContain("UPSTREAM-OK");
  });
});

describe("SsrfProxy: 平文HTTP転送", () => {
  it("private/予約アドレスへのHTTPリクエストは403で拒否する", async () => {
    const proxy = new SsrfProxy();
    const port = await proxy.start();
    cleanups.push(() => proxy.close());

    const line = await rawStatusLine(port, "GET http://10.0.0.1/ HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n");
    expect(line).toMatch(/^HTTP\/1\.1 403/);
  });

  it("許可ホストへのHTTPリクエストは上流へ転送し、上流の応答を返す", async () => {
    const upstream: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("FORWARDED-BODY");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));

    const proxy = new SsrfProxy({ resolve: async () => ({ address: "127.0.0.1", family: 4 }) });
    const port = await proxy.start();
    cleanups.push(() => proxy.close());

    const { status, body } = await proxyHttpGet(port, `http://allowed.test:${upstreamPort}/`);
    expect(status).toBe(200);
    expect(body).toContain("FORWARDED-BODY");
  });
});
