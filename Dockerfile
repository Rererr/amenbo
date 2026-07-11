# Glama等のコンテナホスティング用イメージ。
# ベースはplaywright公式イメージ(Chromium本体と依存ライブラリを同梱)。タグのバージョンは
# package-lock.jsonのplaywrightと一致させること。amenboはpostinstallでChromiumを取得しない
# (Chromium遅延化。README/`amenbo install-browser`参照)ため、このベースイメージが同梱する
# Chromiumがそのまま使われる。バージョンが食い違うと同梱ブラウザをplaywrightが認識できない
# ため、タグ更新時はpackage-lock.jsonのplaywrightバージョンとの一致を維持すること。
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# chromiumはroot実行だとsandboxを起動できないため、イメージ同梱の非rootユーザーで実行する。
# キャッシュ(~/.cache/amenbo)はpwuserのホーム配下に書かれる。
USER pwuser

CMD ["node", "dist/server.js"]
