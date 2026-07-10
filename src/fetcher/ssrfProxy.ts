/**
 * fetcher/ssrfProxy.ts — browser tierの接続時SSRF検証プロキシ。
 *
 * fetcher/http.tsのssrfSafeLookup(undiciの接続時DNS検証)に相当する仕組みを、
 * Playwright(Chromium)経由の全リクエストへ適用するためのローカルHTTPプロキシ。
 *
 * なぜ必要か: navigateSafelyの事前検証(guardPublicAddress)と、ブラウザが実際に接続する
 * タイミングの間にDNSがprivate IPへ書き換わるDNS rebinding(TOCTOU)は、page.route()による
 * 再検証だけでは塞げない(route検証もブラウザ自身のDNS解決とは別解決になるため)。
 * プロキシを噛ませるとChromiumはDNS解決を自前で行わず「ホスト名」をプロキシへ委ねるため、
 * 解決はプロキシ側の1回のみになり、そこでprivate/予約IPを弾いて検証済みIPへ接続することで
 * メインフレーム・サブフレーム・サブリソースの全経路でrebindingを原理的に不可能にする。
 *
 * HTTPS(CONNECT)はTCPトンネルとして中継する(TLSはブラウザ↔実サーバ間のend-to-endのまま
 * なのでMITMせず証明書検証も保たれる)。平文HTTPは検証済みIPへ転送する。
 */
import { request as httpRequest, createServer, type Server } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { isPrivateOrReservedIp } from "./http.js";

export interface ResolvedTarget {
  address: string;
  family: number;
}

/** ホスト名(またはIPリテラル)を解決し、公開アドレスを1つ返す。全て予約/解決不能ならnull(=接続拒否)。 */
export async function resolveSafeAddress(host: string): Promise<ResolvedTarget | null> {
  const literalVersion = isIP(host);
  if (literalVersion) {
    return isPrivateOrReservedIp(host) ? null : { address: host, family: literalVersion };
  }
  let results: Array<{ address: string; family: number }>;
  try {
    results = await dnsLookup(host, { all: true });
  } catch {
    return null;
  }
  const safe = results.find((entry) => !isPrivateOrReservedIp(entry.address));
  return safe ? { address: safe.address, family: safe.family } : null;
}

/** "host:port" / "[v6]:port" を分解する。ポート省略時はdefaultPortを使う。 */
function splitHostPort(hostPort: string, defaultPort: number): { host: string; port: number } {
  const bracketMatch = /^\[(.+)\](?::(\d+))?$/.exec(hostPort);
  if (bracketMatch) {
    return { host: bracketMatch[1] ?? "", port: bracketMatch[2] ? Number(bracketMatch[2]) : defaultPort };
  }
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon === -1) return { host: hostPort, port: defaultPort };
  return { host: hostPort.slice(0, lastColon), port: Number(hostPort.slice(lastColon + 1)) || defaultPort };
}

export interface SsrfProxyOptions {
  /** テスト用: ホスト解決を差し替える(既定はresolveSafeAddress = 実DNS + 予約IP判定)。 */
  resolve?: (host: string) => Promise<ResolvedTarget | null>;
}

/**
 * 接続時SSRF検証を行うローカルHTTPプロキシ。start()でlisten開始し、portを返す。
 * Chromiumの --proxy-server として渡すことで、ブラウザ発の全接続を検証下に置く。
 */
export class SsrfProxy {
  private readonly server: Server;
  private readonly resolve: (host: string) => Promise<ResolvedTarget | null>;
  private started = false;

  constructor(options: SsrfProxyOptions = {}) {
    this.resolve = options.resolve ?? resolveSafeAddress;
    this.server = createServer((clientReq, clientRes) => {
      void (async () => {
        let target: URL;
        try {
          target = new URL(clientReq.url ?? "");
        } catch {
          clientRes.writeHead(400).end();
          return;
        }
        if (target.protocol !== "http:") {
          clientRes.writeHead(400).end();
          return;
        }
        const port = target.port ? Number(target.port) : 80;
        const safe = await this.resolve(target.hostname);
        if (!safe) {
          clientRes.writeHead(403).end("blocked by amenbo SSRF proxy");
          return;
        }
        const upstream = httpRequest(
          {
            host: safe.address,
            port,
            method: clientReq.method,
            path: `${target.pathname}${target.search}`,
            headers: { ...clientReq.headers, host: target.host },
          },
          (upstreamRes) => {
            clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(clientRes);
          },
        );
        upstream.on("error", () => {
          if (!clientRes.headersSent) clientRes.writeHead(502);
          clientRes.end();
        });
        clientReq.pipe(upstream);
      })();
    });

    // HTTPS(CONNECT): 検証済みIPへTCPトンネルを張る(TLSはend-to-endのまま)。
    this.server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
      void (async () => {
        const { host, port } = splitHostPort(req.url ?? "", 443);
        const safe = await this.resolve(host);
        if (!safe) {
          clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        const upstream = netConnect(port, safe.address, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstream.destroy());
      })();
    });
  }

  /** listenを開始し、割り当てられたポート番号を返す(127.0.0.1ローカルのみ)。 */
  start(): Promise<number> {
    if (this.started) return Promise.resolve(this.port());
    this.started = true;
    return new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve(this.port()));
    });
  }

  port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("SSRFプロキシのポートを取得できません(listen前、またはUNIXソケット)");
    }
    return address.port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// ---- 共有インスタンス(browser.tsのchromium起動時に一度だけ起動する) ----

let sharedProxy: SsrfProxy | null = null;
let sharedProxyUrlPromise: Promise<string> | null = null;

/** browser tierが使うSSRF検証プロキシのURL(http://127.0.0.1:PORT)を遅延起動して返す。 */
export function getSharedSsrfProxyUrl(): Promise<string> {
  if (!sharedProxyUrlPromise) {
    sharedProxy = new SsrfProxy();
    sharedProxyUrlPromise = sharedProxy.start().then((port) => `http://127.0.0.1:${port}`);
  }
  return sharedProxyUrlPromise;
}

/** 共有プロキシを停止する(プロセス終了/テストのクリーンアップ用)。 */
export async function closeSharedSsrfProxy(): Promise<void> {
  const proxy = sharedProxy;
  sharedProxy = null;
  sharedProxyUrlPromise = null;
  if (proxy) await proxy.close();
}
