import { rmSync } from "node:fs";

/**
 * テスト用一時キャッシュディレクトリ(AMENBO_CACHE_DIR)のベストエフォート削除。
 *
 * Windows CI対応: node:sqliteでDBファイルを開いたままrmSyncするとWindowsではファイル
 * ロックによりEPERM(Permission denied, syscall: 'rm')で失敗する(Linux/macOSは開いている
 * ファイルを含むディレクトリでも削除できるため気づきにくい)。closeCacheでシングルトンの
 * PageCacheを先に閉じることでハンドルを解放してから削除する。
 *
 * それでもタイミング依存で残りうるロックに備え、rmSync自体もtry/catchでベストエフォート化する。
 * 削除失敗はテスト本体のアサーションとは無関係(一時ディレクトリは最終的にOSが掃除する)なため、
 * ここで握りつぶしてもテストスイートの信頼性は損なわない(握りつぶすのはこの削除処理のみ)。
 */
export function cleanupCacheDir(dir: string, closeCache?: () => void): void {
  closeCache?.();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows等でのタイミング依存ロック残存に対するベストエフォート。無視してよい。
  }
}
