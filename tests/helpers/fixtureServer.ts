import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * ローカルのフィクスチャサーバー。実サイトへ出ていかずにHTTP層(Content-Typeによる経路分岐・
 * 条件付きGET・robots.txt/sitemapの優先順)を決定的に検証するために使う。
 *
 * 抽出ロジック自体はfixtureファイルを直接読むユニットテストが担当しており、ここが受け持つのは
 * 「HTTPを1往復させないと現れない挙動」だけ。実サイト相手のE2E(scripts/e2e-smoke.mjs)は
 * 現実の逸脱(charset宣言の誤り・CDNヘッダ・圧縮・リダイレクト)を見る役目で残す。
 */

const PDF_BYTES = readFileSync(new URL("../fixtures/sample-text.pdf", import.meta.url));
const MULTIPAGE_PDF_BYTES = readFileSync(new URL("../fixtures/sample-multipage.pdf", import.meta.url));
// ハンドオフのプレビュー上限(256KB)を超える大きさが要る。これ未満だとプレビュー読みでも
// 全体が入ってしまい、「判明時点で読み切っているか」を取得回数で判定できない。
const LARGE_PDF_BYTES = readFileSync(new URL("../fixtures/sample-large.pdf", import.meta.url));

const ETAG = '"fixture-v1"';
/** /target-a と /target-b が共有するETag(リソース間でETagが一意でない状況の再現用)。 */
const SHARED_ETAG = '"shared-v1"';
/** PDF版の共有ETag(着地先が変わっても304が返る状況の再現用)。 */
const SHARED_PDF_ETAG = '"shared-pdf-v1"';
const LAST_MODIFIED = "Wed, 03 Jul 2024 18:34:01 GMT";

const EN_ARTICLE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Quarterly Shipment Report</title></head>
<body>
<article>
<h1>Quarterly Shipment Report</h1>
<p>The logistics team reviewed every regional warehouse during the quarter and compiled the
results below. Volumes are counted at the moment a pallet leaves the loading dock, which is the
same convention used in previous reports, so the figures remain directly comparable.</p>
<h2>Regional totals</h2>
<p>The table below lists the shipment count and the average handling time for each region.
Handling time is measured from the arrival scan to the departure scan.</p>
<table>
<thead><tr><th>Region</th><th>Shipments</th><th>Average handling time</th></tr></thead>
<tbody>
<tr><td>North</td><td>1,204</td><td>18 minutes</td></tr>
<tr><td>South</td><td>987</td><td>22 minutes</td></tr>
<tr><td>East</td><td>1,530</td><td>15 minutes</td></tr>
</tbody>
</table>
<h2>Notes on the figures</h2>
<p>Two warehouses in the southern region were closed for maintenance for eleven days, which
explains the lower total there. No adjustment has been applied to the raw counts because the
reporting policy requires publishing the observed values without smoothing.</p>
<p>The next review will cover the following quarter and will use the same measurement points,
so the comparison across periods stays meaningful for every region listed above.</p>
</article>
</body>
</html>`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"><title>フィクスチャ一覧</title>
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
</head>
<body><h1>フィクスチャ一覧</h1><p>リンク列挙の優先順を検証するためのページです。</p>
<a href="/en/table.html">英語の表</a> <a href="/doc.pdf">PDF</a></body>
</html>`;

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>fixture feed</title>
<item><title>feed item 1</title><link>__ORIGIN__/feed/1.html</link></item>
<item><title>feed item 2</title><link>__ORIGIN__/feed/2.html</link></item>
</channel></rss>`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>__ORIGIN__/en/table.html</loc></url>
<url><loc>__ORIGIN__/doc.pdf</loc></url>
<url><loc>__ORIGIN__/etag.html</loc></url>
</urlset>`;

// 本文量が少ないと品質スコアが下がってブラウザ層への昇格が起き、同じページを二度取りに
// いってしまう(実測で確認)。条件付きGETの回数を数える都合上、HTTP層だけで完結する分量にする。
const ETAG_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>再検証の対象</title></head>
<body><article><h1>再検証の対象</h1>
<p>このページは ETag と Last-Modified を返し、If-None-Match が一致したときだけ 304 を返します。
再取得の際に本文を取り直していないことを確かめるために置いてあります。内容そのものは
検証結果に影響しませんが、本文抽出の対象として扱われる程度の分量が必要です。</p>
<h2>再検証の流れ</h2>
<p>初回の取得ではサーバーが 200 と本文を返し、応答に含まれる ETag と Last-Modified が
キャッシュへ保存されます。次回以降、保存期間を過ぎた状態で同じURLを取得すると、
保存しておいた値を If-None-Match と If-Modified-Since に載せて条件付きの取得を行います。</p>
<p>内容が変わっていなければサーバーは 304 だけを返し、本文は転送されません。取得側は
手元のキャッシュをそのまま使えるため、転送量も変換の処理も節約できます。変わっていれば
通常どおり 200 と新しい本文が返り、キャッシュはその内容で置き換えられます。</p>
<h2>この分量である理由</h2>
<p>短すぎる本文は抽出の品質が低いと判定され、描画を伴う取得へ切り替わることがあります。
そうなると同じページへの取得が余分に発生し、何回サーバーへ行ったかを数える検証が
成り立ちません。そのため、通常の記事と同程度の段落数を置いています。</p>
</article></body></html>`;

/** 本文抽出の対象として扱われる分量の記事を作る(短いとブラウザ層へ昇格して取得回数が増える)。 */
function article(title: string, marker: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head>
<body><article><h1>${title}</h1>
<p>${marker} この段落はどのURLの本文が返っているかを見分けるための目印を含みます。
取得側がどの表現をキャッシュから返したのかを、内容そのもので判定できるようにしています。</p>
<h2>この分量である理由</h2>
<p>短すぎる本文は抽出の品質が低いと判定され、描画を伴う取得へ切り替わることがあります。
そうなると同じページへの取得が余分に発生し、何回サーバーへ行ったかを数える検証が
成り立ちません。そのため、通常の記事と同程度の段落数を置いています。</p>
<p>内容そのものは検証結果に影響しませんが、本文抽出の対象として扱われる程度の分量が必要です。
段落を複数置くことで、抽出器が本文領域を安定して選べるようにしています。</p>
</article></body></html>`;
}

export interface FixtureServer {
  origin: string;
  /** パス毎のリクエスト回数(条件付きGETで実際に再取得したかの確認に使う)。 */
  hits: Map<string, number>;
  /** 最後に受け取ったIf-None-Matchヘッダ(条件付きGETが送られたかの確認に使う)。 */
  lastIfNoneMatch: string | undefined;
  /** /moving のリダイレクト先パス(テストから差し替えて着地先の変化を模す)。 */
  redirectTarget: string;
  /** /pdf-moving のリダイレクト先パス(PDF経路で同じ検証をするため)。 */
  pdfRedirectTarget: string;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const state: Pick<FixtureServer, "hits" | "lastIfNoneMatch" | "redirectTarget" | "pdfRedirectTarget"> = {
    hits: new Map(),
    lastIfNoneMatch: undefined,
    redirectTarget: "/target-a",
    pdfRedirectTarget: "/pdf-a",
  };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    state.hits.set(path, (state.hits.get(path) ?? 0) + 1);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (status: number, contentType: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": contentType, ...headers });
      res.end(status === 304 ? undefined : body);
    };

    switch (path) {
      case "/robots.txt":
        // Disallowは実サイト相手だと安全に検証できない(相手のrobots.txtに依存する)ため、
        // 拒否経路の検証はこのフィクスチャだけが担う。
        send(200, "text/plain; charset=utf-8", `User-agent: *\nDisallow: /denied/\n\nSitemap: ${origin}/sitemap.xml\n`);
        return;
      case "/sitemap.xml":
        send(200, "application/xml; charset=utf-8", SITEMAP_XML.replaceAll("__ORIGIN__", origin));
        return;
      case "/feed.xml":
        send(200, "application/rss+xml; charset=utf-8", FEED_XML.replaceAll("__ORIGIN__", origin));
        return;
      case "/":
      case "/index.html":
        send(200, "text/html; charset=utf-8", INDEX_HTML);
        return;
      case "/en/table.html":
        send(200, "text/html; charset=utf-8", EN_ARTICLE);
        return;
      case "/doc.pdf":
        send(200, "application/pdf", PDF_BYTES);
        return;
      case "/etag.html": {
        state.lastIfNoneMatch = req.headers["if-none-match"];
        const headers = { ETag: ETAG, "Last-Modified": LAST_MODIFIED };
        if (req.headers["if-none-match"] === ETAG) {
          send(304, "text/html; charset=utf-8", "", headers);
          return;
        }
        send(200, "text/html; charset=utf-8", ETAG_HTML, headers);
        return;
      }
      case "/download":
        // URL拡張子にPDFが現れない配布エンドポイント(官公庁の /download?id=123 型)。
        // content-typeで判明した時点で全体を読み切っているかを、取得回数で判定する。
        send(200, "application/pdf", LARGE_PDF_BYTES);
        return;
      case "/pdf-moving":
        send(302, "text/plain; charset=utf-8", "", { Location: `${origin}${state.pdfRedirectTarget}` });
        return;
      case "/pdf-a":
      case "/pdf-b": {
        state.lastIfNoneMatch = req.headers["if-none-match"];
        const headers = { ETag: SHARED_PDF_ETAG };
        if (req.headers["if-none-match"] === SHARED_PDF_ETAG) {
          send(304, "application/pdf", "", headers);
          return;
        }
        send(200, "application/pdf", path === "/pdf-a" ? PDF_BYTES : MULTIPAGE_PDF_BYTES, headers);
        return;
      }
      case "/no-store.html":
        send(200, "text/html; charset=utf-8", article("保存禁止のページ", "NO-STORE"), { "Cache-Control": "no-store" });
        return;
      case "/long-cache.html":
        send(200, "text/html; charset=utf-8", article("長いmax-ageのページ", "LONG-CACHE"), { "Cache-Control": "public, max-age=3600" });
        return;
      case "/concurrent.html":
        send(200, "text/html; charset=utf-8", article("同時取得の対象", "CONCURRENT"));
        return;
      case "/moving":
        // 着地先が変わるリダイレクト(条件付きGETの検証用)
        send(302, "text/plain; charset=utf-8", "", { Location: `${origin}${state.redirectTarget}` });
        return;
      case "/target-a":
      case "/target-b": {
        // どちらも同じETagを返す。ETagはリソース間で一意である必要がないため、
        // 着地先が変わっても304が返る状況をこれで再現する。
        state.lastIfNoneMatch = req.headers["if-none-match"];
        const headers = { ETag: SHARED_ETAG };
        if (req.headers["if-none-match"] === SHARED_ETAG) {
          send(304, "text/html; charset=utf-8", "", headers);
          return;
        }
        const marker = path === "/target-a" ? "TARGET-A" : "TARGET-B";
        send(200, "text/html; charset=utf-8", article(`移動先(${marker})`, marker), headers);
        return;
      }
      case "/denied/secret.html":
        // robots.txtで拒否されるため、ここへ到達した時点で検証は失敗している
        send(200, "text/html; charset=utf-8", "<html><body><p>到達してはいけない本文</p></body></html>");
        return;
      default:
        send(404, "text/plain; charset=utf-8", "not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    get hits() {
      return state.hits;
    },
    get lastIfNoneMatch() {
      return state.lastIfNoneMatch;
    },
    get redirectTarget() {
      return state.redirectTarget;
    },
    set redirectTarget(target: string) {
      state.redirectTarget = target;
    },
    get pdfRedirectTarget() {
      return state.pdfRedirectTarget;
    },
    set pdfRedirectTarget(target: string) {
      state.pdfRedirectTarget = target;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
