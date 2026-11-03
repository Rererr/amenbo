import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * runWithRobotsConsent(robots.txt が拒否したページを、利用者本人が許可した1回に限り取得する)の仕様。
 * runには本物のPolitenessManagerの判定を使う(robots.txtの応答だけ差し替える)。最初のURLは guard、
 * 転送先は robotsCheckForThisCall で確かめる(core.tsと同じ使い方)。
 */
const httpGetMock = vi.fn();

vi.mock("../src/fetcher/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/fetcher/http.js")>();
  return { ...actual, httpGet: (...args: Parameters<typeof actual.httpGet>) => httpGetMock(...args) };
});

const { PolitenessManager } = await import("../src/politeness.js");
const { RobotsDeniedError } = await import("../src/errors.js");
const { consentMessage, MAX_APPROVED_ORIGINS, robotsConsentStateCodec, runWithRobotsConsent } = await import("../src/robotsConsent.js");
type RobotsConsentContext = import("../src/robotsConsent.js").RobotsConsentContext;

const PAGE = "http://example.com/private/page";
const SAME_SITE_REDIRECT = "http://example.com/private/landing";
const OTHER_SITE_REDIRECT = "http://other.example.com/private/landing";
const FORM_CAPABLE = { elicitation: { form: {} } };

let politeness: InstanceType<typeof PolitenessManager>;
let runCount: number;

/** 取得の代役。PAGE を guard し、redirects を順に転送先として判定する。拒否されなければ"fetched"。 */
function fetchPage(...redirects: string[]): () => Promise<string> {
  return async () => {
    runCount++;
    await politeness.guard(PAGE);
    const checkRedirect = politeness.robotsCheckForThisCall();
    for (const redirect of redirects) await checkRedirect(redirect);
    return "fetched";
  };
}

/** 上限を超える数の別サイトへ順に転送される取得(各サイトの robots.txt は同じ応答で拒否する)。 */
const MANY_SITES = Array.from({ length: MAX_APPROVED_ORIGINS }, (_, i) => `http://site${i}.example.com/private/x`);

interface FakeCtxOptions {
  inputResponses?: Record<string, unknown>;
  droppedInputResponseKeys?: string[];
  requestState?: unknown;
  /** 2026-07-28 版のリクエストに付く envelope の能力宣言。省略時は確認フォーム対応、null で宣言なし。 */
  envelopeCapabilities?: Record<string, unknown> | null;
  elicit?: () => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
}

function makeConsent(era: "legacy" | "modern", overrides: Partial<Omit<RobotsConsentContext, "ctx">> = {}, ctxOptions: FakeCtxOptions = {}) {
  const elicitInput = vi.fn(ctxOptions.elicit ?? (async () => ({ action: "cancel" as const })));
  const envelopeCapabilities = ctxOptions.envelopeCapabilities === undefined ? FORM_CAPABLE : ctxOptions.envelopeCapabilities;
  const envelope = envelopeCapabilities === null ? {} : { "io.modelcontextprotocol/clientCapabilities": envelopeCapabilities };
  const signal = new AbortController().signal;
  const ctx = {
    mcpReq: {
      method: "tools/call",
      inputResponses: ctxOptions.inputResponses,
      droppedInputResponseKeys: ctxOptions.droppedInputResponseKeys,
      requestState: () => ctxOptions.requestState,
      elicitInput,
      envelope,
      signal,
    },
  } as unknown as RobotsConsentContext["ctx"];
  // 2026-07-28 版では接続時の能力が取れない(実測)ので、既定ではlegacy側だけに入れる。
  const consent: RobotsConsentContext = {
    ctx,
    era,
    legacyClientCapabilities: era === "legacy" ? FORM_CAPABLE : undefined,
    askOverride: true,
    url: PAGE,
    ...overrides,
  };
  return { consent, elicitInput, signal };
}

const accepted = { robots_override: { action: "accept" } };
/** 実測: 入力欄付きのフォームで Claude Code が返した Accept の回答。Accept は中身によらず許可として扱う。 */
const ACCEPT_OBSERVED_IN_CLAUDE_CODE = { action: "accept" as const, content: { allow: false } };
const firstRoundState = { toolUrl: PAGE, approvedUrls: [], askedUrl: PAGE };

beforeEach(() => {
  httpGetMock.mockReset().mockResolvedValue({
    finalUrl: "http://example.com/robots.txt",
    status: 200,
    headers: new Headers(),
    html: "User-agent: *\nDisallow: /private\n",
    encoding: "UTF-8",
  });
  politeness = new PolitenessManager({ sleep: async () => {} });
  runCount = 0;
});

describe("runWithRobotsConsent - 確認を出す条件", () => {
  it.each(["legacy", "modern"] as const)("%s: ask_robots_overrideが無ければ確認を出さず、拒否をそのまま返す", async (era) => {
    const { consent, elicitInput } = makeConsent(era, { askOverride: false });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(RobotsDeniedError);
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it.each(["legacy", "modern"] as const)("%s: robots.txtの拒否以外の失敗では確認を出さない", async (era) => {
    const { consent, elicitInput } = makeConsent(era);

    await expect(runWithRobotsConsent(consent, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it.each([
    ["elicitation未宣言", {}],
    ["URL方式だけ宣言", { elicitation: { url: {} } }],
  ])("クライアントが確認フォームに対応しない(%s)場合は、理由を添えて拒否する", async (_label, legacyClientCapabilities) => {
    const { consent, elicitInput } = makeConsent("legacy", { legacyClientCapabilities });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(/elicitation\)に対応していないため/);
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("2025系の空オブジェクト宣言(elicitation: {})は確認フォーム対応として扱う", async () => {
    const { consent, elicitInput } = makeConsent("legacy", { legacyClientCapabilities: { elicitation: {} } }, { elicit: async () => ({ action: "decline" }) });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(RobotsDeniedError);
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });
});

describe("runWithRobotsConsent - bot 対策をしている大手", () => {
  /** 取得の代役。url を guard する(robots.txt は /private を拒否する)。 */
  const fetchUrl = (url: string) => async () => {
    runCount++;
    await politeness.guard(url);
    return "fetched";
  };

  it.each([
    ["legacy", "https://www.google.com/private/search"],
    ["modern", "https://www.google.com/private/search"],
    ["legacy", "https://www.amazon.co.jp/private/x"],
    ["modern", "https://google.co.jp/private/x"],
    ["legacy", "https://www.google.com./private/x"],
  ] as const)("%s: %s は確認を出さず、対象外として拒否する", async (era, url) => {
    const { consent, elicitInput } = makeConsent(era, { url }, { elicit: async () => ({ action: "accept" }) });

    await expect(runWithRobotsConsent(consent, fetchUrl(url))).rejects.toThrow(/bot 対策で自動取得を断っているため、例外の取得の対象外です/);
    expect(elicitInput).not.toHaveBeenCalled();
    expect(runCount).toBe(1);
  });

  it("許可の後に、一覧のドメインへ転送されたら、そこで確認を出さずに拒否する", async () => {
    const run = async () => {
      runCount++;
      await politeness.guard(PAGE);
      await politeness.robotsCheckForThisCall()("https://accounts.google.com/private/login");
      return "fetched";
    };
    const { consent, elicitInput } = makeConsent("legacy", {}, { elicit: async () => ({ action: "accept" }) });

    await expect(runWithRobotsConsent(consent, run)).rejects.toThrow(/例外の取得の対象外です/);
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });

  it("名前の末尾が一致するだけの別ドメイン(notgoogle.com)は一覧に当たらず、確認を出す", async () => {
    const url = "https://notgoogle.com/private/x";
    const { consent, elicitInput } = makeConsent("legacy", { url }, { elicit: async () => ({ action: "decline" }) });

    await expect(runWithRobotsConsent(consent, fetchUrl(url))).rejects.toThrow(/利用者が例外の取得を許可しませんでした/);
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });

  it("確認の文言で、許可しても bot 対策で断られることがあると伝える", () => {
    expect(consentMessage(PAGE)).toContain("許可しても、サイトの bot 対策で断られることがあります");
  });
});

describe("runWithRobotsConsent - 2026-07-28版(確認を結果として返し、答えを付けた再呼び出しで決める)", () => {
  it("確認フォームには入力欄を置かない(Accept を押すこと自体を許可とし、既定値のまま Accept されて拒否になる形を作らない)", async () => {
    const { consent } = makeConsent("modern");

    const result = await runWithRobotsConsent(consent, fetchPage());
    expect(result).toMatchObject({ inputRequests: { robots_override: { params: { requestedSchema: { type: "object", properties: {} } } } } });
  });

  it("Accept の回答は中身によらず許可として扱う(実測した Claude Code の回答)", async () => {
    const { consent } = makeConsent("modern", {}, { inputResponses: { robots_override: ACCEPT_OBSERVED_IN_CLAUDE_CODE }, requestState: firstRoundState });

    await expect(runWithRobotsConsent(consent, fetchPage())).resolves.toBe("fetched");
  });

  it("拒否されたら、拒否されたURLを示す確認と、それを運ぶrequestStateを返す", async () => {
    const { consent } = makeConsent("modern");

    const result = await runWithRobotsConsent(consent, fetchPage());
    expect(result).toMatchObject({
      resultType: "input_required",
      inputRequests: { robots_override: { method: "elicitation/create", params: { message: expect.stringContaining(PAGE) } } },
      requestState: expect.any(String),
    });
  });

  it("能力はリクエストのenvelopeから読み、確認フォームに対応しないと宣言していれば理由を添えて拒否する", async () => {
    const { consent } = makeConsent("modern", {}, { envelopeCapabilities: null });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(/elicitation\)に対応していないため/);
  });

  it("許可が付いた再呼び出しでは、requestStateが示すページのオリジンだけ拒否を外して取得する", async () => {
    const { consent } = makeConsent("modern", {}, { inputResponses: accepted, requestState: firstRoundState });

    await expect(runWithRobotsConsent(consent, fetchPage(SAME_SITE_REDIRECT))).resolves.toBe("fetched");
  });

  it("許可後に別のサイトへの転送先が拒否されたら、その URL を示して改めて確認し、許可済みのページを運ぶ", async () => {
    const { consent } = makeConsent("modern", {}, { inputResponses: accepted, requestState: firstRoundState });

    const result = await runWithRobotsConsent(consent, fetchPage(OTHER_SITE_REDIRECT));
    expect(result).toMatchObject({
      resultType: "input_required",
      inputRequests: { robots_override: { params: { message: expect.stringContaining(OTHER_SITE_REDIRECT) } } },
    });
    const minted = (result as { requestState: string }).requestState;
    await expect(robotsConsentStateCodec.verify(minted, consent.ctx)).resolves.toEqual({ toolUrl: PAGE, approvedUrls: [PAGE], askedUrl: OTHER_SITE_REDIRECT });
  });

  it("2回目の確認でも許可されたら、許可した両方のサイトの拒否を外して取得する", async () => {
    const secondRoundState = { toolUrl: PAGE, approvedUrls: [PAGE], askedUrl: OTHER_SITE_REDIRECT };
    const { consent } = makeConsent("modern", {}, { inputResponses: accepted, requestState: secondRoundState });

    await expect(runWithRobotsConsent(consent, fetchPage(OTHER_SITE_REDIRECT))).resolves.toBe("fetched");
  });

  it(`確認したサイトが上限(${MAX_APPROVED_ORIGINS})に達した後にさらに拒否されたら、確認を出さずに拒否する`, async () => {
    // 上限ちょうどのサイトを許可した状態(PAGE と MANY_SITES の先頭 MAX-2 件が許可済みで、次の1件を確認中)。
    const state = { toolUrl: PAGE, approvedUrls: [PAGE, ...MANY_SITES.slice(0, MAX_APPROVED_ORIGINS - 2)], askedUrl: MANY_SITES[MAX_APPROVED_ORIGINS - 2] };
    const { consent } = makeConsent("modern", {}, { inputResponses: accepted, requestState: state });

    await expect(runWithRobotsConsent(consent, fetchPage(...MANY_SITES))).rejects.toThrow(/確認できる上限/);
  });

  it.each([
    ["requestStateが無い", undefined],
    ["別のページの呼び出しで作られたrequestState", { toolUrl: "http://example.com/another", approvedUrls: [], askedUrl: PAGE }],
    ["形の崩れたrequestState", { toolUrl: PAGE, approvedUrls: "x", askedUrl: PAGE }],
  ])("%s場合は、許可が付いていても取得しない", async (_label, requestState) => {
    const { consent } = makeConsent("modern", {}, { inputResponses: accepted, requestState });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(/確認した内容とこの呼び出しが一致しない/);
    expect(runCount).toBe(0);
  });

  it.each([
    ["拒否(decline)", { action: "decline" }],
    ["取り消し(cancel)", { action: "cancel" }],
    ["decline に allow: true が付いた回答", { action: "decline", content: { allow: true } }],
  ])("%sが付いた再呼び出しでは取得せず、確認も出し直さない", async (_label, answer) => {
    const { consent } = makeConsent("modern", {}, { inputResponses: { robots_override: answer }, requestState: firstRoundState });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(/利用者が例外の取得を許可しませんでした/);
    expect(runCount).toBe(0);
  });

  it("クライアントの回答の形式をSDKが読めずに捨てた場合は、確認を出し直さずに拒否する", async () => {
    const { consent } = makeConsent("modern", {}, { droppedInputResponseKeys: ["robots_override"] });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(/回答の形式を読み取れなかった/);
    expect(runCount).toBe(0);
  });
});

describe("runWithRobotsConsent - 2025系(サーバーからクライアントへ確認を送って待つ)", () => {
  it("拒否されたURLを示して確認し、許可されたらそのオリジンだけ拒否を外して取得し直す", async () => {
    const { consent, elicitInput } = makeConsent("legacy", {}, { elicit: async () => ({ action: "accept" }) });

    await expect(runWithRobotsConsent(consent, fetchPage(SAME_SITE_REDIRECT))).resolves.toBe("fetched");
    expect(elicitInput).toHaveBeenCalledWith(expect.objectContaining({ mode: "form", message: expect.stringContaining(PAGE) }), expect.anything());
    expect(runCount).toBe(2);
  });

  it("Accept の回答は中身によらず許可として扱い、確認フォームには入力欄を置かない", async () => {
    const { consent, elicitInput } = makeConsent("legacy", {}, { elicit: async () => ACCEPT_OBSERVED_IN_CLAUDE_CODE });

    await expect(runWithRobotsConsent(consent, fetchPage())).resolves.toBe("fetched");
    expect(elicitInput).toHaveBeenCalledWith(expect.objectContaining({ requestedSchema: { type: "object", properties: {} } }), expect.anything());
  });

  it("許可後に別のサイトへの転送先が拒否されたら、その URL を示して改めて確認し、許可されたら両方を外して取得する", async () => {
    const { consent, elicitInput } = makeConsent("legacy", {}, { elicit: async () => ({ action: "accept" }) });

    await expect(runWithRobotsConsent(consent, fetchPage(OTHER_SITE_REDIRECT))).resolves.toBe("fetched");
    const asked = elicitInput.mock.calls.map((call) => (call[0] as { message: string }).message);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(PAGE);
    expect(asked[1]).toContain(OTHER_SITE_REDIRECT);
  });

  it("2回目の確認で断られたら、その転送先の URL で拒否する", async () => {
    const answers = [{ action: "accept" as const }, { action: "decline" as const }];
    const { consent } = makeConsent("legacy", {}, { elicit: async () => answers.shift() ?? { action: "cancel" } });

    await expect(runWithRobotsConsent(consent, fetchPage(OTHER_SITE_REDIRECT))).rejects.toThrow(`${OTHER_SITE_REDIRECT} (利用者が例外の取得を許可しませんでした)`);
  });

  it(`確認したサイトが上限(${MAX_APPROVED_ORIGINS})に達した後にさらに拒否されたら、それ以上は確認せずに拒否する`, async () => {
    const { consent, elicitInput } = makeConsent("legacy", {}, { elicit: async () => ({ action: "accept" }) });

    await expect(runWithRobotsConsent(consent, fetchPage(...MANY_SITES))).rejects.toThrow(/確認できる上限/);
    expect(elicitInput).toHaveBeenCalledTimes(MAX_APPROVED_ORIGINS);
  });

  it("人が読んで判断する時間として、SDK既定(60秒)より長く待ち、ツール呼び出しの取り消しに連動させる", async () => {
    const { consent, elicitInput, signal } = makeConsent("legacy", {}, { elicit: async () => ({ action: "decline" }) });

    await runWithRobotsConsent(consent, fetchPage()).catch(() => undefined);
    const options = elicitInput.mock.calls[0]?.[1] as { timeout?: number; signal?: AbortSignal } | undefined;
    expect(options?.timeout).toBeGreaterThan(60_000);
    expect(options?.signal).toBe(signal);
  });

  it("回答を受け取れなかった(タイムアウト等)場合は、理由を添えた拒否にする", async () => {
    const { consent } = makeConsent("legacy", {}, { elicit: async () => Promise.reject(new Error("Request timed out")) });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(/利用者の回答を受け取れなかったため、例外の取得はできません: Request timed out/);
  });

  it.each([
    ["拒否(decline)", { action: "decline" as const }],
    ["取り消し(cancel)", { action: "cancel" as const }],
    ["decline に allow: true が付いた回答", { action: "decline" as const, content: { allow: true } }],
  ])("%sなら取得せず、確認は1回だけ", async (_label, answer) => {
    const { consent, elicitInput } = makeConsent("legacy", {}, { elicit: async () => answer });

    await expect(runWithRobotsConsent(consent, fetchPage())).rejects.toThrow(/利用者が例外の取得を許可しませんでした/);
    expect(elicitInput).toHaveBeenCalledTimes(1);
    expect(runCount).toBe(1);
  });
});
