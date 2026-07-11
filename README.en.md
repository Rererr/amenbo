# amenbo 🐜💧

English | [日本語](./README.md)

**Skims the web without making waves** — a Japanese-web-native MCP server for low-impact, token-efficient web collection.

amenbo (アメンボ / water strider) is an [MCP](https://modelcontextprotocol.io) server for coding agents such as Claude Code and Codex. Like the insect gliding across water without making ripples, it collects information from the web **with minimal load on target sites and minimal tokens** — optimized especially for **Japanese websites**. In shell environments without an MCP client, it also works as a CLI sharing the same core ([Using as a CLI](#using-as-a-cli)).

## Why amenbo

Most general-purpose scraping tools assume the English-speaking web. On Japanese sites they tend to miss content in the following ways — amenbo addresses each of them:

- **Loosely structured sites**: even on Japanese sites full of nested divs and table layouts, the main content area is inferred from rendered geometry (visual placement)
- **Mojibake**: automatic detection of Shift_JIS / EUC-JP / ISO-2022-JP
- **Furigana**: strips `<ruby>` reading annotations to prevent duplicated body text
- **Information rendered as images**: pages built around image-based pricing tables or banners automatically fall back to screenshots when text extraction is poor
- **Major Japanese sites**: dedicated adapters for Qiita / Zenn / note / Hatena Blog / Yahoo! News / PR TIMES / Japanese Wikipedia

For a measured comparison against similar tools (official fetch MCP / Jina Reader / Playwright MCP / PixelRAG pixelshot), see the article "[エージェントのWeb取得、ツール次第でトークンが5000倍違った話](https://zenn.dev/rererr_engineer/articles/e571e5b6eb1d53)" (Japanese). The benchmark harness and raw logs are in [`bench/`](./bench/).

## How it saves tokens

- **Progressive disclosure**: `mode: outline` first returns only the heading tree with a token estimate per section; fetch just the sections you need via `section`. Long pages are never dumped wholesale into context
- **CJK-aware content pruning**: removes nav / ads / footers using punctuation density, character-class ratios, and link density
- **Diff responses**: when refetching a URL, returns `unchanged` if nothing changed, or only the changed sections
- **Automatic Markdown/screenshot switching**: only pages with a low quality score become screenshots, avoiding the round trip of reading broken Markdown and refetching
- **CJK token estimation**: Japanese text costs more tokens per character than English, so page-split budgets are computed with per-character-class coefficients

## Low impact on target sites

- **Two-tier fetching**: plain HTTP GET first; only pages that need JS rendering escalate to headless Chromium, so most fetches never launch a browser
- **Polite crawling**: respects robots.txt and Crawl-Delay; serialized access per domain at 1 req/sec by default. Link discovery prefers sitemap / RSS instead of crawling pages
- **Honest User-Agent**: identifies itself as a bot. **No anti-bot circumvention is implemented**
- **Caching**: revalidates with ETag / If-Modified-Since to avoid needless refetches

## Installation

```bash
npm install -g amenbo
```

That's enough for plain Markdown fetching (`fetch` / `links`). If you also want browser-based fetching — SPA escalation or screenshots — run this once (a ~170MB download the first time):

```bash
npx -y amenbo install-browser
```

Or for development:

```bash
git clone https://github.com/Rererr/amenbo.git
cd amenbo
npm install
npm run build
```

### Registering with Claude Code

Add to `.mcp.json` (or your global config):

```json
{
  "mcpServers": {
    "amenbo": {
      "command": "amenbo"
    }
  }
}
```

For a local build, use `"command": "node", "args": ["/path/to/amenbo/dist/server.js"]`.

### Teaching your agent how to use it (recommended prompt)

Tool definitions alone don't convey usage conventions like "fetch with progressive disclosure." Paste the following into `CLAUDE.md` or `AGENTS.md` so your agent uses amenbo efficiently:

```markdown
## Use amenbo for web fetching

- Fetch pages with `fetch` (default mode `auto`). For pages that look long or where only part
  is needed, first check headings and per-section token counts with `mode: "outline"`,
  then fetch only the needed sections via `section`
- Getting `unchanged` / `diff` when refetching the same URL is normal (no change / changed
  sections only). Use `force_full: true` only when the full text is required
- When looking for pages within a site, don't guess URLs — enumerate them with `links`
  (narrow down with `filter`)
- In environments with a shell, for long pages you only want to keyword-search or for bulk
  collection of multiple pages, dump via the CLI with `amenbo fetch <url> > page.md` and
  grep / partially read it (keep the body text out of context).
  For pages where you want to judge while seeing the structure, MCP's outline → section flow fits better
- Works on non-Japanese sites too (progressive disclosure, caching, and low-impact fetching are
  language-independent). However, content extraction is tuned for Japanese, so if body text
  looks missing on a non-Japanese page, retry with a `selector` or `mode: "screenshot"`
- If visual information is the goal (pricing tables, layout), use `screenshot`.
  `scale: 0.5` or so reduces image tokens
- Fetch failures due to robots.txt denial or anti-bot measures are by design (no circumvention).
  Report failures to the user as-is
```

## Using as a CLI

`amenbo` also works as a CLI sharing the same core (fetching, cache, politeness, extraction logic) as the MCP server. Running it with no arguments, or as `amenbo serve`, starts the MCP server as before (`"command": "amenbo"` in `.mcp.json` keeps working), so existing MCP registrations are unaffected.

```bash
# Fetch a page as Markdown (to stdout)
amenbo fetch https://example.com/

# For long pages, check just the headings and token counts first
amenbo fetch https://example.com/ --mode outline

# Dump the output to a file for grep / partial reads (head/sed)
amenbo fetch https://example.com/ > page.md
grep -A3 "pricing" page.md

# Enumerate links within a site (sitemap/RSS-first)
amenbo links https://example.com/ --filter "blog/*"

# Screenshot (tiled PNGs are saved to --out-dir; their paths are listed on stdout)
amenbo screenshot https://example.com/ --viewport-only --scale 0.5 --out-dir ./shots
```

See `amenbo <fetch|links|screenshot> --help` for details on each subcommand.

**When to use MCP vs. CLI**:

- **MCP**: the primary path for agents. The browser (Chromium) stays warm within the process, and images such as screenshots can be returned directly into the conversation. Also reaches agents on hosts without a shell, like claude.ai
- **CLI**: suited to shell scripts, CI, debugging, dumping output to a file for `grep`/partial reads, or use from MCP-incapable agents/toolchains. One command = one process, so the browser launches each time

Cache, diff responses (`unchanged`/`diff`), and rate-control state (robots.txt / per-domain serialized access) are shared between the MCP server and the CLI (both use the same `~/.cache/amenbo`). Cross-process rate control is best-effort, however: per-domain serialization is strictly guaranteed only within each process, so when the MCP server and multiple CLI runs hit the same domain simultaneously, the minimum interval may occasionally be undershot.

## Tools

### `fetch` — fetch a page
| Parameter | Description |
|---|---|
| `url` | Target URL (http/https only; PDF supported) |
| `mode` | `auto` (default; switches Markdown/screenshot by quality score) / `markdown` / `outline` (heading summary) / `screenshot` |
| `selector` | CSS selector to narrow down the body content |
| `section` | Section ID obtained from outline; returns only that section's Markdown |
| `page` | Page number (default 1) |
| `max_tokens` | Approximate token cap per page (default 8000) |
| `force_full` | true disables diff responses and boilerplate removal, always returning the full text |

### `links` — enumerate links
| Parameter | Description |
|---|---|
| `url` | Starting URL |
| `filter` | Substring match on URL/link text, or a glob using `*` |

Discovery order: sitemap → RSS/Atom → in-page links.

### `screenshot` — capture a screenshot
| Parameter | Description |
|---|---|
| `url` | Target URL (http/https only) |
| `fullPage` | Default true. false captures only the first viewport |
| `width` | Tile width in px (default 1280) |
| `scale` | Resolution scale 0.5–1.0 (default 1.0). Smaller reduces image tokens |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AMENBO_CACHE_DIR` | `~/.cache/amenbo` | Where the cache (SQLite + PNG) is stored |
| `AMENBO_CACHE_TTL_MS` | `900000` (15 min) | Cache TTL |
| `AMENBO_MAX_BODY_BYTES` | `20971520` (20MB) | Maximum fetched body size |

## Security

- **SSRF protection**: rejects non-http/https schemes (`file:`, `ftp:`, etc.). Rejects DNS-resolved destinations that are private / loopback / link-local / reserved addresses. As a DNS rebinding (TOCTOU) countermeasure, actual connections are pinned to the validated IP
- **Body size cap**: prevents OOM from oversized responses

## Development

```bash
npm run typecheck   # strict type checking
npm test            # vitest
npm run build       # build into dist/
```

## License

[MIT](./LICENSE)
