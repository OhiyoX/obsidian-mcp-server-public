---
name: connect-obsidian-mcp
description: Connect agents to this project's Dockerized Obsidian MCP server. Use when Codex or another agent needs to configure an MCP client, authenticate with the server API key, verify the Streamable HTTP endpoint, discover tools/resources/prompts, or troubleshoot access to the Obsidian vault MCP service.
---

# Connect Obsidian MCP

## Overview

Use this skill to connect an agent to the local Obsidian MCP server in this repository. The server exposes Streamable HTTP at `/mcp`, reads the mounted Obsidian vault directly, and supports optional API key authentication.

## Connection Facts

- Default MCP URL: `http://127.0.0.1:18923/mcp`
- Default health URL: `http://127.0.0.1:18923/healthz`
- Default service name: `obsidian-server`
- Docker container name: `obsidian-mcp-server`
- Transport: Streamable HTTP
- API key env var: `API_KEY`
- API key header: `X-API-Key` by default
- Bearer auth is also accepted: `Authorization: Bearer <key>`

Do not print or log the full API key. If you need to report auth state, say whether a key is configured, not what it is.

## Quick Workflow

1. From the repo root, inspect `.env` or compose config to determine `MCP_PORT`, `API_KEY`, `API_KEY_HEADER`, and `PROTECT_HEALTH`.
2. Check the server is running:

```sh
docker compose ps obsidian-server
curl -sS http://127.0.0.1:${MCP_PORT:-18923}/healthz
```

If `PROTECT_HEALTH=true`, include the API key header:

```sh
curl -sS -H "X-API-Key: $API_KEY" http://127.0.0.1:${MCP_PORT:-18923}/healthz
```

3. Configure the MCP client with Streamable HTTP. Use headers if `API_KEY` is set.
4. Verify the MCP protocol with `initialize`, then `tools/list`.

## MCP Client Configuration

Without API key:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://127.0.0.1:18923/mcp"
    }
  }
}
```

With API key, use the client-specific header mechanism. The intended headers are:

```json
{
  "X-API-Key": "<API_KEY>"
}
```

or:

```json
{
  "Authorization": "Bearer <API_KEY>"
}
```

## Curl Smoke Test

Initialize:

```sh
curl -sS -i -X POST "http://127.0.0.1:${MCP_PORT:-18923}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  ${API_KEY:+-H "X-API-Key: $API_KEY"} \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"obsidian-mcp-smoke-test","version":"1.0.0"}}}'
```

Copy the `mcp-session-id` response header, then notify initialized and list tools:

```sh
SESSION="<mcp-session-id>"

curl -sS -X POST "http://127.0.0.1:${MCP_PORT:-18923}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  ${API_KEY:+-H "X-API-Key: $API_KEY"} \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

curl -sS -X POST "http://127.0.0.1:${MCP_PORT:-18923}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  ${API_KEY:+-H "X-API-Key: $API_KEY"} \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Close the test session:

```sh
curl -sS -X DELETE "http://127.0.0.1:${MCP_PORT:-18923}/mcp" \
  -H "mcp-session-id: $SESSION" \
  ${API_KEY:+-H "X-API-Key: $API_KEY"}
```

## Common Tool Choices

- `server_info`: confirm vault path, data path, read-only mode, and available tools.
- `list_notes`: list Markdown notes and folders, optionally scoped with the vault-relative `pathPrefix` argument (`directory` is **not** a supported input).
- `list_files`: list all Obsidian-supported files, including `.canvas`, `.base`, media, and PDFs.
- `get_note`: read note content, full structure, document map, metadata, or a section.
- `get_metadata`: get best-effort Obsidian `CachedMetadata` shape.
- `search_notes`: search text, tags, and frontmatter.
- `write_note`, `append_to_note`, `patch_note`, `replace_in_note`: mutate Markdown notes.
- `get_canvas`, `write_canvas`: work with JSON Canvas files.
- `get_backlinks`, `get_graph`, `get_unresolved_links`, `get_orphans`, `get_deadends`: inspect indexed vault links.
- `list_tasks`, `update_task`, `daily_note`, `list_templates`, `create_from_template`: use core note workflows without the desktop app.
- `list_properties`, `list_aliases`, `rename_property`, `set_property_type`: inspect and manage structured note metadata.
- `list_bases`, `get_base`, `list_base_views`, `write_base`, `patch_base`, `query_base`: manage Bases files, list a Base's declared views, patch one Base line-surgically with a mandatory `ifMatch` revision (comments/unknown keys survive; `write_base` rewrites the whole document instead), and query the safe portable filter subset.
- `list_trash`, `restore_from_trash`, `delete_trash_entry`, `list_versions`, `restore_version`, `delete_version`: recover or explicitly clean deleted/overwritten content.

Read responses return SHA-256 `revision` values where applicable. Pass the latest revision as `ifMatch` for safe mutations; on a conflict, re-read before retrying.

Prefer read-only tools first. Use mutating tools only when the user explicitly asks to edit the vault or the current task clearly requires it.

## Directory Browsing With `list_notes`

Use the **advertised input schema** and the canonical `pathPrefix` argument to drill into a directory. Example native MCP tool call:

```json
{"name":"list_notes","arguments":{"pathPrefix":"_Workspace/40-Projects","recursive":false,"limit":100}}
```

- `pathPrefix` is Vault-relative; omitted or `""` selects the Vault root. **There is no `directory` input alias** in the current server tool schema. Previous versions of this skill incorrectly described it as a deprecated compatibility alias.
- `recursive` is false by default. Set `recursive:true` to descend; `depth` controls the recursion depth (0–20) and does not enable recursion on its own.
- `limit` (1–1000) caps one page. If `truncated:true`, pass the returned `nextCursor` as `cursor` with the same path and filters to continue; a short root listing is not a complete Vault inventory.
- `directory`, `path`, `dir`, `folder`, `subdir` and `relativePath` are **not** supported `list_notes` input names. Do not infer parameter support from a successful call: clients may strip unrecognized fields before handler execution.
- If browsing differs across machines, compare each deployment's `tools/list` schema and service version before recording a server regression. `search_notes` (`query` / `pathPrefix`) and `get_note` (full Vault-relative `path`) remain useful alternatives.

## Troubleshooting

- `401 Unauthorized`: include `X-API-Key` or `Authorization: Bearer` with the configured `API_KEY`.
- `400 Bad Request: initialize first`: send `initialize` before other MCP requests, or include the valid `mcp-session-id`.
- `404 Session not found`: create a new session with `initialize`.
- Health succeeds but MCP fails: check API key headers and `Accept: application/json, text/event-stream`.
- New `API_KEY` or port not applied: run `docker compose up -d --force-recreate`.
- JavaScript source changed but behavior did not update: production runs `node server.js` without a watcher. Follow `docs/RELEASE_AND_DEPLOY.md` to test, stage, and explicitly restart the service; then check `docker compose logs -f obsidian-server`.
