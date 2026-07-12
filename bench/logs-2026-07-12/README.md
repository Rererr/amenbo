# 再計測ログ（2026-07-12 / amenbo v0.2.0）

[2026-07-10 の初回計測](../logs-2026-07-10/) を、現行版 v0.2.0（HEAD 時点）で同じハーネス（`../bench.mjs`）で実行し直した生ログ。

## ファイル

- `results-{amenbo,fetch,jina,playwright,pixelshot}.json` — 5ツール × 日本語実URL 7本（`bench.mjs <tool>` の出力）
- `results-amenbo-modes.json` — amenbo の `markdown` vs `outline` を CJK4本＋英語2本で計測（段階開示のトークン削減の裏付け）

## 要点

- **7URLのトークン数はほぼ 2026-07-10 と同一**。amenbo・mcp-fetch・pixelshot は全一致。
- **CSV の約5,000倍差を再現**: amenbo `909` vs Jina Reader `4,593,027`。
- **変化は1点**: 青空文庫（Shift_JIS）の Jina Reader が `503失敗` → `329,380トークンで成功`（文字化けはしないが振り仮名を残したまま全文一括）。
- **outline は markdown 比 75〜97% 削減**（例: wiki 5,337→659、aozora 7,992→408）。英語ページ（en-wiki / en-doc）でも同様。

## 注意（計測方法）

- Playwright MCP の `textTokens` は JSON-RPC の `browser_navigate` 応答のトークンで、参照先スナップショット `.yml` の実体（記事の 453,263）は含まない。記事本文の値は 2026-07-10 の計測方法（`.yml` 実体を別計上）に基づく。
- pixelshot は `visionTokens`（タイル画像を `width×height÷750` で換算）。
