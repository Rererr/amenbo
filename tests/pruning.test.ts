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

describe("pruneLowValueBlocks のデータ表", () => {
  // devguide.python.orgの「Unsupported versions」の表(2026-11-12取得)の行と、Sphinxが出す
  // セルの間の改行。文の区切りが無く、日付と版番号と改行で文字の比率が下がるため、リンクの列が
  // 1つあるだけで囲みのdivと節が負のスコアになっていた。
  const versionRows = [
    ["3.10", "619", "2021-10-04", "2026-10-01", "Pablo Galindo Salgado"],
    ["3.9", "596", "2020-10-05", "2025-10-31", "Łukasz Langa"],
    ["3.8", "569", "2019-10-14", "2024-10-07", "Łukasz Langa"],
    ["3.7", "537", "2018-06-27", "2023-06-27", "Ned Deily"],
    ["3.6", "494", "2016-12-23", "2021-12-23", "Ned Deily"],
    ["3.5", "478", "2015-09-13", "2020-09-30", "Larry Hastings"],
    ["3.4", "429", "2014-03-16", "2019-03-18", "Larry Hastings"],
    ["3.3", "398", "2012-09-29", "2017-09-29", "Georg Brandl &amp; Ned Deily (3.3.7)"],
    ["3.2", "392", "2011-02-20", "2016-02-20", "Georg Brandl"],
    ["3.1", "375", "2009-06-27", "2012-04-09", "Benjamin Peterson"],
    ["3.0", "361", "2008-12-03", "2009-06-27", "Barry Warsaw"],
    ["2.7", "373", "2010-07-03", "2020-01-01", "Benjamin Peterson"],
    ["2.6", "361", "2008-10-01", "2013-10-29", "Barry Warsaw"],
  ]
    .map(
      ([branch, pep, first, end, manager]) =>
        `<tr><td><p>${branch}</p></td>\n<td><p><a href="/pep-0${pep}/"><strong>PEP ${pep}</strong></a></p></td>\n<td><p>end-of-life</p></td>\n<td><p>${first}</p></td>\n<td><p>${end}</p></td>\n<td><p>${manager}</p></td>\n</tr>\n`,
    )
    .join("");

  it("リンクの列を持つ版と日付の表は、囲みのdivと節ごと刈らない", () => {
    const root = makeElement(`
      <section id="unsupported-versions">
        <h2>Unsupported versions</h2>
        <div class="table-wrapper"><table><thead><tr><th><p>Branch</p></th>\n<th><p>Schedule</p></th>\n<th><p>Status</p></th>\n<th><p>First release</p></th>\n<th><p>End of life</p></th>\n<th><p>Release manager</p></th>\n</tr></thead>
        <tbody>${versionRows}</tbody></table></div>
      </section>
    `);
    expect(pruneLowValueBlocks(root)).toBe(0);
    expect(root.textContent).toContain("Unsupported versions");
    expect(root.textContent).toContain("Pablo Galindo Salgado");
  });

  it("空のセルは、文字を含むセルの割合に数えない", () => {
    // 空の列を2つ足すと、空のセルを数えた割合は45/112で過半を割る。数えなければ45/84。
    const rows = versionRows.replaceAll("</tr>", "<td></td><td><p></p></td></tr>");
    const head = "<thead><tr><th>Branch</th><th>Schedule</th><th>Status</th><th>First release</th><th>End of life</th><th>Release manager</th><th></th><th></th></tr></thead>";
    const root = makeElement(`<section><h2>Unsupported versions</h2><div class="table-wrapper"><table>${head}<tbody>${rows}</tbody></table></div></section>`);
    expect(pruneLowValueBlocks(root)).toBe(0);
  });

  it("リンクばかりの表を包むdivは刈る", () => {
    const links = Array.from({ length: 12 }, (_, i) => `<a href="/topic/${i}">関連する話題その${i}</a>`).join(" ");
    const root = makeElement(`
      <div class="navbox"><table><tr><th>関連項目</th><td>${links}</td></tr><tr><th>その他</th><td>${links}</td></tr></table></div>
      <p>本文の段落です。十分な長さの文章として認識されるように句読点を含めておきます。もう少し足します。</p>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("関連する話題");
    expect(root.textContent).toContain("本文の段落です");
  });

  it("数字だけのセルが並ぶ表(ブログのカレンダー)は、数字を文字として数えず、リンクも数えて刈る", () => {
    // WordPressのカレンダーのウィジェットの形。投稿のある日だけリンクになる。数字を文字として数えたり、値の表とみなして
    // リンクを数えなかったりすると、ウィジェットが刈られずに残り、表の救出で本文の末尾に足される。
    const days = Array.from({ length: 30 }, (_, i) => i + 1);
    const weeks = Array.from({ length: 5 }, (_, w) =>
      `<tr>${days.slice(w * 7, w * 7 + 7).map((d) => `<td>${[5, 12, 20].includes(d) ? `<a href="/2026/11/${d}/">${d}</a>` : d}</td>`).join("")}</tr>`,
    ).join("");
    const root = makeElement(`
      <div id="secondary"><section class="widget widget_calendar"><h2 class="widget-title">カレンダー</h2><div class="calendar_wrap">
        <table id="wp-calendar"><caption>2026年11月</caption><thead><tr><th>月</th><th>火</th><th>水</th><th>木</th><th>金</th><th>土</th><th>日</th></tr></thead>
        <tbody>${weeks}</tbody></table></div></section></div>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("2026年11月");
  });

  it("入れ子の表の数字・記号は一度だけ数える", () => {
    // 内側の表の日付を外側の表の分と二重に数えると、文字の比率が上がってスコアが-0.15から0.54になり、
    // リンクの見出しと日付だけの囲みが残る。
    const root = makeElement(
      `<div><p><a href="/a">Release notes</a></p><table><tr><td><table><tr><td>v1 2021-10-04 2026-10-01</td><td>v2 2020-01-01 2019-03-18</td></tr></table></td></tr></table></div>`,
    );
    expect(pruneLowValueBlocks(root)).toBe(1);
  });

  it("表の中のリンクでない数字・記号は文字として数え、リンクの中は数えない", () => {
    const table = { text: "3.10 2021-10-04 PEP 619", linkText: "PEP 619" };
    const withTable = scoreBlock({ text: table.text, linkText: table.linkText, table });
    // 文字は「PEP」の3字と、リンクの外の「3.10」「2021-10-04」の14字。リンクの中の「619」は数えない。
    expect(withTable.letterRatio).toBeCloseTo(17 / [...table.text].length);
    expect(scoreBlock({ text: table.text, linkText: table.linkText }).letterRatio).toBeCloseTo(3 / [...table.text].length);
  });

  it("表の外の数字・記号は文字として数えない", () => {
    const table = { text: "3.10 2021-10-04 PEP 619", linkText: "PEP 619" };
    const text = `1,234 views ${table.text}`;
    // 文字は「views」「PEP」の8字と、表の中のリンクの外の14字。表の外の「1,234」は数えない。
    expect(scoreBlock({ text, linkText: table.linkText, table }).letterRatio).toBeCloseTo(22 / [...text].length);
  });

  it("セルの中のページ送りを刈った後の形で、文字を含むセルが過半かを数える", () => {
    // 数字だけのリンクの並び(ページ送り)のdivは先に刈られて、空のセルになる。刈る前の形で数えると、文字を含むセルが
    // 過半に届かず、表の数字・記号が文字として数えられないので、表を包むdivごと刈られる。
    const pager = (row: number) => `<div class="pager">${Array.from({ length: 10 }, (_, i) => `<a href="/p${row}/${i + 1}">${i + 1}</a>`).join(" ")}</div>`;
    const rows = ["東京都", "神奈川県", "大阪府"]
      .map((name, i) => `<tr><td><a href="/w/${name}">${name}</a></td><td>${pager(i)}</td><td>1,234,567</td><td>1,234,567</td></tr>`)
      .join("");
    const root = makeElement(`<div class="table-box"><table><tr><th>名前</th><th>ページ</th><th>値</th><th>前年</th></tr>${rows}</table></div>`);
    expect(pruneLowValueBlocks(root)).toBe(3);
    expect(root.textContent).toContain("大阪府");
  });

  it("数字の多い表と、表の外の出典のリンクを包むブロックは刈らない", () => {
    // 表の中にリンクが無くても、表の外のリンクは数える。数字と単位で文字の比率が0.38まで下がるので、
    // 表の数字・記号を文字として数えないと、リンク密度0.09で負のスコアになる。
    const months = [["1月", "5.4℃", "59.7mm", "192.6時間"], ["2月", "6.1℃", "56.5mm", "170.4時間"], ["3月", "9.4℃", "116.0mm", "175.3時間"], ["4月", "14.3℃", "133.7mm", "178.8時間"], ["5月", "18.8℃", "139.7mm", "179.6時間"], ["6月", "21.9℃", "167.8mm", "124.0時間"]];
    const rows = months.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
    const root = makeElement(
      `<div class="table-box"><table><thead><tr><th>月</th><th>平均気温</th><th>降水量</th><th>日照時間</th></tr></thead><tbody>${rows}</tbody></table><p>出典: <a href="https://www.data.jma.go.jp/">気象庁 過去の気象データ検索</a></p></div>`,
    );
    expect(pruneLowValueBlocks(root)).toBe(0);
    expect(root.textContent).toContain("167.8mm");
  });

  // platform.claude.comの料金表(2026-11-12取得)のモデル名のセル。リンクの名前と句点の無い一言の説明で、
  // リンク密度0.23、スコア-0.33になり、セルの中のdivが刈られていた。
  const pricingRows = [
    ["fable-5-2", "Claude Fable 5.2", "For demanding reasoning and long-horizon agentic work", "$8", "$40"],
    ["opus-5-5", "Claude Opus 5.5", "For long-running agentic coding and knowledge work", "$4", "$20"],
    ["sonnet-5-5", "Claude Sonnet 5.5", "The best combination of speed and intelligence", "$2", "$10"],
  ]
    .map(
      ([id, name, caption, input, output]) =>
        `<tr><td><div><div class="flex"><div aria-hidden="true"><img alt=""></div><div class="flex-col"><a href="/docs/en/models/${id}/overview">${name}</a><span>${caption}</span></div></div></div></td><td>${input}<br>/ MTok</td><td>${output}<br>/ MTok</td></tr>`,
    )
    .join("");

  it("値の表のセルの、リンクの名前と句点の無い説明は刈らない", () => {
    const root = makeElement(
      `<div class="docs-table"><table><thead><tr><th>Model</th><th>Input</th><th>Output</th></tr></thead><tbody>${pricingRows}</tbody></table></div>`,
    );
    expect(pruneLowValueBlocks(root)).toBe(0);
    expect(root.textContent).toContain("Claude Fable 5.2");
    expect(root.textContent).toContain("The best combination of speed and intelligence");
  });

  it("名前の列がリンクの値の表を包むdivは刈らない", () => {
    // 料金表のバッチの表の形。全てのリンクを数えるとリンク密度0.34で、表の数字・記号を文字として数えてもスコア-0.88になる。
    const rows = [
      ["mythos-5-2", "Claude Mythos 5.2", "$4", "$20"],
      ["fable-5-1", "Claude Fable 5.1", "$5", "$25"],
      ["opus-5", "Claude Opus 5", "$2.50", "$12.50"],
    ]
      .map(([id, name, input, output]) => `<tr><td><a href="/docs/en/models/${id}/overview">${name}</a></td><td>${input} / MTok</td><td>${output} / MTok</td></tr>`)
      .join("");
    const root = makeElement(
      `<div class="docs-table"><table><thead><tr><th>Model</th><th>Batch input</th><th>Batch output</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    );
    expect(pruneLowValueBlocks(root)).toBe(0);
    expect(root.textContent).toContain("Claude Mythos 5.2");
  });

  it("表は中のリンク集を刈る前の形で判定し、navboxを値の表とみなさない", () => {
    // リストに入ったリンク集のセルが先に刈られると、残ったセルではリンクを含むセルが少数になる。
    const list = (prefectures: string[]) => `<ul>${prefectures.map((name) => `<li><a href="/wiki/${name}">${name}</a></li>`).join("")}</ul>`;
    const links = (prefectures: string[]) => prefectures.map((name) => `<a href="/wiki/${name}">${name}</a>`).join(" ");
    const root = makeElement(`
      <div class="navbox"><table>
        <tr><th>東北地方</th><td>${list(["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "新潟県"])}</td></tr>
        <tr><th>関東地方</th><td>${list(["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"])}</td></tr>
        <tr><th>中部地方</th><td>${links(["富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"])}</td></tr>
        <tr><th>近畿地方</th><td>${links(["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"])}</td></tr>
      </table></div>
      <p>本文の段落です。十分な長さの文章として認識されるように句読点を含めておきます。もう少し足します。</p>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("中部地方");
    expect(root.textContent).toContain("本文の段落です");
  });

  it("グループ名のセルとリンクを並べたセルが交互の表(navbox)は、区切りの文字がリンクの外にあっても刈る", () => {
    // navboxの行はグループ名とリンクの並びの2つのセルなので、リンクを含むセルがちょうど半数になる。
    // 区切りの「 · 」で、リンクの文字は表の文字の半分を下回る。
    const groups: [string, string[]][] = [
      ["東北地方", ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"]],
      ["関東地方", ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"]],
      ["中部地方", ["富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"]],
    ];
    const rows = groups.map(([group, names]) => `<tr><th>${group}</th><td>${names.map((name) => `<a href="/wiki/${name}">${name}</a>`).join(" · ")}</td></tr>`).join("");
    const root = makeElement(`
      <div class="navbox"><table>${rows}</table></div>
      <p>本文の段落です。十分な長さの文章として認識されるように句読点を含めておきます。もう少し足します。</p>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("中部地方");
  });

  it("空のセルは、リンクを含むセルの割合に数えない", () => {
    // 空のセルを数えると、リンクを含むセルが3/9で半数を割り、navboxが値の表に見える。数えなければ3/6。
    const groups: [string, string[]][] = [
      ["東北地方", ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"]],
      ["関東地方", ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"]],
      ["中部地方", ["富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"]],
    ];
    const rows = groups.map(([group, names]) => `<tr><th>${group}</th><td>${names.map((name) => `<a href="/wiki/${name}">${name}</a>`).join(" · ")}</td><td></td></tr>`).join("");
    const root = makeElement(`
      <div class="navbox"><table>${rows}</table></div>
      <p>本文の段落です。十分な長さの文章として認識されるように句読点を含めておきます。もう少し足します。</p>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("中部地方");
  });

  it("見出しの行があっても、リンクの文字が大半の表(サイドバーの最近の投稿)は刈る", () => {
    const titles = ["新しいキーボードを買った話", "週末の京都旅行の記録", "Rustで書き直した感想", "今年読んだ本のまとめ", "家庭菜園を始めました"];
    const rows = titles.map((title, i) => `<tr><td><a href="/p${i}">${title}</a></td><td>2026-10-${10 + i}</td></tr>`).join("");
    const root = makeElement(`
      <div class="widget"><table><tr><th>記事</th><th>日付</th></tr>${rows}</table></div>
      <p>本文の段落です。十分な長さの文章として認識されるように句読点を含めておきます。もう少し足します。</p>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("週末の京都旅行");
  });

  it("値の表のセルの中に入れ子にしたリンク集の表は、リンクを数えて刈る", () => {
    const related = ["関連する記事その一", "関連する記事その二", "関連する記事その三"].map((title, i) => `<td><a href="/r${i}">${title}</a></td>`).join("");
    const rows = [["東京都", "1,400万人"], ["神奈川県", "923万人"], ["大阪府", "877万人"], ["愛知県", "748万人"], ["埼玉県", "734万人"]]
      .map(([name, population]) => `<tr><td>${name}</td><td>${population}</td></tr>`)
      .join("");
    const root = makeElement(`
      <table><tr><th>都道府県</th><th>人口</th></tr>${rows}
        <tr><td>関連</td><td><div class="related"><table><tr>${related}</tr></table></div></td></tr>
      </table>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("関連する記事");
    expect(root.textContent).toContain("1,400万人");
  });

  it("見出しのセルの無いレイアウト用の表では、セルのリンク集を刈る", () => {
    const menu = ["トップページ", "会社概要", "製品情報", "導入事例", "よくある質問", "お問い合わせ"].map((label, i) => `<a href="/m${i}">${label}</a>`).join(" ");
    const root = makeElement(`
      <table><tr>
        <td><div class="menu">${menu}</div></td>
        <td><div>本文の段落です。十分な長さの文章として認識されるように、句読点を含めておきます。</div></td>
        <td>最終更新 2026年11月12日</td>
      </tr></table>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("会社概要");
    expect(root.textContent).toContain("本文の段落です");
  });

  it("見出しのセルを持つ表を入れ子にしたレイアウト用の表でも、セルのリンク集を刈る", () => {
    const menu = ["トップページ", "会社概要", "製品情報", "導入事例", "よくある質問", "お問い合わせ"].map((label, i) => `<a href="/m${i}">${label}</a>`).join(" ");
    const root = makeElement(`
      <table><tr>
        <td><div class="menu">${menu}</div></td>
        <td><div>本文の段落です。十分な長さの文章として認識されるように、句読点を含めておきます。</div>
          <table><tr><th>項目</th><th>値</th></tr><tr><td>人口</td><td>1,400万人</td></tr><tr><td>面積</td><td>2,194 km²</td></tr></table></td>
      </tr></table>
    `);
    expect(pruneLowValueBlocks(root)).toBe(1);
    expect(root.textContent).not.toContain("会社概要");
    expect(root.textContent).toContain("1,400万人");
  });
});
