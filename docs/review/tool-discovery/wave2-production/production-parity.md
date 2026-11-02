# Production tools/list parity — Wave 2

Status: **production-verified** (deployed `tools/list` surface; candidate artifact on a branch).
Baseline: local `main` `fc926a5d853888072c60454a2fffaa86cbe78b33` (Wave 1 inventory, 85 tools).
Target: deployed server `obsidian-mcp-server 1.0.0` over Streamable HTTP at a redacted endpoint (`http-private-custom-port`); API key supplied from an environment variable and not recorded.
Offline verification of this artifact cannot prove it was captured from a live server.

This proves parity of the deployed wire contract with local main. It does not prove the deployed checkout equals the baseline commit; only the registration-derived catalog was compared.

## Result

- Deployed tools: **85**; expected: 85; Wave 1 inventory: 85.
- Name set matches `TOOL_NAMES`: **true**; matches the Wave 1 inventory: **true**.
- inputSchema sha256 + bytes mismatches: **0**.
- outputSchema (output contract) sha256 + bytes mismatches: **0**.
- annotation mismatches: **0**; title mismatches: **0**.
- Totals: inputSchema 29032 bytes, outputSchema 62455 bytes, descriptor 138997 bytes.

## Scope

- `tools/list` never carries Scope. Scope is enforced per `tools/call`; this slice did not acquire a second, scope-limited production credential, so deployed enforcement was not behaviourally probed.
- Source of truth: `app/src/scopes.js MCP_TOOL_SCOPE_REQUIREMENTS` (85 tools).
- Deployed scope enforcement: **unknown** (status: `not_wire_observable`).

## Census (from the deployed catalog)

| Annotation flag | Tools |
| --- | --- |
| `readOnlyHint` | 50 |
| `destructiveHint` | 28 |
| `idempotentHint` | 52 |
| `openWorldHint` | 10 |

| Scope set (source evidence) | Tools |
| --- | --- |
| `obsidian.read` | 47 |
| `obsidian.read+obsidian.files` | 5 |
| `obsidian.read+obsidian.write` | 26 |
| `obsidian.read+obsidian.write+obsidian.files` | 7 |

## Measured / unmeasured

Measured: deployed tools/list name set versus TOOL_NAMES and the Wave 1 inventory; deployed inputSchema canonical sha256 + utf8 bytes versus the Wave 1 inventory; deployed outputSchema (output contract) canonical sha256 + utf8 bytes versus the Wave 1 inventory; deployed annotations versus the Wave 1 inventory; deployed title versus the Wave 1 inventory; annotation/risk/scope histograms computed from the deployed catalog.

Unmeasured: deployed Scope enforcement (not observable over tools/list; no scope-limited credential used); client/host tool filtering — this is a raw HTTP capture, not a specific host's filtered view; token cost (byte sizes are not tokens).

