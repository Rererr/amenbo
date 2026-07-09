# amenbo 🐜💧

**Skims the web without making waves** — a Japanese-web-native MCP server for low-impact, token-efficient web collection.

amenbo(アメンボ / water strider)は、Claude Code や Codex のようなコーディングエージェント向けの [MCP](https://modelcontextprotocol.io) サーバーです。水面に波を立てずに滑る虫のように、**収集先に負荷をかけず・少ないトークンで** Web から情報を集めます。とりわけ**日本語サイト**に最適化しています。

## なぜ amenbo か

汎用のスクレイピングツールの多くは英語圏の Web を前提に作られており、日本語サイトでは次のような取りこぼしが起きがちです。amenbo はこれらを正面から扱います。

- **構造化が甘いサイト** — div の入れ子やテーブルレイアウトが多い日本語サイトでも、レンダリング結果のジオメトリ(見た目の配置)から本文領域を推定します
- **文字化け** — Shift_JIS / EUC-JP / ISO-2022-JP を自動判別
- **ふりがな** — `<ruby>` の振り仮名を除去し、本文の二重化を防止
- **画像で出す情報** — 画像化された料金表やバナー中心のページは、テキスト抽出が貧弱なとき自動でスクリーンショットに切り替え
- **国内主要サイト** — Qiita / Zenn / note / はてなブログ / Yahoo!ニュース / PR TIMES / Wikipedia 日本語版に専用アダプタ

## トークンを節約する仕組み

- **段階開示** — `mode: outline` で見出しツリーと各節のトークン量だけ先に返し、必要な節だけ `section` 指定で取得。長大なページを丸ごと流し込みません
- **CJK 対応の本文プルーニング** — 句読点密度・文字種比率・リンク密度でナビ/広告/フッターを除去
- **差分応答** — 一度取得した URL の再取得時、変更が無ければ `unchanged`、あれば変更された節だけを返します
- **自動 Markdown/画像切替** — 品質スコアが低いページだけスクリーンショットにし、壊れた Markdown を読ませて取り直す往復を避けます
- **CJK トークン見積り** — 日本語は英語よりトークン単価が重いため、文字種別の係数でページ分割の予算を計算します

## 収集先への低負荷

- **二段フェッチ** — まず素の HTTP GET。JS 描画が必要なページだけ headless Chromium に昇格するので、大半の取得でブラウザを起動しません
- **礼儀正しいクローラ** — robots.txt と Crawl-Delay を尊重、同一ドメインへは直列 + 既定 1 req/秒。リンク列挙は sitemap / RSS を優先しページを舐めません
- **正直な User-Agent** — ボットであることを明示します。**anti-bot 回避は実装しません**
- **キャッシュ** — ETag / If-Modified-Since で再検証し、無駄な再取得を避けます

## インストール

```bash
npm install -g amenbo
# postinstall で Chromium が入ります(SPA描画・スクリーンショット用)
```

または開発用途:

```bash
git clone https://github.com/Rererr/amenbo.git
cd amenbo
npm install
npm run build
```

### Claude Code への登録

`.mcp.json`(またはグローバル設定)に追加します:

```json
{
  "mcpServers": {
    "amenbo": {
      "command": "amenbo"
    }
  }
}
```

ローカルビルドを使う場合は `"command": "node", "args": ["/path/to/amenbo/dist/server.js"]`。

## ツール

### `fetch` — ページを取得
| パラメータ | 説明 |
|---|---|
| `url` | 取得対象 URL(http/https のみ。PDF 可) |
| `mode` | `auto`(既定・品質スコアで Markdown/screenshot 自動切替) / `markdown` / `outline`(見出し要約) / `screenshot` |
| `selector` | 本文を絞り込む CSS セレクタ |
| `section` | outline で得た section ID。その節の Markdown のみ返す |
| `page` | ページ番号(既定 1) |
| `max_tokens` | 1 ページの概算トークン上限(既定 8000) |
| `force_full` | true で差分応答・定型ブロック除去を無効化し常に全文を返す |

### `links` — リンクを列挙
| パラメータ | 説明 |
|---|---|
| `url` | 起点 URL |
| `filter` | URL/リンクテキストの部分一致、または `*` を使った glob |

sitemap → RSS/Atom → ページ内リンクの順で探索します。

### `screenshot` — スクリーンショット
| パラメータ | 説明 |
|---|---|
| `url` | 撮影対象 URL(http/https のみ) |
| `fullPage` | 既定 true。false で最初のビューポート分のみ |
| `width` | タイル幅 px(既定 1280) |
| `scale` | 解像度スケール 0.5〜1.0(既定 1.0)。小さいほど画像トークン減 |

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `AMENBO_CACHE_DIR` | `~/.cache/amenbo` | キャッシュ(SQLite + PNG)の保存先 |
| `AMENBO_CACHE_TTL_MS` | `900000`(15分) | キャッシュの有効期限 |
| `AMENBO_MAX_BODY_BYTES` | `20971520`(20MB) | 取得ボディの上限サイズ |

## セキュリティ

- **SSRF 対策** — http/https 以外のスキーム(`file:`, `ftp:` 等)を拒否。DNS 解決した接続先が private / loopback / link-local / 予約アドレスなら拒否。DNS rebinding(TOCTOU)対策として実接続を検証済み IP に固定します
- **ボディサイズ上限** — 巨大レスポンスによる OOM を防止

## 開発

```bash
npm run typecheck   # strict 型チェック
npm test            # vitest
npm run build       # dist/ へビルド
```

## ライセンス

[MIT](./LICENSE)
