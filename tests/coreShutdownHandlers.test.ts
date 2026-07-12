import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * レビュー指摘対応(Medium): core.tsのexit/SIGINT/SIGTERMハンドラ登録は以前モジュール
 * トップレベルで即時実行されており、core.tsをimportするだけの全テスト(vitestワーカー)にも
 * closeBrowser().finally(() => process.exit(0))というSIGINT/SIGTERMハンドラが仕込まれていた。
 * registerCoreShutdownHandlers()へ切り出し、server.ts runServer()からのみ呼ぶよう変更したため、
 * importするだけでは登録が発生しないこと・明示的に呼んだ場合のみ登録されること・多重呼び出しでも
 * 二重登録しない(冪等)ことを検証する。
 *
 * 実際にprocess.once("SIGINT"/"SIGTERM", ...)を本物のリスナーとして残すと、テストプロセスへ
 * シグナルが届いた際にcloseBrowser().finally(() => process.exit(0))が発火してテスト実行を
 * 中断させかねないため、process.onceをスパイで差し替えて呼び出し回数のみを検証する
 * (実リスナーは登録しない)。
 */
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-core-shutdown-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

describe("core.ts の終了処理ハンドラ登録", () => {
  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("importしただけではハンドラ登録は発生せず、registerCoreShutdownHandlers()を呼んだ場合のみ登録され、多重呼び出しでは冪等", async () => {
    const onceSpy = vi.spyOn(process, "once").mockImplementation(() => process);

    const core = await import("../src/core.js");
    expect(onceSpy).not.toHaveBeenCalled();

    core.registerCoreShutdownHandlers();
    expect(onceSpy).toHaveBeenCalledTimes(3); // exit/SIGINT/SIGTERMの3件

    core.registerCoreShutdownHandlers();
    expect(onceSpy).toHaveBeenCalledTimes(3); // 冪等: 再度呼んでも増えない

    onceSpy.mockRestore();
    core.cache.close();
  });
});
