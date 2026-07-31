# リリース手順

amenbo は **4つの配布経路**を持ち、それぞれ独立に版数を持つ。リポジトリ内の版数が
`check-version-sync.mjs` で揃っていても、経路間の食い違いは検出されない。

v0.5.1 では GitHub / Zenodo のみ公開し、npm と MCP Registry は 0.5.0 のまま置いた。これは
「publish 対象は `dist` のみで v0.5.0 と内容差がない」という**意図的な判断**だったが、その判断は
タグ commit のログにしか残らず、レジストリを外から見ると漏れと区別がつかなかった（実際、5日後に
漏れと誤認して追加 publish している）。**経路を意図的に見送る場合は、判断そのものを下の表に残す。**

| 経路 | 反映のトリガー | 自動/手動 | 見送った版（理由） |
| --- | --- | --- | --- |
| GitHub Release | タグ push → Release 作成 | 手動 | — |
| Zenodo (DOI) | GitHub Release 作成 | **自動** | — |
| npm | `npm publish` | 手動 | — |
| MCP Registry | `mcp-publisher publish` | 手動 | — |

`dist` に差分のないドキュメント専用リリースなど、特定の経路を意図的に見送るのは正当な判断である。
その場合は上表の「見送った版」に版数と理由を1行で書く。書かないと、後から見た人（自分を含む）が
漏れと誤認して不要な publish を実行する。

## 前提: 機械ゲートが担保している範囲

`scripts/check-version-sync.mjs` が以下の一致を検証する（CI の全 unit ジョブ + タグ push 時の
`release-check.yml`）。**この範囲は手で確認しなくてよい**。

- `package.json` / `server.json`（トップレベル + `packages[].version`）/ `package-lock.json` /
  `CITATION.cff` / `src/fetcher/http.ts` の `USER_AGENT`（major.minor のみ）/ git タグ

裏を返すと、**外部レジストリへの反映は一切ゲートされていない**。以下はそこを人手で埋める手順である。

## 1. リリース前

- [ ] `main` が最新で、作業ツリーがクリーン
- [ ] 版数を bump（上記ゲート対象を全て。漏れは CI が落として教えてくれる）
- [ ] `npm run typecheck && npm run build && npm test` が通る
- [ ] `node scripts/check-version-sync.mjs` が OK
- [ ] `node scripts/mcp-init-smoke.mjs`（2025系）と `node scripts/mcp-modern-smoke.mjs`（2026-07-28）が
      **両方**通る — 片方だけ通る状態は、SDK の era 判定がどちらかに倒れた退行を意味する。
      ユニットテストは InMemoryTransport 直結のため 2025 系しか通らず、ここを省くと新era側が無検証になる
- [ ] `node scripts/e2e-smoke.mjs`（実URL）が通る — タグ push でも `e2e.yml` が自動実行するが、
      落ちてから気づくとタグを打ち直すことになるため先に手元で通す。実サイト相手なので
      push 毎には走っていない（push 毎に走るのはローカルのフィクスチャに対する統合テスト）
- [ ] `npm pack --dry-run` で tarball の中身と版数を確認（`files: ["dist"]` のため dist のみ）
- [ ] **リリースに含めたい変更が全てタグ対象コミットに入っているか確認**
      — v0.5.1 では README への DOI バッジ追加がタグの後に入り、npm の README と
      Zenodo アーカイブの README が食い違った（実害は無かったが、Zenodo は発行済み DOI の
      内容を差し替えられないため、タグの打ち直しでは回収できない）

## 2. 公開（この順序で実行する）

`mcp-publisher` は npm 上に当該バージョンが存在することを前提に所有権を検証するため、
**npm publish が先、mcp-publisher publish が後**。順序を入れ替えると Registry 側が失敗する。

- [ ] `git push && git push --tags` → `release-check.yml` の版数ゲートが通る
- [ ] GitHub Release を作成（→ Zenodo が自動でアーカイブし DOI を発行）
- [ ] `npm login` → `npm publish`
- [ ] `mcp-publisher login github` → `mcp-publisher publish`

npm 所有権の検証には `package.json` の `mcpName` フィールド（`io.github.Rererr/amenbo`）が使われる。
削除・改名すると Registry への publish が通らなくなる。

## 3. 公開後の検証

4経路すべてが同じ版数を指していることを確認する。ここを省くと冒頭の表の「手動」経路が静かに漏れる。

```sh
# npm の latest
curl -s https://registry.npmjs.org/amenbo | jq '."dist-tags".latest'

# MCP Registry の latest（server 版数と npm パッケージ参照版数の両方を見る）
curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=amenbo' \
  | jq '.servers[] | select(._meta."io.modelcontextprotocol.registry/official".isLatest)
        | {version: .server.version, npm: .server.packages[0].version}'

# GitHub Release
gh release list --limit 3
```

- [ ] npm の `dist-tags.latest` がタグと一致
- [ ] MCP Registry の `isLatest` エントリの `version` と `packages[0].version` が両方ともタグと一致
- [ ] GitHub Release と Zenodo（README の DOI バッジが解決する先）が最新版を指す
- [ ] 公開物での実環境スモーク（ローカルの `dist` ではなく **npm から落ちてきたもの**を叩く）

```sh
npx -y amenbo@<version> --help
npx -y amenbo@<version> fetch <robots.txt で許可された自分の管理下の URL>
```

スモークは `fetch_tier: http` で本文が取れることまで確認する（Chromium 昇格を踏まないパスが
最も利用頻度が高いため）。ユニットテストが全通していても、公開 tarball の同梱漏れや
`bin` の解決失敗はこのスモークでしか出ない。
