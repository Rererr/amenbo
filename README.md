# amenbo 🐜💧

**Skims the web without making waves** — a Japanese-web-native MCP server for low-impact, token-efficient web collection.

amenbo(アメンボ / water strider)は、Claude Code や Codex のようなコーディングエージェント向けの [MCP](https://modelcontextprotocol.io) サーバーです。水面に波を立てずに滑る虫のように、**収集先に負荷をかけず・少ないトークンで** Web から情報を集めます。とりわけ**日本語サイト**に最適化しています。MCP クライアントを持たないシェル環境からは、同じコアを共有する CLI としても使えます([CLIとして使う](#cliとして使う)参照)。

## なぜ amenbo か

汎用のスクレイピングツールの多くは英語圏の Web を前提に作られており、日本語サイトでは次のような取りこぼしが起きがちです。amenbo はこれらを正面から扱います。

- **構造化が甘いサイト** — div の入れ子やテーブルレイアウトが多い日本語サイトでも、レンダリング結果のジオメトリ(見た目の配置)から本文領域を推定します
- **文字化け** — Shift_JIS / EUC-JP / ISO-2022-JP を自動判別
- **ふりがな** — `<ruby>` の振り仮名を除去し、本文の二重化を防止
- **画像で出す情報** — 画像化された料金表やバナー中心のページは、テキスト抽出が貧弱なとき自動でスクリーンショットに切り替え
- **国内主要サイト** — Qiita / Zenn / note / はてなブログ / Yahoo!ニュース / PR TIMES / Wikipedia 日本語版に専用アダプタ

類似ツール(公式 fetch MCP / Jina Reader / Playwright MCP / PixelRAG pixelshot)との実測比較は、記事「[エージェントのWeb取得、ツール次第でトークンが5000倍違った話](https://zenn.dev/rererr_engineer/articles/e571e5b6eb1d53)」を参照してください。ハーネスと生ログは [`bench/`](./bench/) にあります。

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

### エージェントに使い方を教える(推奨プロンプト)

ツール定義だけでは「段階開示で取る」といった使い方の作法までは伝わりません。以下を `CLAUDE.md` や `AGENTS.md` にコピペすると、エージェントが amenbo を効率よく使うようになります。

```markdown
## Web取得は amenbo を使う

- ページ取得は `fetch`(mode 既定 `auto`)。長そうなページや一部しか要らないページは、
  まず `mode: "outline"` で見出しと各節のトークン量を確認し、必要な節だけ `section` 指定で取得する
- 同じ URL の再取得で `unchanged` / `diff` が返るのは正常(変更なし / 変更節のみ)。
  全文が必要なときだけ `force_full: true` を使う
- サイト内のページを探すときは URL を推測せず `links`(`filter` で絞り込み)で列挙する
- シェルが使える環境で、キーワードで探したいだけの長いページや複数ページの一括収集は、
  CLI で `amenbo fetch <url> > page.md` に落として grep / 部分読みする(本文をコンテキストに入れない)。
  構造を見ながら判断したいページは従来どおり MCP の outline → section が向く
- 日本語以外のサイトにも使える(段階開示・キャッシュ・低負荷は言語非依存)。ただし本文抽出は
  日本語向けに調整しているため、非日本語ページで本文が欠けて見えるときは `selector` 指定か
  `mode: "screenshot"` で取り直す
- 料金表・レイアウトなど視覚情報が目的なら `screenshot`。`scale: 0.5` 程度で画像トークンを減らせる
- robots.txt 拒否や bot 対策による取得失敗は仕様(回避しない)。失敗はそのままユーザーに報告する
```

## CLIとして使う

`amenbo` は MCP サーバーと同一のコア(取得・キャッシュ・politeness・抽出ロジック)を共有する CLI としても動作します。引数なし、または `amenbo serve` は従来通り MCP サーバーとして起動する(`.mcp.json` の `"command": "amenbo"` はそのまま動きます)ので、既存の MCP 登録には影響しません。

```bash
# ページをMarkdownとして取得(標準出力へ)
amenbo fetch https://example.com/

# 長いページはまずoutlineで見出しとトークン量だけ確認
amenbo fetch https://example.com/ --mode outline

# 出力をファイルに落として grep や部分読み(head/sed)する
amenbo fetch https://example.com/ > page.md
grep -A3 "料金" page.md

# サイト内のリンクを列挙(sitemap/RSS優先)
amenbo links https://example.com/ --filter "blog/*"

# スクリーンショット(タイルPNGは--out-dirへ保存され、パスが標準出力に列挙される)
amenbo screenshot https://example.com/ --viewport-only --scale 0.5 --out-dir ./shots
```

各サブコマンドの詳細は `amenbo <fetch|links|screenshot> --help` を参照してください。

**MCP と CLI の使い分け**:

- **MCP** — エージェントの主経路。ブラウザ(Chromium)がプロセス内でウォームに保たれ、スクリーンショット等の画像を会話へ直接返せる。claude.ai のようにシェルを持たないホストのエージェントにも届く
- **CLI** — シェルスクリプト・CI・デバッグ用途、出力をファイルに落として `grep`/部分読みしたい場合、または MCP 非対応のエージェント/ツールチェーンから使う場合に向く。1 コマンド= 1 プロセスのためブラウザは毎回起動する

キャッシュ・差分応答(`unchanged`/`diff`)・レート制御(robots.txt/ドメイン毎の直列アクセス)の状態は MCP サーバーと CLI で共有されます(同じ `~/.cache/amenbo` を使うため)。ただしレート制御のプロセス間共有はベストエフォートです。同一ドメインへの直列化は各プロセス内でのみ厳密に保証され、MCP サーバーと複数の CLI 実行が同時に同じドメインへアクセスした場合、最小間隔が多少すり抜けることがあります。

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
