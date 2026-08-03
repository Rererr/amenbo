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

  it("全角の疑問符・感嘆符で終わる文も区切りとして数える", () => {
    const withFullWidth = scoreBlock({ text: "本当にそうでしょうか？ここに理由を三つ挙げてみます？", linkText: "" });
    const withoutPunctuation = scoreBlock({ text: "本当にそうでしょうかここに理由を三つ挙げてみます", linkText: "" });
    expect(withFullWidth.clauseBreaksPerWord).toBeGreaterThan(withoutPunctuation.clauseBreaksPerWord);
  });

  it("区切りだらけのブロックは語数を超える本文らしさボーナスを稼げない", () => {
    const result = scoreBlock({ text: "、、、、、、、、、、リンク", linkText: "" });
    expect(result.clauseBreaksPerWord).toBeLessThanOrEqual(1);
  });

  it("節番号・バージョン番号の中のピリオドは文の区切りとして数えない", () => {
    const tableOfContents = "1.1 議決機関と執行機関 1.2 歴史 1.3 首都機能 1.4 その他 2.1 地理 2.2 気候";
    expect(scoreBlock({ text: tableOfContents, linkText: "" }).clauseBreaksPerWord).toBe(0);
  });

  it("「年: 都市」形式のリンク一覧は、コロンを文の区切りとして数えないので低いスコアになる", () => {
    const text = "1964年: 東京 1968年: メキシコシティー 1972年: ミュンヘン 1976年: モントリオール 1980年: モスクワ";
    expect(scoreBlock({ text, linkText: text }).score).toBeLessThan(0);
  });
});

// 「同じ構造の本文なら、どの言語でも同じ判定境界で本文と認められる」ことが本スコアラーの仕様。
// 区切りの個数を文字数で割っていた頃は、1文字あたりの情報量が多いCJKの密度が構造的に高く出て、
// 同一構造でも日本語 0.66 / 英語 0.30 と境界が2倍以上ずれていた(実測)。
describe("scoreBlock の言語間公平性", () => {
  /** スコアが負転する linkDensity(本文と認められるリンク密度の上限)を二分探索で求める。 */
  function pruneThreshold(text: string): number {
    const chars = [...text];
    let low = 0;
    let high = chars.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (scoreBlock({ text, linkText: chars.slice(0, mid).join("") }).score < 0) high = mid;
      else low = mid + 1;
    }
    return Math.min(low / chars.length, 1);
  }

  // 同一内容・同一構造(4文、うち3文に読点、リンクは一部)の本文段落。
  const SAME_ARTICLE: Record<string, string> = {
    ja:
      "この都市は十九世紀の初めに、海沿いから移り住んだ人々によって開かれた。" +
      "その後の数十年で内陸の農村と港を結ぶ交易の要衝へと発展した。" +
      "現在も旧裁判所や中央市場など、当時の建物がいくつか残っている。" +
      "経済も文化も人口も、交易と農業と海運に支えられて急速に成長した。",
    en:
      "The city was founded in the early nineteenth century by settlers who arrived from the coast. " +
      "Over the following decades it grew into a trading hub that linked the inland farms to the ports. " +
      "Several buildings from that time still stand today, including the old courthouse and the market. " +
      "Its economy, culture and population grew rapidly, driven by trade, agriculture and shipping.",
    de:
      "Die Stadt wurde zu Beginn des neunzehnten Jahrhunderts von Siedlern gegründet, die von der Küste kamen. " +
      "In den folgenden Jahrzehnten wuchs sie zu einem Handelszentrum, das die Höfe mit den Häfen verband. " +
      "Mehrere Gebäude aus jener Zeit stehen noch heute, darunter das alte Gerichtsgebäude und der Markt. " +
      "Wirtschaft, Kultur und Bevölkerung wuchsen rasch, getragen von Handel, Landwirtschaft und Schifffahrt.",
    zh:
      "这座城市于十九世纪初由来自沿海地区的移民建立。" +
      "在随后的几十年里，它发展成为连接内陆农场与港口的贸易枢纽。" +
      "当年的一些建筑至今仍然保留着，其中包括旧法院和中央市场。" +
      "在贸易、农业与航运的带动下，经济、文化和人口都迅速增长。",
    ko:
      "이 도시는 십구 세기 초에 해안에서 이주해 온 사람들에 의해 세워졌다. " +
      "이후 수십 년 동안 내륙의 농장과 항구를 잇는 교역의 중심지로 성장했다. " +
      "당시의 건물 몇 채는 지금도 남아 있는데, 옛 법원과 중앙 시장이 그 예이다. " +
      "무역과 농업과 해운에 힘입어 경제와 문화와 인구가 모두 빠르게 늘어났다.",
  };

  it.each(Object.keys(SAME_ARTICLE))("%s の本文段落は、リンクが半分を占めていても本文と判定される", (lang) => {
    const text = SAME_ARTICLE[lang] ?? "";
    expect(pruneThreshold(text)).toBeGreaterThan(0.5);
  });

  it("同一内容の本文段落の判定境界は、言語をまたいでも1.6倍以内に収まる", () => {
    const thresholds = Object.values(SAME_ARTICLE).map(pruneThreshold);
    expect(Math.max(...thresholds) / Math.min(...thresholds)).toBeLessThan(1.6);
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

  // スコアリング対象タグ(SCORE_CANDIDATE_TAGS)はdiv/section/ul/olであり、article/pは対象外。
  // 本文をarticle/pで包むと、スコアラーの中身に関係なく除去されないため回帰検知にならない。
  it("リンクを一部含む英文の本文divは除去されない(非CJK回帰確認)", () => {
    const root = makeElement(`
      <div class="content">
        <p>The city was founded in the early <a href="/century">nineteenth century</a> by a group of settlers
        who arrived from the coast. Over the following decades it grew into a major trading hub, connecting
        the inland farms to the coastal ports. Today the <a href="/district">historic district</a> features
        several landmark buildings, including the <a href="/courthouse">old courthouse</a> and the central market.
        Its economy, culture, and population grew rapidly, driven by trade, agriculture, and coastal shipping.</p>
      </div>
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
