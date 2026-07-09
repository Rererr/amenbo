/**
 * fetcher/http.ts — 素のHTTP GET(グローバルfetch)。
 *
 * - UA: 正直に amenbo であることを明示する
 * - J1: エンコーディング検出(Content-Typeヘッダ→metaタグ→encoding-japanese自動判定)
 * - SSRF防止: http(s)以外拒否、DNS解決してprivate/loopback/link-local IPを拒否
 *   (リダイレクト先も含めて毎ホップ検証する)
 * - タイムアウト(既定15秒)
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as Encoding from "encoding-japanese";
import { FetchTimeoutError, HttpStatusError, InvalidUrlError, PrivateAddressError } from "../errors.js";

export const USER_AGENT = "amenbo/0.1 (+https://github.com/Rererr/amenbo)";

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
  if (isInIpv6Range(n, "::ffff:0:0", 96)) {
    // IPv4-mapped IPv6: 埋め込みIPv4側を再判定する
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

/** URLのホストを解決し、private/予約アドレスであれば拒否する(SSRF対策)。 */
async function guardPublicAddress(urlStr: string): Promise<void> {
  const url = new URL(urlStr);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(urlStr, `サポート対象外のスキームです: ${url.protocol}`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalVersion = isIP(hostname);
  const addresses = literalVersion
    ? [hostname]
    : (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);

  for (const address of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new PrivateAddressError(urlStr, address);
    }
  }
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

// ---- HTTP GET本体 ----

export interface HttpGetOptions {
  timeoutMs?: number;
  /** 条件付きGET用の追加ヘッダ(If-None-Match/If-Modified-Since等)。 */
  headers?: Record<string, string>;
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
 * SSRF対策付きの素のHTTP GET。リダイレクトは手動で追跡し、毎ホップでSSRFガードを行う。
 * status 304(未変更)はエラーにせずそのまま返す(キャッシュ再検証用)。
 * 200以外(304を除く)の非2xxはHttpStatusErrorを投げる。
 */
export async function httpGet(url: string, options: HttpGetOptions = {}): Promise<HttpGetResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let currentUrl = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await guardPublicAddress(currentUrl);

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT, ...options.headers },
        });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new FetchTimeoutError(url, timeoutMs);
        }
        throw cause;
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new HttpStatusError(currentUrl, response.status, response.statusText);
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (response.status === 304) {
        return { finalUrl: currentUrl, status: 304, headers: response.headers, html: "", encoding: "" };
      }

      if (!response.ok) {
        throw new HttpStatusError(currentUrl, response.status, response.statusText);
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      const decoded = decodeHtmlBytes(buffer, response.headers.get("content-type"));
      return {
        finalUrl: currentUrl,
        status: response.status,
        headers: response.headers,
        html: decoded.text,
        encoding: decoded.encoding,
      };
    }

    throw new HttpStatusError(url, 310, "Too Many Redirects");
  } finally {
    clearTimeout(timer);
  }
}
