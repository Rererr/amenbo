import { describe, expect, it } from "vitest";
import { findAdapter, SITE_ADAPTERS } from "../src/adapters/index.js";

describe("findAdapter", () => {
  it("qiita.comにマッチする", () => {
    expect(findAdapter("qiita.com")?.name).toBe("qiita");
  });

  it("zenn.devにマッチする", () => {
    expect(findAdapter("zenn.dev")?.name).toBe("zenn");
  });

  it("note.comにマッチする", () => {
    expect(findAdapter("note.com")?.name).toBe("note");
  });

  it("*.hatenablog.comにマッチする", () => {
    expect(findAdapter("staff.hatenablog.com")?.name).toBe("hatenablog");
    expect(findAdapter("example.hateblo.jp")?.name).toBe("hatenablog");
  });

  it("news.yahoo.co.jpにマッチする", () => {
    expect(findAdapter("news.yahoo.co.jp")?.name).toBe("yahoo-news");
  });

  it("prtimes.jpにマッチする", () => {
    expect(findAdapter("prtimes.jp")?.name).toBe("prtimes");
  });

  it("ja/zh/ko.wikipedia.orgにマッチする(CJK一般化)", () => {
    expect(findAdapter("ja.wikipedia.org")?.name).toBe("wikipedia-cjk");
    expect(findAdapter("zh.wikipedia.org")?.name).toBe("wikipedia-cjk");
    expect(findAdapter("ko.wikipedia.org")?.name).toBe("wikipedia-cjk");
  });

  it("CJK外のwikipedia(例: en.wikipedia.org)は対象外(CJK限定)", () => {
    expect(findAdapter("en.wikipedia.org")).toBeNull();
    expect(findAdapter("de.wikipedia.org")).toBeNull();
  });

  it("サブドメイン無しの完全一致にもマッチする(境界を跨がない)", () => {
    expect(findAdapter("qiita.com")).not.toBeNull();
    expect(findAdapter("notqiita.com")).toBeNull();
    expect(findAdapter("qiita.com.evil.example")).toBeNull();
  });

  it("未知のホストはnullを返す", () => {
    expect(findAdapter("example.com")).toBeNull();
  });

  it("全アダプタがcontentSelectorsを1つ以上持つ", () => {
    for (const adapter of SITE_ADAPTERS) {
      expect(adapter.contentSelectors.length).toBeGreaterThan(0);
    }
  });
});
