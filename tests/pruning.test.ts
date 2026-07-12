import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { pruneLowValueBlocks, scoreBlock, type PruneHostElement } from "../src/extract/pruning.js";

describe("scoreBlock(J4 本文スコアラー)", () => {
  it("句読点が多くリンクが少ない文章ブロックは高いスコアになる(本文らしい)", () => {
    const text =
      "これは十分な長さの日本語の文章です。句読点が多く含まれており、リンクはほとんど含まれていません。本文らしいブロックとして判定されるはずです。";
    const result = scoreBlock({ text, linkText: "" });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("リンクだらけで句読点の無いブロックは低いスコアになる(ナビらしい)", () => {
    const text = "ホーム会社概要お問い合わせプライバシーポリシーサイトマップ";
    const result = scoreBlock({ text, linkText: text });
    expect(result.score).toBeLessThan(0);
  });

  it("空文字列はスコア0", () => {
    const result = scoreBlock({ text: "", linkText: "" });
    expect(result.score).toBe(0);
  });

  it("linkDensityは1を超えない", () => {
    const result = scoreBlock({ text: "短い", linkText: "短いリンクテキストがそれより長い" });
    expect(result.linkDensity).toBeLessThanOrEqual(1);
  });

  it("リンクを一部含む英文の本文段落は高いスコアになる(本文らしい、非CJK回帰確認)", () => {
    const text =
      "The city was founded in the early nineteenth century by a group of settlers who arrived from the coast. " +
      "Over the following decades it grew into a major trading hub, connecting the inland farms to the coastal ports. " +
      "Today the historic district features several landmark buildings, including the old courthouse and the central market. " +
      "Its economy, culture, and population grew rapidly, driven by trade, agriculture, and coastal shipping.";
    const linkText = "nineteenth century historic district old courthouse";
    const result = scoreBlock({ text, linkText });
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("romaji・英字が混じった日本語ナビゲーションも低いスコアになる(LETTER_WEIGHT増加時の回帰検知)", () => {
    const text = "ホーム ABOUT US 会社概要 NEWS お問い合わせ PRIVACY POLICY サイトマップ";
    const result = scoreBlock({ text, linkText: text });
    expect(result.score).toBeLessThan(0);
  });

  it("句読点のほぼ無い英語のナビゲーションは低いスコアになる(ナビらしい、非CJK回帰確認)", () => {
    const text = "Home About Contact Privacy Policy Terms of Service Sitemap Careers Support";
    const result = scoreBlock({ text, linkText: text });
    expect(result.score).toBeLessThan(0);
  });
});

function makeElement(html: string): PruneHostElement {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return document.body as unknown as PruneHostElement;
}

describe("pruneLowValueBlocks(fit-pruning)", () => {
  it("nav/aside/footer/header/formは常に除去する", () => {
    const root = makeElement(`
      <nav>ホーム 会社概要</nav>
      <aside>広告枠</aside>
      <header>サイトヘッダー</header>
      <form>検索フォーム</form>
      <p>本文です。十分な長さの文章として認識されるように句読点を含めます。</p>
      <footer>コピーライト表記</footer>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBe(5); // nav/aside/header/form/footerの5要素
    expect(root.textContent).toContain("本文です");
    expect(root.textContent).not.toContain("広告枠");
    expect(root.textContent).not.toContain("コピーライト表記");
  });

  it("リンク密度が高く句読点の無いdiv(ランキング枠等)を除去する", () => {
    const root = makeElement(`
      <div class="ranking">
        <a href="/a">人気記事その一のタイトル文言</a>
        <a href="/b">人気記事その二のタイトル文言</a>
        <a href="/c">人気記事その三のタイトル文言</a>
      </div>
      <article>
        <p>これは本文の段落です。十分な長さがあり、句読点も多く含まれています。リンクはほとんどありません。もう少し文章を足します。</p>
      </article>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBeGreaterThanOrEqual(1);
    expect(root.textContent).not.toContain("人気記事その一");
    expect(root.textContent).toContain("これは本文の段落です");
  });

  it("リンクを一部含む英文の本文段落は除去されない(非CJK回帰確認)", () => {
    const root = makeElement(`
      <article>
        <p>The city was founded in the early <a href="/century">nineteenth century</a> by a group of settlers
        who arrived from the coast. Over the following decades it grew into a major trading hub, connecting
        the inland farms to the coastal ports. Today the <a href="/district">historic district</a> features
        several landmark buildings, including the <a href="/courthouse">old courthouse</a> and the central market.
        Its economy, culture, and population grew rapidly, driven by trade, agriculture, and coastal shipping.</p>
      </article>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBe(0);
    expect(root.textContent).toContain("historic district");
  });

  it("句読点のほぼ無い英語のナビゲーションdivは除去される(非CJK回帰確認)", () => {
    const root = makeElement(`
      <div class="nav-like">
        <a href="/home">Home</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/sitemap">Sitemap</a>
        <a href="/careers">Careers</a>
        <a href="/support">Support</a>
      </div>
      <p>This is the main body paragraph. It has enough length and proper sentences, with periods, to be
      recognized as body text rather than navigation.</p>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBeGreaterThanOrEqual(1);
    expect(root.textContent).not.toContain("Privacy Policy");
    expect(root.textContent).toContain("main body paragraph");
  });

  it("短いブロック(既定20文字未満)はスコアリング対象外で除去されない", () => {
    const root = makeElement(`<div><a href="/x">短い</a></div>`);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBe(0);
    expect(root.textContent).toContain("短い");
  });

  it("除去したブロックの子孫は再帰評価しない(除去済みの中身は数えない)", () => {
    const root = makeElement(`
      <nav>
        <ul><li><a href="/a">リンクA</a></li><li><a href="/b">リンクB</a></li></ul>
      </nav>
      <p>本文の段落です。十分な長さの文章として認識されるように句読点を含めておきます。</p>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBe(1); // navそのものが1回除去されるのみ
  });

  it("body全体を包む単一ラッパーdivは、内部のnav/footerのみ除去され本文が残る(バグ1回帰テスト)", () => {
    // 実サイト(mhlw.go.jp等)でよくある構成: <div class="wrapper">1個がheader/nav/本文/footerを
    // 丸ごと包む。トップダウン走査だとnav/footerのリンク密度に引きずられてラッパーdiv自体が
    // 「低価値ブロック」としてスコアされ、本文ごと1回で刈られてしまう回帰があった。
    // ボトムアップ(子孫を先に評価)であれば、nav/footerが個別に除去された後の
    // 「クリーンな」テキストでラッパーdiv自身が評価されるため本文が生き残るはず。
    const root = makeElement(`
      <div class="wrapper">
        <nav>
          <ul>
            <li><a href="/a">リンクAという名前のナビゲーション項目テキスト</a></li>
            <li><a href="/b">リンクBという名前のナビゲーション項目テキスト</a></li>
            <li><a href="/c">リンクCという名前のナビゲーション項目テキスト</a></li>
            <li><a href="/d">リンクDという名前のナビゲーション項目テキスト</a></li>
          </ul>
        </nav>
        <main>
          <p>本文です。十分な長さの日本語の文章として認識されるように句読点を含めておきます。</p>
        </main>
        <footer>
          <a href="/x">フッターリンクその一という長めのテキスト</a>
          <a href="/y">フッターリンクその二という長めのテキスト</a>
        </footer>
      </div>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBe(2); // nav・footerの2要素のみ(ラッパーdiv自体は除去されない)
    expect(root.textContent).toContain("本文です");
    expect(root.textContent).not.toContain("リンクAという名前");
    expect(root.textContent).not.toContain("フッターリンクその一");
  });

  it("ページレベル(article/section/main外)のheaderは従来通り除去される", () => {
    const root = makeElement(`
      <header>サイトヘッダー</header>
      <p>本文です。十分な長さの文章として認識されるように句読点を含めます。</p>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBe(1);
    expect(root.textContent).not.toContain("サイトヘッダー");
    expect(root.textContent).toContain("本文です");
  });

  it("記事内ネストのheader(記事タイトル+日付)は除去されずDOMに残る(WordPress/Ghost/Hugo系ブログ構成)", () => {
    const paragraph =
      "これは本文の段落です。十分な長さがあり、句読点も多く含まれています。".repeat(20);
    const root = makeElement(`
      <article>
        <header><h1>記事タイトル</h1><time>2026-07-01</time></header>
        <div class="content"><p>${paragraph}</p></div>
      </article>
    `);
    pruneLowValueBlocks(root);
    expect(root.textContent).toContain("記事タイトル");
    expect(root.textContent).toContain("2026-07-01");
    expect(root.textContent).toContain("これは本文の段落です");
  });

  it("親ごと丸ごと除去される場合、内部で先に個別除去された子孫は二重カウントしない", () => {
    // outerは内部のnavが除去された後もリンク偏重の断片テキストしか残らず、outer自体も
    // 低価値ブロックとして丸ごと除去される。この場合「navの個別除去」は既に除去される
    // outerの一部でしかないため、prunedCountは1(outerの除去1回分)のみを数えるべきで、
    // 2(nav+outer)にはならない。
    const root = makeElement(`
      <div class="outer">
        <nav>
          <ul>
            <li><a href="/a">サイト内ナビゲーションのリンクA長め</a></li>
            <li><a href="/b">サイト内ナビゲーションのリンクB長め</a></li>
          </ul>
        </nav>
        <a href="/stray">それでもまだ残る単独のリンクテキストという文言</a>
      </div>
      <p>本文の段落です。十分な長さの文章として認識されるように句読点を含めておきます。もう少し足します。</p>
    `);
    const prunedCount = pruneLowValueBlocks(root);
    expect(prunedCount).toBe(1); // outerの除去1回のみ(navの個別除去は二重カウントしない)
    expect(root.textContent).toContain("本文の段落です");
    expect(root.textContent).not.toContain("サイト内ナビゲーション");
    expect(root.textContent).not.toContain("それでもまだ残る単独");
  });
});
