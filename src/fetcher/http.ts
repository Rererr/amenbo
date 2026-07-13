/**
 * fetcher/http.ts — 素のHTTP GET(グローバルfetch)。
 *
 * - UA: 正直に amenbo であることを明示する
 * - J1: エンコーディング検出(Content-Typeヘッダ→metaタグ→encoding-japanese自動判定)
 * - SSRF防止: http(s)以外拒否、DNS解決してprivate/loopback/link-local IPを拒否
 *   (リダイレクト先も含めて毎ホップ検証する)。加えてDNS rebinding(TOCTOU)対策として、
 *   実接続時のDNS解決そのものにも検証を組み込む(下記「TOCTOU対策」節参照)
 * - タイムアウト(既定15秒)
 * - M1: レスポンスボディにサイズ上限を設ける(OOM DoS対策。既定値は環境変数で調整可)
 */
import { lookup as dnsCallbackLookup } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
// 注意: encoding-japaneseはCJS製で、Node ESMのcjs-module-lexerによる named export静的解析が
// この実装(module.exports = {...}を後段で組み立てる形)を検出できない。
// `import * as Encoding` はNode実行時にconvert/detectがundefinedになる実バグを踏むため、
// 常に真の module.exports を指すdefault importを使う(vitestは緩いCJS interopのため
// namespace importでも動いてしまい、この不整合はユニットテストでは検出できなかった)。
import Encoding from "encoding-japanese";
// 注意: グローバルfetch(Node同梱undici)ではなく、npmパッケージundiciのfetchを明示的に使う。
// Node 20〜24の同梱undiciは旧式ハンドラプロトコルでdispatchするため、npm undici v8系の
// Agent(新ハンドラプロトコル要求)をdispatcherとして渡すと「invalid onRequestStart method」で
// 実行時に落ちる(Node 26は同梱undiciがv8系のため問題が顕在化しなかった)。
// fetchとAgentを同一のundiciパッケージ由来に揃えることで、Nodeバージョンに依存しなくする。
import { Agent as UndiciAgent, fetch as undiciFetch, type Dispatcher, type Headers, type Response } from "undici";
import { AmenboError, FetchTimeoutError, HttpStatusError, InvalidUrlError, NetworkError, PayloadTooLargeError, PrivateAddressError } from "../errors.js";

export const USER_AGENT = "amenbo/0.3 (+https://github.com/Rererr/amenbo)";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const META_SNIFF_BYTES = 2048;

// ---- SSRF防止: private/loopback/link-local等の予約アドレス判定 ----

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

const IPV4_RESERVED_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8], // "この"ネットワーク
  ["10.0.0.0", 8], // プライベート
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // ループバック
  ["169.254.0.0", 16], // リンクローカル
  ["172.16.0.0", 12], // プライベート
  ["192.0.0.0", 24], // IETFプロトコル割当
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // プライベート
  ["198.18.0.0", 15], // ベンチマーク
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // マルチキャスト
  ["240.0.0.0", 4], // 予約/ブロードキャスト
];

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return IPV4_RESERVED_RANGES.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** IPv6アドレス文字列を128bit整数(BigInt)へ変換する(IPv4-mapped表記にも対応)。 */
function ipv6ToBigInt(ip: string): bigint {
  const clean = (ip.split("%")[0] ?? ip).toLowerCase();

  const expand = (parts: string[]): string[] =>
    parts.flatMap((part) => {
      if (!part.includes(".")) return [part];
      const octets = part.split(".").map(Number);
      const hi = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
      const lo = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
      return [hi, lo];
    });

  let headStr = clean;
  let tailStr = "";
  const doubleColonIndex = clean.indexOf("::");
  if (doubleColonIndex !== -1) {
    headStr = clean.slice(0, doubleColonIndex);
    tailStr = clean.slice(doubleColonIndex + 2);
  }

  const headParts = expand(headStr ? headStr.split(":") : []);
  const tailParts = expand(tailStr ? tailStr.split(":") : []);
  const missing = 8 - headParts.length - tailParts.length;
  const fullParts = [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts];

  let result = 0n;
  for (const part of fullParts) {
    result = (result << 16n) | BigInt(parseInt(part || "0", 16));
  }
  return result;
}

function isInIpv6Range(n: bigint, baseHex: string, prefixBits: number): boolean {
  const base = ipv6ToBigInt(baseHex);
  const shift = 128n - BigInt(prefixBits);
  return n >> shift === base >> shift;
}

function isPrivateIpv6(ip: string): boolean {
  const n = ipv6ToBigInt(ip);
  if (n === 0n || n === 1n) return true; // :: (未指定) / ::1 (ループバック)
  if (isInIpv6Range(n, "fc00::", 7)) return true; // ユニークローカル
  if (isInIpv6Range(n, "fe80::", 10)) return true; // リンクローカル
  // 下位32bitにIPv4を埋め込む各表記(IPv4-mapped ::ffff:0:0/96、deprecatedなIPv4-compatible ::/96、
  // NAT64の well-known prefix 64:ff9b::/96)は、埋め込みIPv4側が予約アドレスなら遮断する。
  // 例: `::127.0.0.1` や `64:ff9b::7f00:1` がloopback/内部へ到達しうる経路を塞ぐ(::/::1は上で処理済み)。
  if (isInIpv6Range(n, "::ffff:0:0", 96) || isInIpv6Range(n, "::", 96) || isInIpv6Range(n, "64:ff9b::", 96)) {
    const v4 = [Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn)].join(".");
    return isPrivateIpv4(v4);
  }
  return false;
}

/** IPアドレス(v4/v6)がprivate/loopback/link-local等の予約アドレスかどうか判定する。 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // 判定不能なものは安全側(拒否)に倒す
}

/**
 * URLがhttp(s)スキームかどうかだけを検証する軽量チェック(DNS解決は行わない)。
 *
 * server.ts(fetch/screenshotツール)・links.tsの各エントリポイントで、
 * politeness.guard(robots.txt取得)やブラウザ起動より前に最初に呼ぶことを想定している。
 * これを怠ると、例えば file:// のようなURLに対して politeness 側が
 * `new URL(url).origin` (file:等では "null" になる)から不正なrobots URL
 * (`null/robots.txt`)を組み立ててしまい、guardPublicAddress内の `new URL()` が
 * 生のTypeErrorを投げてスタックトレースがstderrに漏れる問題があった(公開品質バグ)。
 */
export function assertHttpScheme(urlStr: string): URL {
  const url = new URL(urlStr);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(urlStr, `サポート対象外のスキームです: ${url.protocol}`);
  }
  return url;
}

/**
 * URLのホストを解決し、private/予約アドレスであれば拒否する(SSRF対策)。
 * http(s)以外のスキーム(file:等)も拒否する。
 *
 * fetcher/browser.ts・screenshot.tsのPlaywrightナビゲーション(page.goto前・
 * リダイレクト再検証)からも共通利用する(C1: screenshot/browser層がSSRF/スキーム
 * 検証を経由していなかった問題への対応)。
 *
 * 注意(TOCTOU): この関数の検証と実際の接続(fetch/ブラウザのTCP接続)は別のDNS解決を
 * 行うため、その間にDNS rebindingが起きると理論上すり抜けうる。httpGet/httpGetBinaryの
 * 実接続については下記「TOCTOU対策」のssrfSafeLookupで接続時点そのものを検証しており、
 * この関数はスキーム検証と早期の分かりやすいエラーメッセージのための一次防御にあたる。
 */
export async function guardPublicAddress(urlStr: string): Promise<void> {
  const url = assertHttpScheme(urlStr);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalVersion = isIP(hostname);

  let addresses: string[];
  if (literalVersion) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);
    } catch (cause) {
      // CLI併設対応で発覚した既存の穴: この関数はguardedFetch(実fetch呼び出し)より前段で
      // 呼ばれるため、DNS解決失敗(ENOTFOUND等)がここで起きると生のNode dnsエラーが
      // AmenboErrorでラップされないまま上位へ素通りしていた(呼び出し元のcatchが
      // `error instanceof AmenboError`で分岐しているため、スタックトレース付きでstderrに
      // 漏れる/CLIがexit code 1で握り潰さず処理する、という設計が機能しない)。
      // guardedFetch内のfetch()自体のDNS失敗と同じ分類(NetworkError.fromCause)に揃える。
      throw NetworkError.fromCause(urlStr, cause);
    }
  }

  for (const address of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new PrivateAddressError(urlStr, address);
    }
  }
}

// ---- C2: TOCTOU対策(DNS rebinding) ----
//
// guardPublicAddressによる事前検証と実際の接続は別々のDNS解決になるため、検証直後に
// DNSレコードが private IP へ書き換わる(rebinding)と素通りしうる。これを塞ぐため、
// 実接続の名前解決そのものに検証を組み込んだundici Agentを作り、fetch()のdispatcherとして
// 渡す。検証で使ったIPアドレスへそのまま接続する(Host/SNIは元のホスト名のまま undici が
// 設定するため変わらない)ので、検証時点と接続時点のアドレスが必ず一致する。

/**
 * undiciのconnect.lookupはnet.connectと同様、呼び出し元がoptions.all=trueを渡した場合
 * `(err, addresses[])` 形式でコールバックする実装になっているが、Node公式の
 * `LookupFunction` 型定義はこの挙動をカバーしていない(上流の型定義の既知の制限)。
 * 実行時の挙動に合わせて型アサーションで対応する。
 */
const ssrfSafeLookup: LookupFunction = (hostname, options, callback) => {
  dnsCallbackLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err, "", 0);
      return;
    }

    const safeAddresses = addresses.filter((entry) => !isPrivateOrReservedIp(entry.address));
    if (safeAddresses.length === 0) {
      const blockedAddress = addresses[0]?.address ?? hostname;
      callback(new PrivateAddressError(hostname, blockedAddress) as unknown as NodeJS.ErrnoException, "", 0);
      return;
    }

    const wantsAll = (options as unknown as { all?: boolean } | null)?.all === true;
    if (wantsAll) {
      (callback as unknown as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, safeAddresses);
      return;
    }

    const [first] = safeAddresses;
    callback(null, first!.address, first!.family);
  });
};

let ssrfSafeDispatcher: Dispatcher | null = null;

/** httpGet/httpGetBinaryのfetch()に渡す、接続時点でSSRF検証を行うdispatcher(遅延生成・使い回し)。 */
function getSsrfSafeDispatcher(): Dispatcher {
  ssrfSafeDispatcher ??= new UndiciAgent({ connect: { lookup: ssrfSafeLookup } });
  return ssrfSafeDispatcher;
}

/**
 * fetch失敗時、原因チェーン(.cause)を辿ってssrfSafeLookupが投げたPrivateAddressErrorを探す。
 * undiciはconnector由来のエラーを `TypeError: fetch failed` でラップして投げるため、
 * そのままでは型情報が失われ、呼び出し側が「SSRFで拒否された」と判別できなくなる。
 */
function findPrivateAddressError(error: unknown): PrivateAddressError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof PrivateAddressError) return current;
    current = current.cause;
  }
  return undefined;
}

// ---- J1: エンコーディング検出 ----

type JapaneseEncodingLabel = "SJIS" | "EUCJP" | "JIS";

const CHARSET_ALIASES: Record<string, { encoding: "UTF8" | JapaneseEncodingLabel; displayName: string }> = {
  "utf-8": { encoding: "UTF8", displayName: "UTF-8" },
  utf8: { encoding: "UTF8", displayName: "UTF-8" },
  shift_jis: { encoding: "SJIS", displayName: "Shift_JIS" },
  "shift-jis": { encoding: "SJIS", displayName: "Shift_JIS" },
  sjis: { encoding: "SJIS", displayName: "Shift_JIS" },
  "x-sjis": { encoding: "SJIS", displayName: "Shift_JIS" },
  "windows-31j": { encoding: "SJIS", displayName: "Shift_JIS" },
  cp932: { encoding: "SJIS", displayName: "Shift_JIS" },
  ms932: { encoding: "SJIS", displayName: "Shift_JIS" },
  "euc-jp": { encoding: "EUCJP", displayName: "EUC-JP" },
  eucjp: { encoding: "EUCJP", displayName: "EUC-JP" },
  "x-euc-jp": { encoding: "EUCJP", displayName: "EUC-JP" },
  "iso-2022-jp": { encoding: "JIS", displayName: "ISO-2022-JP" },
  iso2022jp: { encoding: "JIS", displayName: "ISO-2022-JP" },
};

const AUTO_DETECT_DISPLAY_NAME: Record<JapaneseEncodingLabel, string> = {
  SJIS: "Shift_JIS",
  EUCJP: "EUC-JP",
  JIS: "ISO-2022-JP",
};

function charsetFromContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1] ?? null;
}

function charsetFromMetaTag(bytes: Uint8Array): string | null {
  // 先頭バイト列をASCII安全なlatin1として読み、metaタグの宣言を探す(この段階では文字化けしても問題ない)
  const head = Buffer.from(bytes.subarray(0, META_SNIFF_BYTES)).toString("latin1");
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (metaCharset?.[1]) return metaCharset[1];
  const httpEquiv = /<meta[^>]+http-equiv=["']?content-type["'][^>]*content=["'][^"']*charset=([\w-]+)/i.exec(head);
  return httpEquiv?.[1] ?? null;
}

function decodeWithEncoding(bytes: Uint8Array, encoding: "UTF8" | JapaneseEncodingLabel): string {
  if (encoding === "UTF8") return new TextDecoder("utf-8").decode(bytes);
  const codes = Encoding.convert(bytes, "UNICODE", encoding);
  return Encoding.codeToString(codes);
}

export interface DecodedHtml {
  text: string;
  /** 表示用のエンコーディング名(例: "UTF-8" / "Shift_JIS")。 */
  encoding: string;
}

/** J1: Content-Typeヘッダ→metaタグ→encoding-japanese自動判定の順でHTMLをデコードする。 */
export function decodeHtmlBytes(bytes: Uint8Array, contentTypeHeader: string | null): DecodedHtml {
  const declaredCharset = charsetFromContentType(contentTypeHeader) ?? charsetFromMetaTag(bytes);
  const declared = declaredCharset ? CHARSET_ALIASES[declaredCharset.toLowerCase()] : undefined;

  if (declared) {
    return { text: decodeWithEncoding(bytes, declared.encoding), encoding: declared.displayName };
  }

  const detected = Encoding.detect(bytes);
  if (detected === "SJIS" || detected === "EUCJP" || detected === "JIS") {
    return { text: decodeWithEncoding(bytes, detected), encoding: AUTO_DETECT_DISPLAY_NAME[detected] };
  }

  return { text: new TextDecoder("utf-8").decode(bytes), encoding: "UTF-8" };
}

// ---- M1: レスポンスボディのサイズ上限(OOM DoS対策) ----

const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024; // 20MB

/** 環境変数 AMENBO_MAX_BODY_BYTES で既定のボディサイズ上限を調整できる。 */
export function resolveDefaultMaxBodyBytes(): number {
  const raw = process.env.AMENBO_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES;
}

/**
 * レスポンスボディをmaxBytes上限付きで読み切る。
 * Content-Lengthヘッダでの事前チェックに加え、ヘッダ詐称・chunked転送対策として
 * ストリーミング中の実受信バイト数も逐次チェックする(超過時点で読み取りを打ち切る)。
 */
async function readBodyWithLimit(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maxBytes) {
    throw new PayloadTooLargeError(url, Number(declaredLength), maxBytes);
  }

  // 機能A(実機検証での追加修正): ヘッダ受信後のストリーミング読み取り中に接続断等が起きた場合、
  // 生のエラーを素通りさせずNetworkErrorへ分類する(意図的に投げているPayloadTooLargeError等の
  // AmenboErrorはそのまま再送出する)。
  try {
    if (!response.body) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new PayloadTooLargeError(url, buffer.length, maxBytes);
      }
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PayloadTooLargeError(url, total, maxBytes);
      }
      chunks.push(value);
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } catch (error) {
    if (error instanceof AmenboError) throw error;
    throw NetworkError.fromCause(url, error);
  }
}

// ---- HTTP GET本体 ----

export interface HttpGetOptions {
  timeoutMs?: number;
  /** 条件付きGET用の追加ヘッダ(If-None-Match/If-Modified-Since等)。 */
  headers?: Record<string, string>;
  /** レスポンスボディのサイズ上限(バイト)。既定は環境変数AMENBO_MAX_BODY_BYTES、未設定なら20MB。 */
  maxBytes?: number;
  /**
   * レビュー指摘対応: リダイレクトで最初のオリジンと異なるオリジンへ着地した場合のみ、
   * guardedFetch内から着地先URLで呼ばれるrobots.txt確認コールバック(politeness.checkRobotsAllowed相当)。
   * SSRF検証(guardPublicAddress)は毎ホップ行っているのに対し、robots.txtは初回URLの
   * politeness.guardでしか確認されず、別オリジンへの301/302で着地先がDisallow:/でも
   * 取得してしまう非対称があったための対応。同一オリジン内リダイレクトは初回guardで
   * 確認済みのため呼ばない。拒否時はRobotsDeniedErrorがそのまま伝播する。
   * robots.txt自体の取得(politeness.ts内のhttpGet呼び出し)には渡さないこと(無限再帰回避)。
   */
  checkRobots?: (url: string) => Promise<void>;
}

export interface HttpGetResult {
  finalUrl: string;
  status: number;
  headers: Headers;
  /** status 304 の場合は空文字。 */
  html: string;
  /** status 304 の場合は空文字。 */
  encoding: string;
}

/**
 * SSRF対策付きの手動リダイレクト追跡fetch。httpGet/httpGetBinaryの共通部分。
 * 呼び出し側がstatus 304/非2xxの扱いとボディの読み方(テキスト/バイナリ)を決める。
 */
async function guardedFetch(url: string, options: HttpGetOptions, controller: AbortController): Promise<{ finalUrl: string; response: Response }> {
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await guardPublicAddress(currentUrl);

    let response: Response;
    try {
      response = await undiciFetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, ...options.headers },
        // C2: 事前検証(guardPublicAddress)とは別に、実接続の名前解決そのものを検証する
        // dispatcherを使う(DNS rebindingのTOCTOU対策)。undiciのfetchはdispatcherを
        // RequestInitの正規オプションとして受け付けるため、型キャストは不要。
        dispatcher: getSsrfSafeDispatcher(),
      });
    } catch (cause) {
      const privateAddressError = findPrivateAddressError(cause);
      if (privateAddressError) {
        throw privateAddressError;
      }
      if (controller.signal.aborted) {
        throw new FetchTimeoutError(url, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }
      // 機能A: undiciのcauseチェーン(error.cause.code等)からdns/tls/connection/unknownを
      // 分類した型付きエラーにして投げる(以前は生の"TypeError: fetch failed"が素通りしていた)。
      throw NetworkError.fromCause(currentUrl, cause);
    }

    // 304 (Not Modified) は300-399の数値レンジに含まれるが、リダイレクトではなく
    // 条件付きGETの再検証結果であり、Locationヘッダを伴わない。ここで先に除外しないと
    // 「Locationヘッダの無いリダイレクト」として誤ってHttpStatusErrorになってしまう。
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get("location");
      if (!location) {
        throw new HttpStatusError(currentUrl, response.status, response.statusText);
      }
      // N3: Locationヘッダが不正な形式の場合、new URL()の生例外ではなく型付きエラーにする
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new InvalidUrlError(location, "リダイレクト先URLの形式が不正です");
      }

      // レビュー指摘対応: 着地先が別オリジンの場合のみrobots.txtを再確認する
      // (同一オリジン内リダイレクトは初回URLのpoliteness.guardで確認済みのため不要)。
      if (options.checkRobots && nextUrl.origin !== new URL(currentUrl).origin) {
        await options.checkRobots(nextUrl.toString());
      }

      currentUrl = nextUrl.toString();
      continue;
    }

    return { finalUrl: currentUrl, response };
  }

  throw new HttpStatusError(url, 310, "Too Many Redirects");
}

/**
 * SSRF対策付きの素のHTTP GET(テキスト/HTML用)。リダイレクトは手動で追跡し、毎ホップでSSRFガードを行う。
 * status 304(未変更)はエラーにせずそのまま返す(キャッシュ再検証用)。
 * 200以外(304を除く)の非2xxはHttpStatusErrorを投げる。
 */
export async function httpGet(url: string, options: HttpGetOptions = {}): Promise<HttpGetResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { finalUrl, response } = await guardedFetch(url, options, controller);

    if (response.status === 304) {
      return { finalUrl, status: 304, headers: response.headers, html: "", encoding: "" };
    }
    if (!response.ok) {
      throw new HttpStatusError(finalUrl, response.status, response.statusText);
    }

    const buffer = await readBodyWithLimit(response, finalUrl, options.maxBytes ?? resolveDefaultMaxBodyBytes());
    const decoded = decodeHtmlBytes(buffer, response.headers.get("content-type"));
    return {
      finalUrl,
      status: response.status,
      headers: response.headers,
      html: decoded.text,
      encoding: decoded.encoding,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type HttpGetBinaryOptions = HttpGetOptions;

export interface HttpGetBinaryResult {
  finalUrl: string;
  status: number;
  headers: Headers;
  /** status 304 の場合は空。 */
  bytes: Uint8Array;
  contentType: string | null;
}

/**
 * SSRF対策付きの素のHTTP GET(バイナリ用、PDF等)。デコードせずバイト列のまま返す。
 * Content-Lengthヘッダ・実バイト数の両方でmaxBytesを検証する(ヘッダ詐称対策として実サイズも確認)。
 * status 304(未変更)はhttpGetと同様エラーにせずそのまま返す(条件付きGETを行う将来の呼び出し元向け)。
 */
export async function httpGetBinary(url: string, options: HttpGetBinaryOptions = {}): Promise<HttpGetBinaryResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { finalUrl, response } = await guardedFetch(url, options, controller);

    if (response.status === 304) {
      return { finalUrl, status: 304, headers: response.headers, bytes: new Uint8Array(0), contentType: null };
    }
    if (!response.ok) {
      throw new HttpStatusError(finalUrl, response.status, response.statusText);
    }

    const bytes = await readBodyWithLimit(response, finalUrl, options.maxBytes ?? resolveDefaultMaxBodyBytes());

    return { finalUrl, status: response.status, headers: response.headers, bytes, contentType: response.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 機能B: 非HTMLコンテンツのハンドオフ応答用ルーティング ----

const HTML_CONTENT_TYPE_RE = /text\/html|application\/xhtml\+xml/i;
/**
 * ハンドオフ応答のプレビュー用に読み取るボディの上限(バイト)。CSV/JSON等のプレビュー
 * (ヘッダ+先頭数行、または既定max_tokens相当のテキスト)には十分な量である一方、
 * 数百MB〜GB級のオープンデータファイルの全体取得は避ける(politeness優先)。
 */
const HANDOFF_PREVIEW_BYTES = 256 * 1024; // 256KB

/**
 * readBodyWithLimitと異なり上限超過をエラーにせず「truncated」として扱う
 * (機能B: 非HTMLコンテンツのプレビュー用。ボディ全体は取得せず必要な分だけ読んで切断する)。
 */
async function readBodyPreview(response: Response, url: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  // 機能A(実機検証での追加修正): 読み取り中の接続断等をNetworkErrorへ分類する(readBodyWithLimitと同様)。
  try {
    if (!response.body) {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length <= maxBytes) return { bytes: buffer, truncated: false };
      return { bytes: buffer.subarray(0, maxBytes), truncated: true };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      total += value.length;
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return { bytes: result, truncated };
  } catch (error) {
    if (error instanceof AmenboError) throw error;
    throw NetworkError.fromCause(url, error);
  }
}

export type HttpGetRoutedResult =
  | { kind: "notModified"; status: 304; finalUrl: string; headers: Headers }
  | { kind: "html"; status: number; finalUrl: string; headers: Headers; html: string; encoding: string }
  | {
      kind: "handoff";
      status: number;
      finalUrl: string;
      headers: Headers;
      contentType: string | null;
      bytes: Uint8Array;
      /** Content-Lengthヘッダ由来の宣言サイズ(無ければnull)。 */
      declaredSize: number | null;
      /** プレビュー上限で本文を打ち切った場合true(ファイル全体は取得していない)。 */
      truncated: boolean;
    };

/**
 * 機能B: content-typeを見て、HTML本文の全体読み取り(既存のhttpGetと同じ挙動)か、
 * 非HTMLハンドオフ用のプレビュー読み取り(既定256KBで打ち切り)かを1回のfetchで振り分ける。
 * リダイレクト先を含め毎ホップでcontent-typeが確定するのは最終応答のみなので、
 * guardedFetchで得たヘッダを見てから初めてボディの読み方を決める。
 */
export async function httpGetRouted(url: string, options: HttpGetOptions = {}): Promise<HttpGetRoutedResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { finalUrl, response } = await guardedFetch(url, options, controller);

    if (response.status === 304) {
      return { kind: "notModified", status: 304, finalUrl, headers: response.headers };
    }
    if (!response.ok) {
      throw new HttpStatusError(finalUrl, response.status, response.statusText);
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || HTML_CONTENT_TYPE_RE.test(contentType)) {
      const buffer = await readBodyWithLimit(response, finalUrl, options.maxBytes ?? resolveDefaultMaxBodyBytes());
      const decoded = decodeHtmlBytes(buffer, contentType);
      return { kind: "html", status: response.status, finalUrl, headers: response.headers, html: decoded.text, encoding: decoded.encoding };
    }

    const declaredLengthHeader = response.headers.get("content-length");
    const declaredSize = declaredLengthHeader && Number.isFinite(Number(declaredLengthHeader)) ? Number(declaredLengthHeader) : null;
    const { bytes, truncated } = await readBodyPreview(response, finalUrl, HANDOFF_PREVIEW_BYTES);
    return { kind: "handoff", status: response.status, finalUrl, headers: response.headers, contentType, bytes, declaredSize, truncated };
  } finally {
    clearTimeout(timer);
  }
}
