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
