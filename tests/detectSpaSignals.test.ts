import { describe, expect, it } from "vitest";
import { detectSpaSignals } from "../src/fetcher/index.js";

describe("detectSpaSignals(SPA判定ヒューリスティック)", () => {
  it("SPAルートが空 + 200字超のnoscriptテキストを持つHTMLでescalate:true(SPAルート自体が空のため)", () => {
    const noscriptText = "続きを読むには専用アプリのインストールが必要です。詳細は下記リンクからご確認ください。".repeat(5);
    expect([...noscriptText].length).toBeGreaterThan(200);
    const html = `<html><body><div id="root"></div><noscript>${noscriptText}</noscript></body></html>`;

    const result = detectSpaSignals(html);
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe("SPAルートコンテナ(#root)が空です");
  });

  it("noscript内に「JavaScriptを有効にしてください」がある場合、escalate:trueかつ理由がnoscript警告になる", () => {
    const html = `<html><body><main>本文コンテンツ</main><noscript>JavaScriptを有効にしてください</noscript></body></html>`;

    const result = detectSpaSignals(html);
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe("noscriptにJavaScript要求の警告があります");
  });

  it("SPAルートIDも無く、JS要求語も無い長文noscript(GTM等のフォールバック注記)が可視テキスト量を水増ししていた場合でも、noscript除去後の可視テキストが閾値未満ならescalate:trueになる(除去前は誤って昇格をスキップしていた回帰の直接確認)", () => {
    // SPA_ROOT_IDSに一致する要素は置かず、noscript除去の効果そのものだけを検証する。
    // noscriptの分だけhtml文字列は2000字を超えるが、本文側(noscript以外)はほぼ空。
    const noscriptText = "このページはJavaScriptを使用しない環境向けの代替コンテンツです。".repeat(60);
    const html = `<html><body><div class="content"></div><noscript>${noscriptText}</noscript></body></html>`;
    expect(html.length).toBeGreaterThan(2000);

    const result = detectSpaSignals(html);
    expect(result.escalate).toBe(true);
  });

  it("十分な可視本文があり、SPAシグナルもnoscript警告も無ければescalate:falseになる", () => {
    const body = "これは十分な長さの本文です。句読点を含む通常の記事本文として認識されます。".repeat(5);
    const html = `<html><body><main>${body}</main></body></html>`;

    const result = detectSpaSignals(html);
    expect(result.escalate).toBe(false);
    expect(result.reason).toBeNull();
  });
});
