/**
 * terminalRobotsConsent.ts — CLI で robots.txt が拒否したページを、端末で利用者が許可した1回に限り取得する。
 *
 * 許可は端末で人が y を打ったときだけ。--ask-robots-override は確認を出すきっかけにすぎない。
 * README はシェルを持つエージェントに CLI を勧めており、フラグだけで回避できると、エージェントが
 * 自分の判断で(あるいは取得先ページの指示で)付けて回避できてしまう(MCP 側の robotsConsent.ts と同じ理由)。
 */
import { createInterface } from "node:readline/promises";
import { type ConsentDecision, consentMessage, runAskingEachDeniedSite } from "./robotsConsent.js";

/** 端末で y/N を聞く。端末が無い(エージェントのシェル・パイプ)ときは聞けないので null を返す。 */
export type TerminalAsk = (message: string) => Promise<boolean | null>;

export const askOnTerminal: TerminalAsk = async (message) => {
  // 本文は stdout へ書く(リダイレクトされうる)ので、確認は stderr に出し stdin で受ける。
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(`${message} [y/N]: `);
    return /^y(es)?$/i.test(answer.trim());
  } catch (error) {
    // Ctrl-C / Ctrl-D は readline が AbortError で知らせる。答えずに抜けたのは許可していないということ。
    if (error instanceof Error && error.name === "AbortError") return false;
    throw error;
  } finally {
    readline.close();
  }
};

export async function runWithTerminalRobotsConsent<T>(askOverride: boolean, run: () => Promise<T>, ask: TerminalAsk = askOnTerminal): Promise<T> {
  if (!askOverride) return run();
  return runAskingEachDeniedSite(run, async (url): Promise<ConsentDecision> => {
    const allowed = await ask(consentMessage(url));
    if (allowed === null) return { refusedBecause: "端末で利用者に確認できないため、例外の取得はできません" };
    return allowed ? true : { refusedBecause: "利用者が例外の取得を許可しませんでした" };
  });
}
