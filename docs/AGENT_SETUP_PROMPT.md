# Agent Setup Prompt

Copy the prompt below into another coding agent when you want it to configure and verify this Obsidian MCP server.

```text
You are helping me connect to my local Obsidian MCP server.

Project root:
<project-root>

Use the project-local skill if your environment supports skills:
<project-root>/skills/connect-obsidian-mcp

Goal:
Configure your MCP client to use this server, then verify it with a protocol smoke test.

Connection facts:
- MCP transport: Streamable HTTP
- Default MCP URL: http://127.0.0.1:18923/mcp
- Default health URL: http://127.0.0.1:18923/healthz
- Docker compose service: obsidian-server
- Docker container: obsidian-mcp-server
- API key env var: API_KEY
- API key header: X-API-Key by default
- Bearer auth is also accepted: Authorization: Bearer <API_KEY>
- Do not use MCP_API_TOKEN or X-MCP-Token. Legacy auth names are not supported.

Instructions:
1. Read <project-root>/.env if it exists, otherwise read .env.example.
2. Determine MCP_PORT, API_KEY, API_KEY_HEADER, and PROTECT_HEALTH.
3. Do not print, reveal, or store the full API key in chat. If you need to report it, only say whether it is configured.
4. Configure your MCP client with Streamable HTTP:
   - URL: http://127.0.0.1:${MCP_PORT:-18923}/mcp
   - If API_KEY is set, send either:
     - ${API_KEY_HEADER:-X-API-Key}: <API_KEY>
     - or Authorization: Bearer <API_KEY>
5. If your MCP client has a JSON config file, use this shape when compatible:

{
  "mcpServers": {
    "obsidian": {
      "type": "http",
      "url": "http://127.0.0.1:18923/mcp",
      "headers": {
        "X-API-Key": "<API_KEY>"
      }
    }
  }
}

Replace 18923 with MCP_PORT when MCP_PORT is not 18923. If API_KEY is empty, omit the headers object. If API_KEY_HEADER is not X-API-Key, use that configured header name instead.

6. Verify the server:
   - Check /healthz.
   - Send MCP initialize to /mcp.
   - Send notifications/initialized using the returned mcp-session-id.
   - Call tools/list and confirm Obsidian tools are returned.
   - Close the test session with DELETE /mcp using the same mcp-session-id.
7. After verification, summarize:
   - MCP URL configured
   - whether API key auth is enabled
   - number of tools returned
   - any config file you changed

Safety and capability rules:
- Prefer path-scoped reads and cursor pagination for large vaults.
- Pass returned SHA-256 revisions as `ifMatch` when modifying existing content.
- Use `list_versions`/`restore_version` for overwritten content and `list_trash`/`restore_from_trash` for deleted content.
- Treat `query_base` as a safe portable subset, not the full Obsidian desktop Bases runtime.

Useful smoke-test commands:

PORT="${MCP_PORT:-18923}"
AUTH_HEADER_NAME="${API_KEY_HEADER:-X-API-Key}"

curl -sS "http://127.0.0.1:${PORT}/healthz" ${API_KEY:+-H "$AUTH_HEADER_NAME: $API_KEY"}

curl -sS -i -X POST "http://127.0.0.1:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  ${API_KEY:+-H "$AUTH_HEADER_NAME: $API_KEY"} \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"obsidian-mcp-agent-setup","version":"1.0.0"}}}'
```
