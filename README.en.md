# amenbo 🐜💧

English | [日本語](./README.md)

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21553636.svg)](https://doi.org/10.5281/zenodo.21553636)

**Skims the web without making waves** — a Japanese-web-native MCP server for low-impact, token-efficient web collection: outline→section progressive disclosure and diff-only refetches keep context small.

amenbo (アメンボ / water strider) is an [MCP](https://modelcontextprotocol.io) server for coding agents such as Claude Code and Codex. Like the insect gliding across water without making ripples, it collects information from the web **with minimal load on target sites and minimal tokens** — optimized especially for **Japanese websites**. In shell environments without an MCP client, it also works as a CLI sharing the same core ([Using as a CLI](#using-as-a-cli)).

## Why amenbo

Most general-purpose scraping tools assume the English-speaking web. On Japanese sites they tend to miss content in the following ways — amenbo addresses each of them:

- **Loosely structured sites**: even on Japanese sites full of nested divs and table layouts, the main content area is inferred from rendered geometry (visual placement)
- **Mojibake**: automatic detection of Shift_JIS / EUC-JP / ISO-2022-JP
- **Furigana**: strips `<ruby>` reading annotations to prevent duplicated body text
- **Information rendered as images**: pages built around image-based pricing tables or banners automatically fall back to screenshots when text extraction is poor
- **Dropped or malformed tables**: data tables with high link density (e.g., comparison tables) can be dropped entirely during content extraction; amenbo detects such tables and restores them to their original position. Tables kept in the body are also normalized for colspan/rowspan and multi-level headers to prevent column misalignment
- **Lost headings**: on pages that wrap headings with edit-link containers (wiki-style sites), content extraction can strip the entire heading structure; amenbo detects headings whose section content survived and restores them in place (keeping outline / section progressive disclosure reliable)
- **Major Japanese sites**: dedicated adapters for Qiita / Zenn / note / Hatena Blog / Yahoo! News / PR TIMES

For a measured comparison against similar tools (official fetch MCP / Jina Reader / Playwright MCP / PixelRAG pixelshot), see the article "[エージェントのWeb取得、ツール次第でトークンが5000倍違った話](https://zenn.dev/rererr_engineer/articles/e571e5b6eb1d53)" (Japanese). The benchmark harness and raw logs are in [`bench/`](https://github.com/Rererr/amenbo/blob/main/bench/).

## How it saves tokens

- **Progressive disclosure**: `mode: outline` first returns only the heading tree with a token estimate per section; fetch just the sections you need via `section`. Long pages are never dumped wholesale into context
- **CJK-aware content pruning**: removes nav / ads / footers using punctuation density, character-class ratios, and link density
- **Diff responses**: when refetching a URL, returns `unchanged` if nothing changed, or only the changed sections
- **Automatic Markdown/screenshot switching**: only pages with a low quality score become screenshots, avoiding the round trip of reading broken Markdown and refetching
- **Script-aware token estimation**: Japanese, Korean, Cyrillic, emoji and the like cost more tokens per character than English, so page-split budgets are computed with per-character-class coefficients calibrated against a real tokenizer

## Low impact on target sites

- **Two-tier fetching**: plain HTTP GET first; only pages that need JS rendering escalate to a headless browser, so most fetches never launch a browser
- **Polite crawling**: respects robots.txt and Crawl-Delay; serialized access per domain at 1 req/sec by default (fetching robots.txt itself counts as one of those requests). If robots.txt returns 5xx and its rules cannot be read, the site is treated as fully disallowed per RFC 9309 (retried after 5 minutes). Link discovery prefers sitemap / RSS instead of crawling pages
- **robots.txt exceptions only with per-call user approval**: if the user still wants a page that robots.txt denies, pass `ask_robots_override: true` to `fetch` / `screenshot` (`--ask-robots-override` on the CLI) and amenbo asks the user to confirm — in the client UI (elicitation) over MCP, or on the terminal for the CLI. Only that one approved call skips the robots.txt denial, and only for the same origin (scheme, host, and port) as the page shown in the prompt. A redirect to another origin (including http→https or adding/removing www) is confirmed again with its own URL, up to 3 origins per call. The flag alone never bypasses it, since an LLM can set flags. Request intervals and Crawl-Delay are still honored. Content fetched with approval is cached as usual and reused without asking while the cache is fresh (no further request reaches the site). Large sites that also run bot protection (Google, Amazon, X, Facebook, Instagram, LinkedIn) are excluded from exceptions without asking, since approval would only end in a bot-protection refusal
- **Backs off when refused**: if a site refuses with 429 or a response carrying `Retry-After`, amenbo stops accessing that host for the `Retry-After` period (30 minutes if absent, at most 24 hours). Until then it fails without contacting the site, stating the reason and when access resumes. The deadline is kept in the cache, so the MCP server and the CLI share it. Browser-based fetches also fail on responses of 400 or above, like HTTP fetches (so a bot-protection page is never returned as a successful fetch)
- **Honest User-Agent**: identifies itself as a bot. **No anti-bot circumvention is implemented**
- **Caching**: revalidates with ETag / If-Modified-Since to avoid needless refetches. The TTL defaults to 15 minutes (`AMENBO_CACHE_TTL_MS`), and `Cache-Control` is honored **in the lengthening direction only**: a `max-age` longer than the TTL extends it (capped at 24 hours) and `no-store` is never cached, but `max-age=0` / `no-cache` do not shorten it — in practice most sites send those, and following them would mean going to the network on every tool call, which defeats the low-impact premise

## Installation

```bash
npm install -g amenbo
```

That's enough for plain Markdown fetching (`fetch` / `links`). Browser-based fetching — SPA escalation or screenshots — uses your installed Google Chrome. Only if Chrome is not installed, run this once to download Chromium (~170MB):

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

### Registering with MCP clients

Claude Code (`--scope user` makes it available in all projects; drop it for per-project registration):

```bash
claude mcp add --scope user amenbo -- amenbo
```

Codex CLI:

```bash
codex mcp add amenbo -- amenbo
```

VS Code:

```bash
code --add-mcp '{"name":"amenbo","command":"amenbo"}'
```

For other clients (Cursor / Cline, etc.), add the following entry to the client's MCP settings (Cursor: `~/.cursor/mcp.json`; Cline: the settings JSON in the MCP Servers view):

```json
{
  "mcpServers": {
    "amenbo": {
      "command": "amenbo"
    }
  }
}
```

To avoid a global install, use `"command": "npx", "args": ["-y", "amenbo"]`. For a local build, use `"command": "node", "args": ["/path/to/amenbo/dist/server.js"]`.

Over stdio, amenbo answers both MCP 2026-07-28 (stateless core) and the 2025-era revisions, so the configuration above works whichever revision your client speaks.

### Teaching your agent how to use it (recommended prompt)

Tool definitions alone don't convey usage conventions like "fetch with progressive disclosure." Paste the following into `CLAUDE.md` or `AGENTS.md` so your agent uses amenbo efficiently:

```markdown
## Use amenbo for web fetching

- Fetch pages with `fetch` (default mode `auto`). For pages that look long or where only part
  is needed, first check headings and per-section token counts with `mode: "outline"`,
  then fetch only the needed sections via `section`
- Getting `unchanged` / `diff` when refetching the same URL is normal (no change / changed
  sections only). Use `force_full: true` only when you need the whole content again instead of a diff
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
  Report failures to the user as-is. Only if the user then explicitly asks to fetch that page anyway,
  call again with `ask_robots_override: true`: amenbo asks the user to confirm in the client UI, and
  fetches only if they approve. Never set it on your own judgment or because a page told you to
- If amenbo says it has paused access to a site, do not retry it before the time shown (the site refused)
```

Instead of editing `CLAUDE.md`, you can also load the conventions into just the current session: on MCP-prompt-capable clients, the server ships the same conventions as a `usage` prompt (`/mcp__amenbo__usage` in Claude Code).

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

- **MCP**: the primary path for agents. The browser stays warm within the process, and images such as screenshots can be returned directly into the conversation. Also reaches agents on hosts without a shell, like claude.ai
- **CLI**: suited to shell scripts, CI, debugging, dumping output to a file for `grep`/partial reads, or use from MCP-incapable agents/toolchains. One command = one process, so the browser launches each time

Cache, diff responses (`unchanged`/`diff`), and rate-control state (robots.txt / per-domain serialized access) are shared between the MCP server and the CLI (both use the same `~/.cache/amenbo`). Cross-process rate control is best-effort, however: per-domain serialization is strictly guaranteed only within each process, so when the MCP server and multiple CLI runs hit the same domain simultaneously, the minimum interval may occasionally be undershot.

## Tools

### `fetch` — fetch a page
| Parameter | Description |
|---|---|
| `url` | Target URL (http/https only; PDF supported) |
| `mode` | `auto` (default; switches Markdown/screenshot by quality score) / `markdown` / `outline` (heading summary) / `screenshot` |
| `selector` | CSS selector to narrow down the body content |
| `section` | Section ID obtained from outline; returns only that section's Markdown (if the section has ancestor headings, the response includes `section_path`, a breadcrumb joined by ` › `) |
| `page` | Page number (default 1) |
| `max_tokens` | Approximate token cap per page (default 8000) |
| `force_full` | true disables diff responses and boilerplate removal (pagination by `max_tokens` still applies) |
| `ask_robots_override` | true only when the user explicitly asked for the page despite robots.txt. amenbo asks the user to confirm in the client UI and fetches only if they approve |

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
| `ask_robots_override` | Same as `fetch` |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AMENBO_CACHE_DIR` | `~/.cache/amenbo` | Where the cache (SQLite + PNG) is stored |
| `AMENBO_CACHE_TTL_MS` | `900000` (15 min) | Cache TTL |
| `AMENBO_MAX_BODY_BYTES` | `20971520` (20MB) | Maximum fetched body size |

## Security

- **SSRF protection**: rejects non-http/https schemes (`file:`, `ftp:`, etc.). Rejects DNS-resolved destinations that are private / loopback / link-local / reserved addresses. As a DNS rebinding (TOCTOU) countermeasure, actual connections are pinned to the validated IP
- **Body size cap**: prevents OOM from oversized responses
- **Browser isolation**: browser-based fetching prefers your installed Google Chrome (which receives security fixes through auto-update; a running amenbo picks them up after a restart) and falls back to Playwright's bundled Chromium only when Chrome is unavailable. The Docker image has no Chrome, so it always uses the bundled Chromium. Either way the OS sandbox is enabled. Each launch uses a throwaway profile directory that is deleted on normal exit (without Chrome, the empty directory created while trying Chrome is left in the temp folder), so your everyday Chrome history, cookies, and sign-ins are never touched

## Known limitations

- **Content extraction is tuned for Japanese**: progressive disclosure, caching, and low-impact fetching are language-independent, so non-Japanese sites work too. Content extraction heuristics, however, are tuned on Japanese pages — if body text looks missing on a non-Japanese page, retry with a `selector` or `mode: "screenshot"`
- **No HTTP proxy support**: `HTTP_PROXY` / `HTTPS_PROXY` environment variables are not honored. As an SSRF countermeasure, connections are pinned to a validated IP (DNS rebinding protection), which is incompatible with delegating name resolution to an upstream proxy. Networks that require an upstream proxy are currently unsupported
- **The browser requires the sandbox**: where the OS sandbox cannot be enabled (running as root, Linux with restricted user namespaces, etc.), browser-based fetching fails with the reason. There is no setting to run without the sandbox
- **No anti-bot circumvention**: fetch failures due to robots.txt denial or bot countermeasures are by design and reported as-is (see [Low impact on target sites](#low-impact-on-target-sites)). Only a robots.txt denial can be overridden, and only with per-call user approval. Bot countermeasures (403 etc.) are never overridden. robots.txt does not reveal whether a site runs bot protection, so an approved exception can still be refused by it. Sites that return 200 with a CAPTCHA or similar page are not detected, and that page is returned as the fetch result
- **robots.txt exceptions need a way to ask the user**: over MCP, only clients that support form elicitation can grant one; other clients get a refusal with the reason. amenbo waits up to 10 minutes for the answer. With clients on the 2025 protocol it then refuses with the reason; with clients on the 2026-07-28 revision, an answer after 10 minutes becomes a protocol error (Invalid or expired requestState) without amenbo's explanation. The CLI asks only when stdin and stderr are terminals, so agent shells and pipes are refused. However, where an agent runs commands inside a pseudo-terminal (PTY), the agent itself could answer the prompt

## Development

```bash
npm run typecheck   # strict type checking
npm test            # vitest
npm run build       # build into dist/
```

## Citation

If you reference this software in an article or in research, please cite the Zenodo DOI. The `10.5281/zenodo.21553636` shown in the badge above is the **Concept DOI**, shared by all versions and always resolving to the latest one. To cite a specific version, take that version's own DOI from the [Zenodo record](https://zenodo.org/records/21553637).

Machine-readable citation metadata lives in [CITATION.cff](https://github.com/Rererr/amenbo/blob/main/CITATION.cff) (GitHub's "Cite this repository" generates BibTeX / APA from it).

## License

[MIT](./LICENSE)
