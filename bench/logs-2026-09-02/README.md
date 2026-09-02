# 再計測ログ（2026-09-02 / amenbo v0.6.0 + 修正）

[2026-07-12 の計測](../logs-2026-07-12/) を、現行版で同じハーネス（`../bench.mjs`）で実行し直した生ログ。
公式 fetch（mcp-server-fetch）は 2026.8.18、Playwright MCP は @playwright/mcp 0.0.80、Jina Reader はキー無し r.jina.ai。

## ファイル

- `results-amenbo-before-fixes.json` — 修正前（v0.6.0 HEAD）の amenbo
- `results-amenbo-after-fixes.json` — 修正後（alt無し画像・空リンクの除去、応答なしタイムアウトの誘導文）の amenbo。**記事に載せる値**
- `results-{fetch,jina,playwright}.json` — 他ツール（`bench.mjs <tool>` の出力）
- `results-playwright-snapshots.json` — Playwright MCP の `browser_navigate` 応答が参照するスナップショット `.yml` 実体のトークン数（応答本体には含まれないため別計上。2026-07-12 分も同じ推定器で再計測）
- `results-pixelshot.json` — **全件失敗**（本環境で pixelshot の cdp バックエンドが example.com でも出力を生成しない。amenbo 側の問題ではない）。pixelshot の値は画像換算（`width×height÷750`）でトークン推定器の影響を受けないため、記事では 2026-07-12 の値を据え置く

## 要点

- **トークン推定器が変わったため絶対値は 2026-07-12 と直接比較できない**（`src/tokens.ts` を非ラテン文字・記号の実測に合わせて 2 回修正。全ツール同じ推定器で測り直しているので、ツール間の比較は有効）
- **公式 fetch の挙動は不変**: 5,000 文字打切り・Shift_JIS 文字化け・PDF 生バイト・CSV 生ダンプ・遮断サイトの robots.txt 誤報告をすべて再現（2026.8.18 の変更は依存パッケージの固定のみ）
- **CSV の約 5,000 倍差を再現**: amenbo 970 vs Jina Reader 4,908,137
- **amenbo の修正で zenn 5,104→4,527（-11%）、wiki 6,991→6,112（-13%）**。Zenn の見出しアンカー `[](#...)` と Wikipedia の国旗アイコン・サムネイル（alt 無し画像を包むリンク）が原因。Wikipedia は 7 月以降サムネイル URL に utm パラメータが付くようになり、mcp-server-fetch・Jina でもその分増えている
- **遮断サイト（initial.inc）の挙動が変化**: 7 月は接続リセット（即時）だったが、現在は amenbo の User-Agent に対して HTTP/1.1 では応答を返さず放置する。修正前の amenbo は「取得がタイムアウトしました(15000ms)」だけを返し次の一手が無かった。修正後は「応答なし」と明示し mode: screenshot での再試行を案内する。Jina Reader（12,028）と Playwright MCP はブラウザ実体を持つため取得に成功する
- 7URL の結果（修正後 amenbo / 公式 fetch / Jina / Playwright スナップショット実体）:

| URL | amenbo | mcp-server-fetch | Jina Reader | Playwright MCP |
|---|---|---|---|---|
| zenn | 4,527 | 2,800 ⚠️打切り | 4,476 | 9,556 |
| wiki | 6,112 (p1/3) | 2,219 ⚠️打切り | 54,120 | 67,757 |
| aozora | 8,014 (p1/25) | 2,373 ❌文字化け | 313,193 ⚠️全文一括 | 485,997 |
| gov | 1,914 ✅リンク誘導つき | 539 | 33,950 | 31,394 |
| pdf | 832 | 2,105 ❌生バイト | 822 | ❌取得不能 |
| csv | 970 ✅ハンドオフ | 2,859 ⚠️生ダンプ断片 | 4,908,137 | ❌DLのみ |
| err | 78 ❌応答なし＋誘導 | 22 ❌robots.txt誤報告 | 12,028 ✅ | 15,992 ✅ |

## 注意（計測方法）

- Playwright MCP の `results-playwright.json` の `textTokens` は `browser_navigate` 応答本体（73〜167）で、上表は `.yml` 実体（`results-playwright-snapshots.json`）の値
- amenbo の `err` は robots.txt（5 秒）＋本体（15 秒）の二段タイムアウトで約 21 秒かかる
