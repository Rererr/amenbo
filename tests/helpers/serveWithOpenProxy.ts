/**
 * テスト用の起動口: 実際の runServer を動かす前に、共有の SSRF 検証プロキシを listen させておく。
 * ブラウザを起動したときと同じく、終了処理(closeBrowser)が閉じない限りプロセスが終われない状態を作り、
 * stdin を閉じたら終わるかで runServer の終了処理の配線を確かめる(ブラウザは起動しない)。
 */
import { getSharedSsrfProxyUrl } from "../../src/fetcher/ssrfProxy.js";
import { runServer } from "../../src/server.js";

await getSharedSsrfProxyUrl();
await runServer();
