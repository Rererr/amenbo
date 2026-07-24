# amenbo — Installation Guide for AI Agents

amenbo is a Japanese-web-native MCP server for low-impact, token-efficient web fetching. Tools: `fetch` / `links` / `screenshot`. Transport: stdio.

## Requirements

- Node.js >= 22.13.0

## Install

```bash
npm install -g amenbo
```

This is sufficient for Markdown fetching (`fetch` / `links`). Only if browser-based fetching is needed (SPA escalation, screenshots), additionally run:

```bash
npx -y amenbo install-browser
```

This downloads Chromium (~170MB) once. Skip it by default: when a page actually requires the browser, amenbo returns a clear error message containing this exact instruction.

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

### Other MCP clients

Register the command `amenbo` (no args) as a stdio server. To avoid a global install, use command `npx` with args `["-y", "amenbo"]` instead.

## Verify

Call the `fetch` tool with `{"url": "https://example.com/"}`. A successful setup returns the page as Markdown.

## Notes

- Fetch failures due to robots.txt denial or anti-bot measures are **by design** (amenbo implements no circumvention). Report them to the user as-is; they are not installation errors.
- HTTP proxy environments (`HTTP_PROXY` / `HTTPS_PROXY`) are not supported — see "Known limitations" in the README.
- After setup, load the usage conventions via the MCP prompt `usage` (in Claude Code: `/mcp__amenbo__usage`), or copy the recommended prompt from the README into the agent instructions (`CLAUDE.md` / `AGENTS.md`).
