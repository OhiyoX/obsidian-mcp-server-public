# Host capability evidence ledger

Status: **candidate** — read-only evidence captured while classifying the hosts in
`host-matrix.json`. No credentials, tokens, or personal absolute paths are recorded here; host
artifact paths are given relative to their install roots or package names.

## How to read this

Each `host-matrix.json` cell references one or more evidence ids. A `real` cell must reference at
least one entry whose `kind` is `installed-artifact`, `command-output`, or `runtime-session`.

| Kind | Meaning |
| --- | --- |
| `installed-artifact` | Bytes or shipped docs from an installed host package/app binary. |
| `command-output` | Output of a host's own read-only CLI subcommand. |
| `runtime-session` | Observation made while a host was running in this task. |
| `runtime-observed` | Observation made while this repository's server was running (reproducible in-process). |

Every entry also records a `verification` field, which is what `--check` actually relies on:

| Verification | Meaning |
| --- | --- |
| `static-digest` | A marker scan whose recorded counts are hashed; `--check` recomputes the SHA-256 digest. Re-derive the counts with `--scan <scanId>=<path>` (a directory for scans that declare a `chunk-*.js`-style collection). |
| `repository-test` | Reproduced by the repository test suite. |
| `static-excerpt` | Hand-read from an installed artifact; not machine-reproducible. |
| `external-attestation` | Captured on the probe machine or in this session; not verified by `--check`. |

Marker counts are `grep -a -o` occurrences in a bundle/binary and are only evidence that a
mechanism's *code path or schema* is present. They do not prove a runtime default. The aggregate
digest only proves that the recorded counts have not changed since the ledger was written; it is
not a substitute for re-running `--scan` against the artifact. For the Gemini CLI scan the
"artifact" is the multi-file `@google/gemini-cli/bundle/chunk-*.js` collection, so the digest also
binds the declared glob and `--scan` must be given the bundle directory.

## Ledger

| Evidence id | Kind | Source | Captured value |
| --- | --- | --- | --- |
| `pi-extensions-dynamic-tool-loading` | installed-artifact | `@earendil-works/pi-coding-agent/docs/extensions.md#dynamic-tool-loading` | Loader pattern with `pi.setActiveTools()`; model receives the updated tool list on the next request. |
| `pi-ai-deferred-tool-loading` | installed-artifact | pi-ai OpenAI Responses serialization | Emits `defer_loading` for tool-search results and `tool_search_call` / `tool_search_output` items. |
| `pi-changelog-deferred-documents` | installed-artifact | `@earendil-works/pi-coding-agent/CHANGELOG.md` | Inherited native deferred tool loading for OpenAI Responses, Fireworks, Kimi (issues #7709, #9323, #7199). |
| `pi-obsidian-mcp-extension` | installed-artifact | `.pi/agent/extensions/obsidian-mcp/index.ts` | Connects once, `client.listTools()`, `pi.registerTool()` for every tool; no `setActiveTools`, no list-changed handler. |
| `pi-session-observation` | runtime-session | This conversation | All 85 `mcp_obsidian_*` tools arrived with full input schemas; no loader/deferral. |
| `codex-features-list` | command-output | `codex features list` (0.151.0) | `tool_search` removed/false; `tool_search_always_defer_mcp_tools` removed/true; `skill_search` stable/true; `deferred_executor`, `deferred_tool_world_state`, `executor_capability_discovery`, `non_prefixed_mcp_tool_names`, `mcp_2026_07_28` under development/false. |
| `codex-binary-tokens` | installed-artifact | `codex.exe` (0.151.0) | `tool_search` 66, `defer_loading` 3, `list_changed` 76, `listChanged` 11, `always_defer` 8, `executor_capability_discovery` 8; response items include `tool_search_call` / `tool_search_output`. |
| `codex-mcp-add-help` | command-output | `codex mcp add --help` | Server flags are URL/command, env, bearer-token env var, OAuth; no per-server include/exclude tool filter. |
| `gemini-bundle-tokens` | installed-artifact | `@google/gemini-cli/bundle/chunk-*.js` (collection) | `includeTools` 125, `excludeTools` 217, `list_changed` 46, `listChanged` 65, `toolDiscovery` 16; `tool_search` 0, `defer_loading` 0. Aggregated across the sorted, deduped `chunk-*.js` collection. |
| `gemini-mcp-doc` | installed-artifact | `@google/gemini-cli/bundle/docs/tools/mcp-server.md` | `discoverMcpTools()` fetches each server's tool definitions and registers them; `includeTools`/`excludeTools` are static allow/deny lists. |
| `gemini-settings-mcp` | command-output | `gemini mcp list` | No MCP servers configured in the local profile. |
| `opencode-binary-tokens` | installed-artifact | `opencode.exe` 1.18.25 | `tool_search` 256, `toolSearch` 16, `defer_loading` 7, `list_changed` 6, `listChanged` 15, `excludeTools` 10. |
| `opencode-mcp-listchanged` | installed-artifact | `opencode.exe` MCP client | `notifications/tools/list_changed` bound with `autoRefresh` default `true`, `debounceMs` 300, plus list-changed handlers. |
| `opencode-provider-toolsearch` | installed-artifact | `opencode.exe` provider layer | OpenAI `tool_search` provider tool, Anthropic `toolSearchBm25` / `toolSearchRegex`, and `defer_loading` serialization. |
| `opencode-mcp-list` | command-output | `opencode mcp list` | One configured remote MCP server reported `connected`. |
| `cursor-workbench-tokens` | installed-artifact | Cursor 3.21.16 `workbench.desktop.main.js` | `tool_search` 0, `toolSearch` 0, `defer_loading` 0, `list_changed` 4, `listChanged` 3; MCP client lists via paginated `tools/list`. |
| `cursor-listchanged-handler` | installed-artifact | Cursor 3.21.16 workbench | `notifications/tools/list_changed` routes to an `onDidChangeToolList` event. |
| `vscode-workbench-tokens` | installed-artifact | VS Code 1.134.0 `workbench.desktop.main.js` | `tool_search` 8, `toolSearch` 13, `defer_loading` 0, `list_changed` 4, `listChanged` 7. |
| `vscode-toolsearch-setting` | installed-artifact | VS Code 1.134.0 settings schema | `chat.agentHost.copilot.toolSearch.enabled` default `true`, `chat.agentHost.copilot.toolSearch.deferThreshold`, and `tool_search_output` transcript handling. |
| `vscode-listchanged-handler` | installed-artifact | VS Code 1.134.0 workbench | `notifications/tools/list_changed` routes to an `onDidChangeToolList` event. |
| `workbuddy-asar-tokens` | installed-artifact | WorkBuddy 5.4.5 `resources/app.asar` | `tool_search` 9, `defer_loading` 41, `list_changed` 71, `listChanged` 124, `mcpServers` 437, `tools/list` 76. |
| `workbuddy-tool-registry` | installed-artifact | WorkBuddy 5.4.5 asar | Normalizes `ToolSearch`/`tool_search` and `DeferExecuteTool`/`defer_execute_tool`. |
| `workbuddy-defer-loading-default` | installed-artifact | WorkBuddy 5.4.5 MCP sanitizer | MCP entry `defer_loading` defaults to `false` for non-builtin servers unless configured. |
| `server-tools-listchanged` | runtime-observed | Local in-process `McpServer` capability probe (SDK 1.30.0) | Advertises `tools.listChanged: true`. |
| `server-eager-catalog` | installed-artifact | Wave 1 `docs/review/tool-discovery/inventory.md` | 85 tools registered unconditionally; `tools/list` not scope-filtered. |
| `server-inprocess-catalog-wave4` | runtime-observed | `app/` in-process `McpServer` + `client.listTools()` (SDK 1.30.0) | A real client session lists exactly 85 tools while the server advertises `tools.listChanged: true`; reproduced by `app/test/host-tool-discovery-probe.test.js`. |
| `pi-session-wave4` | runtime-session | This conversation (Pi 0.87.1, `deepseek-v4.1-flash` via `opencode-go`) | All 85 Obsidian tools arrived as `mcp_obsidian_*` with full input schemas; no loader/deferred block. The extension registers every tool and installs no list-changed handler. |
| `codex-mcp-config-wave4` | command-output | `codex mcp list` / `codex mcp get obsidian` (0.151.0) | An `obsidian` `streamable_http` MCP server is configured and enabled with an API-key header. No tool count or deferral state is exposed by the CLI. |
| `opencode-mcp-connection-wave4` | command-output | `opencode mcp list` (1.18.25) | One configured remote MCP server (`obsidian_server`) reported `connected`. No tool count or deferral state is exposed by the CLI. |
| `gemini-mcp-config-wave4` | command-output | `gemini mcp list` (0.57.0) | No MCP servers configured in the local profile, so no Gemini MCP session exists. |

## Raw probe commands

Commands were read-only. No MCP tool was called and no Vault file was read or written.

```sh
pi --version                          # 0.87.1
codex --version                       # codex-cli 0.151.0 (bash shim)
codex features list | grep -iE "tool|defer|search|discover|mcp"
codex mcp add --help
codex mcp list                        # Wave 4: shows the `obsidian` streamable_http server (enabled)
codex mcp get obsidian                # Wave 4: transport=streamable_http, API-key header, no tool list
gemini --version                      # 0.57.0
gemini mcp list                       # No MCP servers configured.
opencode --version                    # 1.18.25
opencode mcp list                     # 1 server(s); obsidian_server connected
cursor --version                      # 3.21.16
code --version                        # 1.134.0
```

Binary/artifact scans used bounded token counts plus context extraction for
`tool_search`, `toolSearch`, `defer_loading`, `notifications/tools/list_changed`, and
`listChanged`. Those recorded counts are stored as `staticScans` in `host-matrix.json` with a
SHA-256 digest; re-derive them with `--scan <scanId>=<path>` against the local artifact. When a
scan declares a `collection` (Gemini CLI), pass the containing directory and the scanner
enumerates the glob in stable sorted order, dedupes entries, and aggregates the counts. The
server capability is reproduced by an in-process `McpServer` handshake in
`app/test/host-tool-discovery-probe.test.js`.

## Wave 4 runtime session observations

Wave 2 classified hosts from installed artifacts and CLI output. Wave 4 adds the `runtimeSessions`
registry: actual sessions, with every unobserved capability field left `null`. What was actually
observed on this machine:

- **Pi (this session, 0.87.1):** all 85 `mcp_obsidian_*` tools with full input schemas, no
deferred block and no loader tool. list refresh and cross-session were not re-measured.
- **Obsidian MCP server (in-process):** a real client session lists 85 tools and the server
advertises `tools.listChanged: true`; this is the one session reproduced by the repository test
suite.
- **Codex CLI:** `codex mcp list` / `codex mcp get obsidian` show an enabled `obsidian`
`streamable_http` server. That is configuration, not a tool-list observation, so no capability
field is filled in.
- **OpenCode:** `opencode mcp list` reports `obsidian_server` connected. Connection status does not
show whether tools are deferred, so no capability field is filled in.
- **Gemini CLI:** `gemini mcp list` reports no configured servers.

No host was driven through an end-to-end agent task, and no host other than Pi had its tool list
observed. Cells therefore stay `artifact-declared` or `unknown`.

## Caveats recorded during probing

- **Codex version depends on the launch shim.** `codex --version` through the bash shim reports
  `0.151.0`; the Windows `.cmd` shim resolves a different pre-release
  (`0.155.0-alpha.16.4`). The matrix pins `0.151.0` because that is the `@openai/codex`
  package whose `codex.exe` was scanned. This is why `--detect` is not a `--check` gate.
- **Pi core does not ship MCP.** The Obsidian MCP integration is a user extension; the extension
  is eager, while the host's dynamic-tool-loading API and pi-ai deferral are host-level.
- **`tool_search_always_defer_mcp_tools` reports stage `removed` with effective `true`.** Stage
  and effective value are recorded verbatim from `codex features list`; no runtime default is
  claimed.
- **VS Code tool search is scoped to `chat.agentHost.copilot`.** Applicability to arbitrary MCP
  servers was not verified.
- **Cursor scan found no deferral tokens.** Absence of these marker strings is `not-detected`,
  not proof of eager loading.
- **Non-reproducible observations.** `pi-session-observation` (this session) and the
  `command-output` records are `external-attestation`: they cannot be re-run in CI and `--check`
  does not claim to verify them. The recorded marker counts are `static-digest`; re-deriving them
  requires the local artifact via `--scan`, and the Gemini record requires the bundle directory
  rather than a single `chunk-*.js` path.

## Reproduce

```sh
cd app
node scripts/probe-host-tool-discovery.mjs --check
node scripts/probe-host-tool-discovery.mjs --scan-list
node scripts/probe-host-tool-discovery.mjs --session-list
node scripts/probe-host-tool-discovery.mjs --scan cursor-workbench-3.21.16=/path/to/workbench.js
node scripts/probe-host-tool-discovery.mjs --scan gemini-cli-bundle-0.57.0=/path/to/gemini-cli/bundle
node --test test/host-tool-discovery-probe.test.js
node scripts/probe-host-tool-discovery.mjs --detect
```
