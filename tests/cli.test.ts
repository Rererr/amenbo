import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// cli.tsはcore.tsをimportし、core.tsはモジュール読み込み時にPageCache(better-sqlite3)を
// 既定のキャッシュディレクトリ(~/.cache/amenbo)に生成する副作用を持つ。他のテストファイルと
// 同様、テスト用の一時ディレクトリへ退避させてからimportする(実ユーザーのキャッシュを汚さないため)。
// cli.ts側はisDirectlyExecutedガードによりrun()を直接実行時のみ走らせるため、importしてもハングしない。
const cacheDir = mkdtempSync(join(tmpdir(), "amenbo-cli-test-"));
process.env.AMENBO_CACHE_DIR = cacheDir;

const { CliUsageError, parseCliArgs } = await import("../src/cli.js");

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("parseCliArgs", () => {
  it("引数なしはserveと判定する(既存.mcp.jsonの`command: amenbo`との後方互換)", () => {
    expect(parseCliArgs([])).toEqual({ kind: "serve" });
  });

  it("serveサブコマンドを明示してもserveと判定する", () => {
    expect(parseCliArgs(["serve"])).toEqual({ kind: "serve" });
  });

  it("--versionはversionと判定する", () => {
    expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("--helpはhelpと判定する(トップレベル)", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("不明なコマンドはCliUsageErrorを投げる", () => {
    expect(() => parseCliArgs(["frobnicate"])).toThrow(CliUsageError);
  });

  describe("fetch", () => {
    it("URLのみを解析する", () => {
      expect(parseCliArgs(["fetch", "https://example.com/"])).toEqual({
        kind: "fetch",
        url: "https://example.com/",
      });
    });

    it("全オプションを解析する", () => {
      expect(
        parseCliArgs([
          "fetch",
          "https://example.com/",
          "--mode",
          "outline",
          "--selector",
          "main",
          "--section",
          "s1",
          "--page",
          "2",
          "--max-tokens",
          "4000",
          "--force-full",
          "--out-dir",
          "/tmp/out",
        ]),
      ).toEqual({
        kind: "fetch",
        url: "https://example.com/",
        mode: "outline",
        selector: "main",
        section: "s1",
        page: 2,
        maxTokens: 4000,
        forceFull: true,
        outDir: "/tmp/out",
      });
    });

    it("URL省略はCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["fetch"])).toThrow(CliUsageError);
    });

    it("不正なmodeはCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["fetch", "https://example.com/", "--mode", "bogus"])).toThrow(CliUsageError);
    });

    it("--pageに数値以外を渡すとCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["fetch", "https://example.com/", "--page", "abc"])).toThrow(CliUsageError);
    });

    it("--page/--max-tokensに0以下を渡すとCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["fetch", "https://example.com/", "--page", "0"])).toThrow(CliUsageError);
      expect(() => parseCliArgs(["fetch", "https://example.com/", "--max-tokens", "-1"])).toThrow(CliUsageError);
    });

    it("fetch --helpはhelp(topic: fetch)と判定する", () => {
      expect(parseCliArgs(["fetch", "--help"])).toEqual({ kind: "help", topic: "fetch" });
    });

    it("不明なオプションはCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["fetch", "https://example.com/", "--bogus-flag"])).toThrow(CliUsageError);
    });

    it("URLに続く余分な位置引数はCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["fetch", "https://example.com/", "https://example.org/"])).toThrow(CliUsageError);
    });
  });

  describe("links", () => {
    it("URLのみを解析する", () => {
      expect(parseCliArgs(["links", "https://example.com/"])).toEqual({
        kind: "links",
        url: "https://example.com/",
      });
    });

    it("--filterを解析する", () => {
      expect(parseCliArgs(["links", "https://example.com/", "--filter", "blog/*"])).toEqual({
        kind: "links",
        url: "https://example.com/",
        filter: "blog/*",
      });
    });

    it("links --helpはhelp(topic: links)と判定する", () => {
      expect(parseCliArgs(["links", "--help"])).toEqual({ kind: "help", topic: "links" });
    });

    it("URL省略はCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["links"])).toThrow(CliUsageError);
    });
  });

  describe("screenshot", () => {
    it("URLのみを解析する(fullPage既定なのでviewportOnlyは付与しない)", () => {
      expect(parseCliArgs(["screenshot", "https://example.com/"])).toEqual({
        kind: "screenshot",
        url: "https://example.com/",
      });
    });

    it("--viewport-onlyを解析する", () => {
      expect(parseCliArgs(["screenshot", "https://example.com/", "--viewport-only"])).toEqual({
        kind: "screenshot",
        url: "https://example.com/",
        viewportOnly: true,
      });
    });

    it("--width/--scale/--out-dirを解析する", () => {
      expect(
        parseCliArgs(["screenshot", "https://example.com/", "--width", "1024", "--scale", "0.5", "--out-dir", "/tmp/shots"]),
      ).toEqual({
        kind: "screenshot",
        url: "https://example.com/",
        width: 1024,
        scale: 0.5,
        outDir: "/tmp/shots",
      });
    });

    it("--scaleに0以下を渡すとCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["screenshot", "https://example.com/", "--scale", "0"])).toThrow(CliUsageError);
    });

    it("screenshot --helpはhelp(topic: screenshot)と判定する", () => {
      expect(parseCliArgs(["screenshot", "--help"])).toEqual({ kind: "help", topic: "screenshot" });
    });

    it("URL省略はCliUsageErrorを投げる", () => {
      expect(() => parseCliArgs(["screenshot"])).toThrow(CliUsageError);
    });
  });
});
