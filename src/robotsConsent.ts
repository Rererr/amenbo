/**
 * robotsConsent.ts — robots.txt が拒否したページを、利用者本人が許可した1回に限り取得する。
 *
 * 許可を決めるのはクライアントの画面で利用者が答える elicitation だけで、ツール引数
 * (ask_robots_override)は確認を出すきっかけにすぎない。引数はLLMが書くため、引数で回避まで
 * できると、利用者が頼んでいない回避(エージェントの自己判断や取得先ページに仕込まれた指示)を防げない。
 *
 * 許可の範囲は、確認画面に出したページのオリジンに限る(politeness.runIgnoringRobotsFor)。
 * 許可の後で別オリジンの転送先が拒否されたら、その URL を示して改めて確認する(http→https や
 * www の付け外しも別オリジンなので、ここで黙って拒否すると利用者が何度許可しても先に進めない)。
 */
import { randomBytes } from "node:crypto";
import { CLIENT_CAPABILITIES_META_KEY, createRequestStateCodec, inputRequired } from "@modelcontextprotocol/server";
import type { ClientCapabilities, ElicitRequestFormParams, InputRequiredResult, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RobotsDeniedError } from "./errors.js";
import { runIgnoringRobotsFor } from "./politeness.js";

export type ProtocolEra = "legacy" | "modern";

const CONSENT_KEY = "robots_override";

/** 2025系の確認を待つ時間。SDK既定の60秒は、人が読んで判断する確認には短い。 */
const LEGACY_CONSENT_TIMEOUT_MS = 10 * 60_000;

/**
 * 許可は Accept を押すことそのもの。入力欄(「許可する」のチェックボックス等)を置くと、Claude Code は
 * 既定値のまま Accept を受け付け、利用者は許可したつもりでも拒否が返った(実測: accept と allow: false)。
 */
const acceptedAnswerSchema = z.object({ action: z.literal("accept") });

const REQUESTED_SCHEMA: ElicitRequestFormParams["requestedSchema"] = { type: "object", properties: {} };

/**
 * 2026-07-28 版で、確認画面に出したURLを再呼び出しまで運ぶ。requestStateはクライアントを経由して
 * 戻るため改ざん検知が要る(仕様のMUST)。stdioでは1プロセスがすべての往復を受けるので、鍵は起動ごとの乱数でよい。
 */
const consentStateSchema = z.object({
  toolUrl: z.string(),
  /** これまでに利用者が許可したページ。 */
  approvedUrls: z.array(z.string().url()),
  /** いま確認画面に出しているページ。 */
  askedUrl: z.string().url(),
});
type ConsentState = z.infer<typeof consentStateSchema>;

export const robotsConsentStateCodec = createRequestStateCodec<ConsentState>({
  key: randomBytes(32),
  bind: (ctx) => ctx.mcpReq.method,
});

/** MCP の確認フォームと CLI の端末確認で同じ文言を使う。 */
export function consentMessage(url: string): string {
  return (
    `robots.txt が自動取得を拒否しているページです: ${url}\n` +
    "この1回に限り、このサイトの robots.txt を無視して取得しますか(アクセス間隔の制御は維持します)。\n" +
    "許可しても、サイトの bot 対策で断られることがあります。"
  );
}

/**
 * robots.txt で拒否したうえで bot 対策もしている大手。確認を出しても、取りに行けば bot 対策で断られ、
 * 利用者の回線が目を付けられるだけなので、例外の取得の対象にしない。ホスト名がこれか、そのサブドメインなら該当する。
 */
export const BOT_PROTECTED_DOMAINS: readonly string[] = [
  "google.com",
  "google.co.jp",
  "amazon.com",
  "amazon.co.jp",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
];

function isBotProtected(url: string): boolean {
  const host = new URL(url).hostname.replace(/\.$/, "");
  return BOT_PROTECTED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function refuseIfBotProtected(url: string): void {
  if (isBotProtected(url)) {
    throw new RobotsDeniedError(url, "このサイトは bot 対策で自動取得を断っているため、例外の取得の対象外です");
  }
}

/**
 * 2026-07-28 版では Server.getClientCapabilities() が値を返さない(SDK 2.0.0 で実測。注記上は
 * リクエストごとに補われるはずだが undefined のまま)ため、リクエストの envelope から読む。
 */
function clientCapabilitiesOf(consent: RobotsConsentContext): unknown {
  if (consent.era === "modern") {
    // SDKの型定義ではenvelopeの中身が{}で、キーを型付きで引けない。値はクライアント由来なので下で検証する。
    const envelope: Record<string, unknown> = { ...consent.ctx.mcpReq.envelope };
    return envelope[CLIENT_CAPABILITIES_META_KEY];
  }
  return consent.legacyClientCapabilities;
}

const elicitationCapabilitySchema = z.object({
  elicitation: z.object({ form: z.unknown().optional(), url: z.unknown().optional() }),
});

/** 2025系のクライアントは form 対応を空オブジェクト({})で表す。url だけ宣言したクライアントは form を出せない。 */
function supportsFormElicitation(capabilities: unknown): boolean {
  const parsed = elicitationCapabilitySchema.safeParse(capabilities);
  if (!parsed.success) return false;
  const { form, url } = parsed.data.elicitation;
  return form !== undefined || url === undefined;
}

export interface RobotsConsentContext {
  ctx: ServerContext;
  era: ProtocolEra;
  /** 2025系の接続で initialize 時に宣言された能力。2026-07-28 版ではリクエストごとの envelope から読む。 */
  legacyClientCapabilities: ClientCapabilities | undefined;
  /** ツール引数 ask_robots_override。利用者が明示的に頼んだときだけLLMが付ける。 */
  askOverride: boolean;
  /** ツール引数のURL。 */
  url: string;
}

const REFUSED = "利用者が例外の取得を許可しませんでした";

/** 1回の呼び出しで確認するサイト(オリジン)の上限。http→https と www の付け外しを含む転送で足りる数。 */
export const MAX_APPROVED_ORIGINS = 3;

function tooManyApprovals(url: string): RobotsDeniedError {
  return new RobotsDeniedError(url, `転送先のサイトが多く、確認できる上限(${MAX_APPROVED_ORIGINS}サイト)を超えたため、例外の取得はできません`);
}

type Attempt<T> = { ok: true; value: T } | { ok: false; denied: RobotsDeniedError };

/** 許可済みのページのオリジンだけ robots.txt の拒否を外して run を実行し、拒否されたらその URL を返す。 */
async function attempt<T>(approvedUrls: readonly string[], run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: approvedUrls.length === 0 ? await run() : await runIgnoringRobotsFor(approvedUrls, run) };
  } catch (error) {
    if (error instanceof RobotsDeniedError) return { ok: false, denied: error };
    throw error;
  }
}

/** 確認の結果。許可なら true、それ以外は拒否の理由。 */
export type ConsentDecision = true | { refusedBecause: string };

/**
 * サーバーから確認を送って答えを待てる経路(2025系の MCP と CLI の端末)で、拒否された URL ごとに確認しながら
 * run をやり直す。許可は確認したページのオリジンに限り、拒否・取り消しは最終回答として出し直さない。
 */
export async function runAskingEachDeniedSite<T>(run: () => Promise<T>, ask: (url: string) => Promise<ConsentDecision>): Promise<T> {
  const approvedUrls: string[] = [];
  for (;;) {
    const result = await attempt(approvedUrls, run);
    if (result.ok) return result.value;
    const { url } = result.denied;
    if (approvedUrls.length >= MAX_APPROVED_ORIGINS) throw tooManyApprovals(url);
    refuseIfBotProtected(url);
    const decision = await ask(url);
    if (decision !== true) throw new RobotsDeniedError(url, decision.refusedBecause);
    approvedUrls.push(url);
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

/**
 * runを実行し、robots.txtの拒否で失敗したら、askOverride指定時に限り利用者へ確認する。
 *
 * 2026-07-28 版は確認を結果(input_required)として返し、クライアントが答えを付けて同じ呼び出しを
 * やり直す。許可済みのページは requestState で運ぶ。2025系はサーバーからクライアントへ確認を送って答えを待つ。
 * 拒否・取り消しは最終回答として扱い、確認を出し直さない(非対話のクライアントは自動で取り消しを返すため、
 * 出し直すと上限まで往復する)。
 */
export async function runWithRobotsConsent<T>(
  consent: RobotsConsentContext,
  run: () => Promise<T>,
): Promise<T | InputRequiredResult> {
  const { ctx, era, url } = consent;
  if (!consent.askOverride) return run();

  const ensureFormElicitation = (deniedUrl: string): void => {
    if (!supportsFormElicitation(clientCapabilitiesOf(consent))) {
      throw new RobotsDeniedError(deniedUrl, "このクライアントは利用者への確認(elicitation)に対応していないため、例外の取得はできません");
    }
  };

  if (era === "legacy") {
    return runAskingEachDeniedSite(run, async (deniedUrl) => {
      ensureFormElicitation(deniedUrl);
      let answer: Awaited<ReturnType<typeof ctx.mcpReq.elicitInput>>;
      try {
        answer = await ctx.mcpReq.elicitInput(
          { mode: "form", message: consentMessage(deniedUrl), requestedSchema: REQUESTED_SCHEMA },
          { timeout: LEGACY_CONSENT_TIMEOUT_MS, signal: ctx.mcpReq.signal },
        );
      } catch (elicitError) {
        return { refusedBecause: `利用者の回答を受け取れなかったため、例外の取得はできません: ${firstLine(elicitError)}` };
      }
      return acceptedAnswerSchema.safeParse(answer).success ? true : { refusedBecause: REFUSED };
    });
  }

  let approvedUrls: string[] = [];
  if (ctx.mcpReq.droppedInputResponseKeys?.includes(CONSENT_KEY)) {
    throw new RobotsDeniedError(url, "クライアントの回答の形式を読み取れなかったため、例外の取得はできません");
  }
  if (ctx.mcpReq.inputResponses?.[CONSENT_KEY] !== undefined) {
    const state = consentStateSchema.safeParse(ctx.mcpReq.requestState<unknown>());
    if (!state.success || state.data.toolUrl !== url) {
      throw new RobotsDeniedError(url, "確認した内容とこの呼び出しが一致しないため、例外の取得はできません");
    }
    if (!acceptedAnswerSchema.safeParse(ctx.mcpReq.inputResponses[CONSENT_KEY]).success) {
      throw new RobotsDeniedError(state.data.askedUrl, REFUSED);
    }
    approvedUrls = [...state.data.approvedUrls, state.data.askedUrl];
  }

  const result = await attempt(approvedUrls, run);
  if (result.ok) return result.value;
  const deniedUrl = result.denied.url;
  if (approvedUrls.length >= MAX_APPROVED_ORIGINS) throw tooManyApprovals(deniedUrl);
  refuseIfBotProtected(deniedUrl);
  ensureFormElicitation(deniedUrl);
  return inputRequired({
    inputRequests: { [CONSENT_KEY]: inputRequired.elicit({ message: consentMessage(deniedUrl), requestedSchema: REQUESTED_SCHEMA }) },
    requestState: await robotsConsentStateCodec.mint({ toolUrl: url, approvedUrls, askedUrl: deniedUrl }, ctx),
  });
}
