**このファイルは旧版です。最新版は [article-updated-2026-07-12.md](article-updated-2026-07-12.md) をご覧ください。**

# エージェントのWeb取得、ツール次第でトークンが5000倍違った話

## TL;DR

- コーディングエージェント用のWeb取得ツール5つ（自作の **amenbo** / MCP公式 **fetch** / **Jina Reader** / **Playwright MCP** / 話題の **PixelRAG(pixelshot)**）を、日本語の実URL 7本（技術記事・Wikipedia・Shift_JISサイト・官公庁・PDF・CSV・ボット遮断サイト）で比較した
- 3.9MBのCSVに対し、Jina Readerは**459万トークン**を返した（コンテキスト即死）。amenboはヘッダ行プレビュー＋取得手段の提示で**909トークン**。タイトルの5000倍はここ
- Shift_JISの青空文庫を文字化けせずテキスト化できたのはamenboだけ。Playwright MCPは同ページに**45万トークン**のスナップショットを生成した
- 「ページをスクショで読む」PixelRAG系のアプローチは、単一ページのライブ閲覧ではMarkdown比**2.4〜33倍**のトークンを消費し、Wikipediaでは寄付バナーが1枚目を占領した
- 比較調査そのものもamenboで行い、記事10本・約57,000トークン分の本文を約1/10のトークンで読んだ

![3.9MBのCSVを渡したときに各ツールが返すトークン数の比較。amenbo 909に対しJina Readerは4,593,027で約5,000倍](https://raw.githubusercontent.com/Rererr/amenbo/main/docs/images/bench-tokens-csv.png)

計測手順は記事内に、ハーネスと生ログは[リポジトリの `bench/`](https://github.com/Rererr/amenbo/tree/main/bench) にあります。

## この記事は何

[amenbo](https://github.com/Rererr/amenbo) という自作MCPサーバーの性能を、類似ツール4つと**同一URLセットの実測**で比較した記録です。

amenboは「日本語Webを、収集先に負荷をかけず・少ないトークンで読む」ことに全振りしたMCPサーバーです。作った動機は単純で、コーディングエージェントに日本語サイトを調べさせると、

- Shift_JISのページが文字化けする
- ナビ・ランキング枠・広告ごと全文が流し込まれてコンテキストが溶ける
- PDFやCSVのURLを渡すと生バイトが返ってくるか、エラーで止まる

という事故が頻発したからです。ただ「日本語に強い」と自称するだけなら誰でもできるので、実URLで測って比べることにしました。

### 比較対象と選定理由

| ツール | 形態 | 選定理由 |
|---|---|---|
| [amenbo](https://github.com/Rererr/amenbo) | MCP (stdio) | 本記事の主役。二段フェッチ＋CJK特化抽出 |
| [mcp-server-fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) | MCP (uvx) | MCP公式リファレンス実装。デファクトの基準線 |
| [Jina Reader](https://jina.ai/reader/) (r.jina.ai) | HTTP API | URL→Markdown系で最も普及。キー不要で再現しやすい |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP (npx) | ブラウザレンダリング系の代表 |
| [PixelRAG](https://github.com/StarTrail-org/PixelRAG) の pixelshot | CLI | 2026年上半期の話題株。「HTML解析をやめて全部スクショで読む」思想 |

Firecrawl MCPはAPIキー必須・有料クレジット制で読者が再現しにくいため見送りました（クラウド系の代表としてはJinaで代替）。

### PixelRAGについての注記

[PixelRAG](https://arxiv.org/abs/2606.28344)（Berkeley SkyLab/BAIR発）は正確には「Web取得ツール」ではなく、**事前レンダリングした画面画像に対する視覚検索（RAG）システム**です。Wikipedia 828万記事をスクショ化してインデックス済みで、その検索精度でテキストRAGを上回ったと報告しています。ライブのWeb取得であるamenboとは主戦場が違います。

ただしPixelRAGには **pixelbrowse** というClaude Code用プラグインが同梱されており、これは「HTMLを取得する代わりに `pixelshot` CLIでページをスクショしてエージェントに読ませる」ライブ閲覧機能です。ここはamenboの `fetch` と正面から交差するので、本記事では pixelshot を比較対象にしています。「検索基盤としてのPixelRAG」と「収集ツールとしてのamenbo」は併用できる関係で、対立するのは**常時ピクセル閲覧 vs Markdown優先＋品質低下時のみピクセル**という設計思想の部分です。

## 検証環境と計測方法

- macOS (Apple Silicon) / Node.js v26 / 2026-07-10 実施
- 各ツールをコールド状態（キャッシュなし）で起動し、同一URLに1回ずつアクセス
- MCP系3ツールは `dist/server.js` / `uvx mcp-server-fetch` / `npx @playwright/mcp@latest` を**JSON-RPC (stdio) で直接叩く**ハーネスで統一実行
- テキストのトークン数は同一の推定器（CJK文字種係数つき）で統一計測。画像は Claude の視覚トークン概算 `width × height ÷ 750` で換算
- Playwright MCPはスナップショットをファイル参照で返すため、参照先 `.yml` の実体トークンを計上

MCPサーバーをスクリプトから直接叩く部分はこれだけです（全ツール共通）:

```js
// newline区切りJSON-RPCで initialize → tools/call するだけ
const child = spawn("node", ["dist/server.js"], { env: { AMENBO_CACHE_DIR: tmpDir } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "0" },
}}) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
  name: "fetch", arguments: { url },
}}) + "\n");
```

### URLセット（日本語Webの「事故りやすい」7類型）

| ID | URL | 何を試すか |
|---|---|---|
| zenn | zenn.dev の人気技術記事 | 表24行＋コード5ブロックの再現 |
| wiki | ja.wikipedia.org 都道府県の人口一覧 | 表だらけのページ |
| aozora | 青空文庫『吾輩は猫である』(789_14547.html) | **Shift_JIS**・1.2MBの長文 |
| gov | 厚労省 介護サービス情報公表システム オープンデータ | 官公庁HTML・CSV/zipリンク105件 |
| pdf | 厚労省の日本語PDF | 非HTML(1) |
| csv | 同オープンデータのCSV (3.9MB) | 非HTML(2) |
| err | 素のHTTPクライアントを接続拒否するサイト | エラー時の挙動 |

## 結果: トークン消費

各ツールの応答をエージェントが読んだ場合の実測トークンです。

| URL | amenbo | mcp-server-fetch | Jina Reader | Playwright MCP | pixelshot |
|---|---|---|---|---|---|
| zenn | 4,679 | 2,627 ⚠️打切り | 4,216 | 9,049 | 11,462 🖼️10枚 |
| wiki | 5,337 (p1/4) | 2,078 ⚠️打切り | 38,014 | 55,970 | 1,178 ⚠️不完全 |
| aozora | **7,992** (p1/25) | 1,400 ❌文字化け | ❌503失敗 | **453,263** | 263,819 🖼️221枚 |
| gov | **1,774** ✅リンク誘導つき | 519 | 26,983 | 25,382 | 13,355 🖼️12枚 |
| pdf | **810** | 1,329 ❌生バイト | 802 | ❌取得不能 | ❌875×1px画像 |
| csv | **909** ✅ハンドオフ | 2,669 ⚠️生ダンプ断片 | **4,593,027** | ❌16MBをDLのみ | 1,186 ⚠️先頭画面のみ |

注記（各ツールの名誉のために）:

- mcp-server-fetch の「打切り」は仕様（既定 `max_length=5000` 文字、`start_index` で続きを取れる）。ただし全文を読むにはその分リクエストとトークンが積み上がる
- Playwright MCP は「操作の自動化」が本業で、読み取り特化ではない。それでも「ページを読む」用途に使われがちなので載せた
- pixelshot の wiki 1,178tok は一見優秀だが、後述の通り**本文の表が1行も入っていない**
- Jina の zenn 4,216tok は amenbo(4,679)より少ない。単純なMarkdown化の質は高い

### 長文でなにが起きるか

差が最も出たのは青空文庫の長編小説（1.2MB HTML）です。

- **amenbo**: 7,992トークン（テキスト予算に基づき25ページに自動分割、`page: 2` で続きを取得）
- **Playwright MCP**: 453,263トークンのアクセシビリティツリー
- **pixelshot**: 221枚のタイル画像 ≈ 263,819視覚トークン
- **mcp-server-fetch**: 文字化けした1,400トークン（後述）
- **Jina Reader**: 503エラー

![1.2MBのShift_JIS長文HTMLを渡したときに各ツールが返すトークン数の比較。amenbo 7,992に対しPlaywright MCPは453,263](https://raw.githubusercontent.com/Rererr/amenbo/main/docs/images/bench-tokens-aozora.png)

「1ページの上限が保証されている」ことは、エージェントの安定運用ではトークン総量そのものより効きます。1回の `fetch` が45万トークンを返す可能性があるツールは、コンテキスト管理の前提が立ちません。

## 結果: 本文抽出品質

zenn記事（表24行・コード5ブロック）の再現数:

| | 表の行数 | コードブロック |
|---|---|---|
| 元記事 | 24 | 5 |
| amenbo | **24** | **5** |
| Jina Reader | **24** | **5** |
| mcp-server-fetch | 14 ⚠️打切りのため | 4 |
| Playwright MCP | 0（a11yツリーのため表構造は別形式） | 0 |

抽出品質そのものはJinaも優秀です。amenboの取り分は「同品質を保ちながら、ナビ・ランキング枠・同意バナーを落とし、ページ予算を守る」ところにあります。Wikipediaの比較が分かりやすく、同一ページに対して:

- Jina: 38,014トークン（脚注・出典・言語リンクまで全部入り）
- amenbo: 5,337トークン × 4ページ（wikipedia-jaアダプタで本文と表を抽出、必要なら次ページ）

もうひとつ、官公庁ページ（厚労省のオープンデータページ）ではamenboは本文1,774トークンに加えて、こういう案内を自動で付けます:

```
data_sources:
- 110_訪問介護［15.4MB］ — https://www.mhlw.go.jp/content/12300000/jigyosho_110.csv
  (ほか104件、links filter:'*.csv' で列挙可)
- 110_訪問介護 — https://.../jigyosho_110_all_....zip (ほか279件)
```

「本文よりリンク先のデータが本体」というページは官公庁に多く、エージェントが次の一手（CSVのDL・集計）へ進むための足場になります。

### pixelshotのWikipediaで起きたこと

pixelshot（875px幅でレンダリングして固定高さタイルに分割）にWikipediaを渡したところ、返ってきた1枚目のタイルは**画面の大半がWikipediaの寄付バナー**でした。さらにキャプチャがページ高さ1,009pxで完了扱いになり、**肝心の人口一覧表は1行も画像に入っていませんでした**。

![pixelshotが返したWikipediaの1枚目のタイル。画面の大半を寄付バナーが占め、記事タイトルが最下部に見えるだけで人口一覧表は含まれていない](https://raw.githubusercontent.com/Rererr/amenbo/main/docs/images/pixelshot-wiki-tile1.jpg)
*pixelshotが返した唯一のタイル（無加工）。このタイルでキャプチャは完了扱いになる。*

これはpixelshotの実装バグというより、「見たままを切り取る」アプローチの構造的な弱点です。人間向けの画面には、本文以外の視覚要素（バナー・追従ヘッダ・クッキー同意）が大量に混ざります。PixelRAGの論文自身も、固定高さで表や段落が分断される「visual chunking」を未解決課題として挙げています。テキスト抽出には20年分の資産（Readability系）がありますが、視覚チャンキングはまだこれからです。

## 結果: CJK対応

Shift_JISの青空文庫で、各ツールの1行目を並べます。

```
amenbo:            吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。
mcp-server-fetch:  #### �� | �@��y�i�킪�͂��j�͔L�ł���B���O�͂܂������B
Jina Reader:       (503: upstream connect error or disconnect/reset before headers)
```

mcp-server-fetchはUTF-8前提のため、Shift_JIS/EUC-JP/ISO-2022-JPが現役の日本語Webでは文字化けします。ブラウザ系（Playwright MCP / pixelshot）は文字化けこそしないものの、前述の通り45万/26万トークンを支払うことになります。amenboはバイト列から文字コードを自動判別し、`<ruby>` の振り仮名除去・全角空白正規化まで行った上でMarkdown化します。

## 結果: 非HTML対応

日本の官公庁・自治体の情報はPDFとCSVでできています（体感）。URLを渡したときの挙動:

| | PDF | CSV (3.9MB) |
|---|---|---|
| amenbo | ✅テキスト抽出 810tok | ✅ヘッダ＋プレビュー＋誘導 909tok |
| mcp-server-fetch | ❌ `%PDF-1.7 %����...` 生バイト | ⚠️先頭5000文字の生ダンプ |
| Jina Reader | ✅テキスト抽出 802tok | ❌**4,593,027トークン**の全文 |
| Playwright MCP | ❌スナップショット不能 | ❌16MBをディスクにDLして終了 |
| pixelshot | ❌875×1pxの壊れ画像 | ⚠️先頭画面のスクショのみ |

amenboのCSV応答はこうなっています（「行き止まりを作らない」ハンドオフ設計）:

```
content_type: text/csv
size: 3909630
mode_used: handoff

都道府県コード又は市町村コード,No,都道府県名,市区町村名,事業所名,...
011011,0170101950,北海道,札幌市中央区,訪問介護事業所　心,...
（先頭数行のプレビュー）
```

LLMに3.9MBのCSVを「読ませる」ことに意味はありません。列構造が分かるプレビューを返し、集計はエージェントに `curl` + スクリプトでやらせる方が、正確で圧倒的に安い。この割り切りが効いて、Jinaとの差は**約5,000倍**になりました。

## 結果: エラー時ハンドオフ

素のHTTPクライアントを接続拒否するサイトでは:

- **amenbo**: `接続に失敗しました(接続拒否/リセット) — サイト側がボットアクセスを遮断している可能性があります。mode: screenshot(ブラウザ経由)で再試行すると通る場合があります` — エラーを分類し、次の一手を提示
- **mcp-server-fetch**: `Failed to fetch robots.txt due to a connection issue` — 実際に落ちたのは本体アクセスなのに、robots.txtのエラーとして報告され、原因調査をミスリードする

なおこのサイトには、ブラウザ実体を持つPlaywright MCPとpixelshotは普通にアクセスできました。「素のHTTPは蹴るがブラウザは通す」サイトに対して、ブラウザという実弾を持っていること自体が強いのは事実です。amenboもブラウザ昇格を持ち、同梱ChromiumのHTTP/2実装と相性の悪いCDNに当たった場合は**システムのChromeで1回だけ再試行**します（Chromeが無い環境では分類済みエラーに戻ります）。それでもボット対策のフィンガープリント検知に遮断される場合はあり、amenboはanti-bot回避を実装しない方針なので、そこは「行ける手段の提示」で正直に止まります。

## ドッグフーディング: この記事の調査もamenboでやった

比較記事の作法を知るために、Qiita/Zennの人気技術記事10本（合計約57,000トークン相当）を読みましたが、これもamenboで行いました。

1. `mode: outline` で見出しツリー＋各節のトークン数だけ取得（1記事あたり数百トークン）
2. 読む価値のある節だけ `section: "s12"` 指定でピンポイント取得

たとえば「before/after表の見せ方」を調べるために、ある記事の該当節だけを279トークンで取得しています。全文を流し込むのに比べ、**約1/10のトークン**で10本の構成分析が終わりました。エージェントに「調べ物」をさせるとき、この段階開示があるかないかでコンテキストの寿命が大きく変わります。

## 正直な総括（劣位も含む）

| 軸 | amenbo | 一言 |
|---|---|---|
| トークン消費 | ◎ | 上限保証＋段階開示。長文・CSVで桁違い |
| 本文抽出品質 | ○ | Jinaと同等品質＋バナー除去。圧勝ではない |
| CJK対応 | ◎ | Shift_JIS正常化は5ツール中amenboのみ |
| 非HTML対応 | ◎ | PDF・CSV両対応は5ツール中amenboのみ |
| エラー時ハンドオフ | ○ | 分類＋次の一手の提示は唯一 |
| JS必須ページの突破力 | △ | 専用ブラウザバイナリを持つPlaywright MCP等が上。amenboはHTTP/2非互換時のシステムChromeフォールバックで追随するが、anti-bot回避はしない方針 |
| 検索・インデックス | ✕ | PixelRAG本体の領分。amenboは検索を持たない（併用推奨） |
| スピード | △ | 礼儀（同一ドメイン直列・1req/秒）を優先。爆速クロールには不向き（設計思想） |

## まとめ

- 「日本語Webをエージェントに読ませる」文脈では、文字コード・非HTML・トークン予算の3点で汎用ツールとの差が実測で出た
- PixelRAG系の常時ピクセル閲覧は、視覚情報の保持では独壇場だが、ライブ閲覧のコストはMarkdown比2.4〜33倍。「Markdownで済むページはMarkdown、ダメなときだけピクセル」という使い分けが現実的
- エージェントの調べ物では、outline→section の段階開示のような「読む前に読む量を決められる」仕組みがコンテキストの寿命に直結する

amenboは `npm install -g amenbo` で入ります。リポジトリは [github.com/Rererr/amenbo](https://github.com/Rererr/amenbo)。ベンチのハーネスと生ログも公開しているので、追試・反例を歓迎します。

## 参考リンク

- [PixelRAG: Web Screenshots Beat Text for Retrieval-Augmented Generation (arXiv:2606.28344)](https://arxiv.org/abs/2606.28344)
- [StarTrail-org/PixelRAG](https://github.com/StarTrail-org/PixelRAG)
- [modelcontextprotocol/servers - fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch)
- [Jina Reader](https://jina.ai/reader/)
- [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
