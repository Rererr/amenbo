/**
 * amenbo の型付きエラー階層。
 *
 * 方針: エラーは握り潰さず、原因が一目で分かるメッセージ + 構造化フィールドを持たせる。
 * server.ts はこれらの型で catch し、MCP エラーメッセージへ変換する。
 */

/** amenbo が投げる全エラーの基底クラス。 */
export abstract class AmenboError extends Error {
  /** エラー種別を識別する安定した文字列コード(MCPクライアント側でのハンドリング用)。 */
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** HTTP/ブラウザ取得がタイムアウトした。 */
export class FetchTimeoutError extends AmenboError {
  readonly code = "FETCH_TIMEOUT";

  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`取得がタイムアウトしました(${timeoutMs}ms): ${url}`);
  }
}

/** robots.txt によりアクセスが拒否された。 */
export class RobotsDeniedError extends AmenboError {
  readonly code = "ROBOTS_DENIED";

  constructor(readonly url: string) {
    super(`robots.txt によりアクセスが拒否されています: ${url}`);
  }
}

/** SSRF対策: private/loopback/link-local アドレスへのアクセスを拒否した。 */
export class PrivateAddressError extends AmenboError {
  readonly code = "PRIVATE_ADDRESS_DENIED";

  constructor(
    readonly url: string,
    readonly address: string,
  ) {
    super(`プライベート/ループバックアドレスへのアクセスは拒否されます: ${url} -> ${address}`);
  }
}

/** URLの形式が不正、またはサポート対象外のスキームである。 */
export class InvalidUrlError extends AmenboError {
  readonly code = "INVALID_URL";

  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`不正なURLです: ${url} (${reason})`);
  }
}

/** コンテンツタイプがサポート対象外(バイナリ・非HTML等)。 */
export class UnsupportedContentError extends AmenboError {
  readonly code = "UNSUPPORTED_CONTENT";

  constructor(
    readonly url: string,
    readonly contentType: string,
  ) {
    super(`サポート対象外のコンテンツタイプです: ${url} (${contentType})`);
  }
}

/** HTTP応答がエラーステータスを返した。 */
export class HttpStatusError extends AmenboError {
  readonly code = "HTTP_STATUS_ERROR";

  constructor(
    readonly url: string,
    readonly status: number,
    statusText: string,
  ) {
    super(`HTTPエラー(${status} ${statusText}): ${url}`);
  }
}

/** Playwrightブラウザの起動・操作に失敗した。 */
export class BrowserLaunchError extends AmenboError {
  readonly code = "BROWSER_LAUNCH_FAILED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(`ブラウザ起動/操作に失敗しました: ${message}`, options);
  }
}

/**
 * Chromium遅延化(§4)対応: postinstallを廃止したため、`npx -y amenbo install-browser`を
 * 未実行の環境ではChromiumが存在しない。BrowserLaunchErrorの単なる一種として握り潰さず、
 * LLM/利用者が次に取るべき行動(install-browserコマンド)を明示するために型を分ける。
 */
export class BrowserUnavailableError extends AmenboError {
  readonly code = "BROWSER_UNAVAILABLE";

  constructor(options?: { cause?: unknown }) {
    super(
      "この操作にはChromiumが必要ですが、まだインストールされていません。" +
        "`npx -y amenbo install-browser` を実行してください(初回のみ、約170MBのダウンロード)。" +
        "通常のHTTP取得(mode: markdown/outline等)はブラウザなしで動作します。",
      options,
    );
  }
}

/** Readability/Turndown等による本文抽出に失敗した。 */
export class ExtractionError extends AmenboError {
  readonly code = "EXTRACTION_FAILED";

  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`本文抽出に失敗しました: ${url} (${reason})`);
  }
}

/** outlineモードで得られたsection IDが、対象ページの見出し構成上に見つからなかった。 */
export class SectionNotFoundError extends AmenboError {
  readonly code = "SECTION_NOT_FOUND";

  constructor(
    readonly url: string,
    readonly sectionId: string,
  ) {
    super(`指定されたsectionが見つかりません: ${url} (section=${sectionId})`);
  }
}

/** 機能A: undiciのcauseチェーンから分類したネットワークエラーの種別。 */
export type NetworkErrorKind = "dns" | "tls" | "connection" | "unknown";

const NETWORK_ERROR_KIND_LABELS: Record<Exclude<NetworkErrorKind, "unknown">, string> = {
  dns: "DNS解決失敗",
  tls: "TLS/証明書エラー",
  connection: "接続拒否/リセット",
};

/** tls/connection時のみ付与するヒント(dns失敗はブラウザ経由でも解決しないため付けない)。 */
const NETWORK_ERROR_SCREENSHOT_HINT =
  " — サイト側がボットアクセスを遮断している可能性があります。mode: screenshot(ブラウザ経由)で再試行すると通る場合があります";

const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
]);

/** TLS関連のNode/OpenSSLエラーコード判定(CERT_接頭辞・ERR_TLS_接頭辞・代表的な証明書エラー名)。 */
function isTlsErrorCode(code: string): boolean {
  return (
    code.startsWith("CERT_") ||
    code.startsWith("ERR_TLS_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "HOSTNAME_MISMATCH"
  );
}

/**
 * HTTP/2レベルのエラーコード判定(ERR_HTTP2_接頭辞)。実機検証でボットブロック時に
 * NGHTTP2_INTERNAL_ERROR(ERR_HTTP2_STREAM_ERROR等)で失敗するケースを確認しており、
 * これはTLS拒否と同様「ブラウザ経由(mode: screenshot)なら通る」典型ケースのためconnection扱いにする。
 */
function isHttp2ErrorCode(code: string): boolean {
  return code.startsWith("ERR_HTTP2_");
}

function classifyNetworkErrorCode(code: string): NetworkErrorKind | null {
  if (DNS_ERROR_CODES.has(code)) return "dns";
  if (isTlsErrorCode(code)) return "tls";
  if (CONNECTION_ERROR_CODES.has(code) || isHttp2ErrorCode(code)) return "connection";
  return null;
}

interface CauseChainNode {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** Error.cause チェーンを辿ってノード列(自分自身含む)を取り出す(循環/深すぎる場合に備え深さ上限あり)。 */
function walkCauseChain(error: unknown, maxDepth = 5): CauseChainNode[] {
  const nodes: CauseChainNode[] = [];
  let current: unknown = error;
  for (let i = 0; i < maxDepth && current !== null && typeof current === "object"; i++) {
    nodes.push(current as CauseChainNode);
    current = (current as CauseChainNode).cause;
  }
  return nodes;
}

function buildNetworkErrorMessage(url: string, kind: NetworkErrorKind, rawMessage: string): string {
  const detail = kind === "unknown" ? rawMessage : NETWORK_ERROR_KIND_LABELS[kind];
  const hint = kind === "tls" || kind === "connection" ? NETWORK_ERROR_SCREENSHOT_HINT : "";
  return `接続に失敗しました(${detail}): ${url}${hint}`;
}

/**
 * ネットワークレベルの接続失敗(DNS解決失敗/TLSハンドシェイク拒否/接続拒否等)。
 * undiciがfetch失敗時に生成する `TypeError: fetch failed` は原因(cause)チェーンの奥に
 * 実際のNode/OpenSSLエラーコードを持つため、それを辿って分類する(fromCause参照)。
 */
export class NetworkError extends AmenboError {
  readonly code = "NETWORK_ERROR";

  private constructor(
    readonly url: string,
    readonly kind: NetworkErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** fetch失敗時のcause(生のTypeError等)からdns/tls/connection/unknownを分類して生成する。 */
  static fromCause(url: string, cause: unknown): NetworkError {
    const nodes = walkCauseChain(cause);

    for (const node of nodes) {
      if (typeof node.code === "string") {
        const kind = classifyNetworkErrorCode(node.code);
        if (kind) {
          return new NetworkError(url, kind, buildNetworkErrorMessage(url, kind, node.code), { cause });
        }
      }
    }

    // unknown分類時は原因チェーンの最も奥(最も具体的な原因)のメッセージを優先して保持する
    const deepestMessage = [...nodes]
      .reverse()
      .map((node) => node.message)
      .find((message): message is string => typeof message === "string");
    const rawMessage = deepestMessage ?? String(cause);
    return new NetworkError(url, "unknown", buildNetworkErrorMessage(url, "unknown", rawMessage), { cause });
  }
}

/** ダウンロード対象(PDF等)がサイズ上限を超えている。 */
export class PayloadTooLargeError extends AmenboError {
  readonly code = "PAYLOAD_TOO_LARGE";

  constructor(
    readonly url: string,
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(`サイズ上限(${maxBytes}バイト)を超えています: ${url} (${byteLength}バイト)`);
  }
}
