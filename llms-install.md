# amenbo — Installation Guide for AI Agents

amenbo is a Japanese-web-native MCP server for low-impact, token-efficient web fetching. Tools: `fetch` / `links` / `screenshot`. Transport: stdio.

## Requirements

- Node.js >= 22.13.0 (check with `node -v`; if it is older, stop and ask the user to update Node — do not replace Node yourself)

## Install

```bash
npm install -g amenbo
```

If this fails with a permission error, do not use `sudo`: stop and tell the user, and offer to register the server with `npx -y amenbo` instead (see "Other MCP clients").

This is sufficient for Markdown fetching (`fetch` / `links`). Browser-based fetching (SPA escalation, screenshots) uses the installed Google Chrome. Only if browser-based fetching is needed and Chrome is not installed, additionally run:

```bash
npx -y amenbo install-browser
```

This downloads Chromium once (about 300MB to download and about 570MB on disk, measured on macOS arm64; other environments differ). Tell the user about the download and get their confirmation before running it. Skip it by default: when a page actually requires the browser, amenbo returns a clear error message containing this exact instruction.

## Configure

### Cline

Add to `cline_mcp_settings.json` (MCP Servers → Configure MCP Servers):

```json
{
  "mcpServers": {
    "amenbo": {
      "command": "amenbo",
      "args": []
    }
  }
}
```

### Claude Code

```bash
claude mcp add --scope user amenbo -- amenbo
```

### Codex CLI

```bash
codex mcp add amenbo -- amenbo
```

### Other MCP clients

Register the command `amenbo` (no args) as a stdio server. To avoid a global install, use command `npx` with args `["-y", "amenbo"]` instead.

## Verify

Once the client recognizes the new server, call the `fetch` tool with `{"url": "https://example.com/"}`. A successful setup returns the page as Markdown. If the client needs a restart or an approval before it shows the server, walk the user through it (an agent cannot do that itself).

## Uninstall

```bash
claude mcp remove amenbo   # Claude Code
codex mcp remove amenbo    # Codex CLI
npm uninstall -g amenbo
```

For other clients, delete the `amenbo` entry from the client's MCP settings. Optional leftovers (delete by hand if wanted): the cache at `~/.cache/amenbo` (or `AMENBO_CACHE_DIR`), Chromium from `install-browser`: `chromium-*`, `chromium_headless_shell-*` and `ffmpeg-*` in Playwright's browser directory (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux, `%USERPROFILE%\AppData\Local\ms-playwright` on Windows by Playwright's default, not checked here; shared with other Playwright uses; deleting only `chromium-*` leaves about 200MB), the npx cache if registered as `npx -y amenbo` (`_npx` under `npm config get cache`), and the usage prompt pasted into `CLAUDE.md` / `AGENTS.md`.

## Notes

- Fetch failures due to robots.txt denial or anti-bot measures are **by design** (amenbo implements no circumvention). Report them to the user as-is; they are not installation errors. This includes Cloudflare / AWS WAF challenge pages (the error says "bot 対策の確認画面が返りました"). If the user explicitly asks for a robots.txt-denied page anyway, call again with `ask_robots_override: true`; amenbo then asks the user to confirm in the client UI. Never set it on your own. If amenbo says it has paused access to a site, or that the next request to a site can only be sent at a later time, do not retry before the time shown.
- `unchanged` / `diff` replies compare against amenbo's cache and appear only when this server process already returned the page's Markdown body, the 15-minute cache has expired, and the site resent the whole page; if the whole content was not read, refetch with `force_full: true`.
- Do not modify settings files or other files beyond what the steps above write (the global npm install, the entry in the MCP client's settings, Playwright's browser directory for `install-browser`).
- HTTP proxy environments (`HTTP_PROXY` / `HTTPS_PROXY`) are not supported — see "Known limitations" in the README.
- After setup, load the usage conventions via the MCP prompt `usage` (in Claude Code: `/mcp__amenbo__usage`), or copy the recommended prompt from the README into the agent instructions (`CLAUDE.md` / `AGENTS.md`).
