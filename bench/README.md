# 競合比較ベンチ(2026-07-10)

記事「[エージェントのWeb取得、ツール次第でトークンが5000倍違った話](https://zenn.dev/rererr_engineer/articles/e571e5b6eb1d53)」の実測に使ったハーネスと生ログ。最新版は [docs/article-updated-2026-07-12.md](../docs/article-updated-2026-07-12.md)。最新の再計測は [logs-2026-09-02/](logs-2026-09-02/)。

注意: 各ログの公式 fetch(mcp-server-fetch)の挙動(Shift_JIS の文字化けなど)は、記録した時点のものです。その後 mcp-server-fetch が meta の charset を読むようになったとの報告があり(未確認)、2026-11 時点では古くなっている恐れがあり、再計測していません。対外の文言に使う前に再計測してください。

## 使い方

```bash
npm run build   # ../dist を用意

# 全ツール or 個別に実行(amenbo / fetch / playwright / jina / pixelshot)
node bench/bench.mjs amenbo

# 単発のamenbo呼び出し(JSON-RPC直叩き)
node bench/oneoff.mjs "https://example.com" '{"mode":"outline"}'
```

前提: `uv`(mcp-server-fetch用)・`npx`(Playwright MCP用)・`uv tool install pixelrag`(pixelshot用)。
Jina Readerはキー無しで r.jina.ai を叩く(レート制限あり)。

## ログ

`logs-2026-07-10/` に各ツールの結果JSONを保存。再計測は `logs-2026-07-12/`・`logs-2026-09-02/`（各 README に要点）。
amenboは `results-amenbo-after-fixes.json` が最終計測(記事に掲載した値)、`results-amenbo.json` は初回計測。
計測の考え方(トークン統一・画像換算)は記事本文を参照。
