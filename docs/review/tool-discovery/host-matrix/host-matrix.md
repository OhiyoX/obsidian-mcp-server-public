# Progressive Tool Discovery — Phase 0 host defer/tool-search capability matrix

Status: **candidate** (branch artifact; baselines main `c860abae342a9b4ea45949de8f24690a92ec7eab`).
Schema: `1.1.0`. Read-only characterization.

This table records what is **actually provable** about each locally installed MCP-client host. A `real` classification requires an installed artifact or a runtime observation; a host that was not measured is `unknown`, never assumed supported.

`--check` recomputes the static-scan digests over **recorded** marker counts and enforces tier/evidence-kind correspondence. It does **not** re-scan host artifacts and does not verify outside-the-repository runtime or command observations; those are external attestations.

## Matrix

| Host | Version | Tool discovery | Native schema auto-load | list refresh | Cross-session |
| --- | --- | --- | --- | --- | --- |
| `codex-cli` | 0.151.0 | real (artifact-declared) | unknown (unknown) | implemented (artifact-declared) | unknown (unknown) |
| `cursor` | 3.21.16 | unknown (not-detected) | unknown (not-detected) | implemented (artifact-declared) | unknown (unknown) |
| `gemini-cli` | 0.57.0 | eager-fallback (artifact-declared) | eager-auto (artifact-declared) | unknown (unknown) | unknown (unknown) |
| `opencode` | 1.18.25 | real (artifact-declared) | unknown (unknown) | implemented (artifact-declared) | unknown (unknown) |
| `pi` | 0.87.1 | real (artifact-declared) | eager-auto (runtime-observed) | not-detected (artifact-declared) | re-discovered-per-session (artifact-declared) |
| `vscode` | 1.134.0 | real (artifact-declared) | unknown (unknown) | implemented (artifact-declared) | unknown (unknown) |
| `workbuddy` | 5.4.5 | real (artifact-declared) | eager-auto (artifact-declared) | implemented (artifact-declared) | unknown (unknown) |

## Per-host notes

### OpenAI Codex CLI (`codex-cli`)

- Family: codex; client kind: cli-agent; availability: installed.
- **toolDiscoveryMode**: real — artifact-declared. Binary contains tool_search, tool_search_call/tool_search_output items and defer_loading, and the tool_search_always_defer_mcp_tools flag reports effective true. The standalone tool_search flag reports stage removed. Runtime default was not exercised.
  - evidence: `codex-features-list` (command-output, external-attestation), `codex-binary-tokens` (installed-artifact, static-digest)
- **nativeSchemaAutoLoad**: unknown — unknown. Deferral flags and defer_loading exist, but the effective default for this build was not exercised against a live MCP connection.
  - evidence: `codex-binary-tokens` (installed-artifact, static-digest)
- **listRefresh**: implemented — artifact-declared. Binary constrains the notifications/tools/list_changed method string.
  - evidence: `codex-binary-tokens` (installed-artifact, static-digest)
- **crossSession**: unknown — unknown. Not measured in this task.

### Cursor (`cursor`)

- Family: cursor; client kind: ide-agent; availability: installed.
- **toolDiscoveryMode**: unknown — not-detected. No tool_search or defer_loading tokens were found in the workbench bundle. Absence of these tokens is not proof that Cursor always loads tools eagerly.
  - evidence: `cursor-workbench-tokens` (installed-artifact, static-digest)
- **nativeSchemaAutoLoad**: unknown — not-detected. The MCP client lists tools through tools/list; no deferral path was found in the bundle.
  - evidence: `cursor-workbench-tokens` (installed-artifact, static-digest)
- **listRefresh**: implemented — artifact-declared. MCP client routes notifications/tools/list_changed to an onDidChangeToolList event.
  - evidence: `cursor-listchanged-handler` (installed-artifact, static-excerpt)
- **crossSession**: unknown — unknown. Not measured in this task.

### Gemini CLI (`gemini-cli`)

- Family: gemini; client kind: cli-agent; availability: installed.
- **toolDiscoveryMode**: eager-fallback — artifact-declared. discoverMcpTools() fetches each server's full tool definitions and registers them; includeTools/excludeTools are static filters; no tool_search or defer_loading tokens were found.
  - evidence: `gemini-mcp-doc` (installed-artifact, static-excerpt), `gemini-bundle-tokens` (installed-artifact, static-digest)
- **nativeSchemaAutoLoad**: eager-auto — artifact-declared. Discovery fetches and registers the full tool set from every configured server.
  - evidence: `gemini-mcp-doc` (installed-artifact, static-excerpt)
- **listRefresh**: unknown — unknown. SDK notification schemas are bundled, but no host path that re-lists tools on notifications/tools/list_changed was found.
  - evidence: `gemini-bundle-tokens` (installed-artifact, static-digest)
- **crossSession**: unknown — unknown. Not measured in this task.

### OpenCode (`opencode`)

- Family: opencode; client kind: cli-agent; availability: installed.
- **toolDiscoveryMode**: real — artifact-declared. Bundles the OpenAI tool_search provider tool and Anthropic toolSearchBm25/toolSearchRegex tools plus defer_loading. Whether the remote Obsidian MCP tools are deferred depends on the configured provider/model.
  - evidence: `opencode-provider-toolsearch` (installed-artifact, static-excerpt), `opencode-binary-tokens` (installed-artifact, static-digest)
- **nativeSchemaAutoLoad**: unknown — unknown. Provider-native deferral exists, but the load behavior for a third-party MCP server was not exercised.
  - evidence: `opencode-provider-toolsearch` (installed-artifact, static-excerpt)
- **listRefresh**: implemented — artifact-declared. MCP client declares notifications/tools/list_changed with autoRefresh default true and debounceMs 300.
  - evidence: `opencode-mcp-listchanged` (installed-artifact, static-excerpt)
- **crossSession**: unknown — unknown. Not measured in this task.

### Pi coding agent (`pi`)

- Family: pi; client kind: cli-agent-harness; availability: installed.
- **toolDiscoveryMode**: real — artifact-declared. Host-level capability: extensions can hold tools inactive and activate them with pi.setActiveTools(), and the provider layer can emit deferred tool loading. The installed Obsidian MCP bridge does not use either.
  - evidence: `pi-extensions-dynamic-tool-loading` (installed-artifact, static-excerpt), `pi-ai-deferred-tool-loading` (installed-artifact, static-excerpt), `pi-changelog-deferred-documents` (installed-artifact, static-excerpt)
- **nativeSchemaAutoLoad**: eager-auto — runtime-observed. This session received all 85 obsidian tools with full input schemas; the bridge calls listTools() then registers every tool.
  - evidence: `pi-obsidian-mcp-extension` (installed-artifact, static-excerpt), `pi-session-observation` (runtime-session, external-attestation), `pi-session-wave4` (runtime-session, external-attestation)
- **listRefresh**: not-detected — artifact-declared. The bridge connects once and registers no notifications/tools/list_changed handler.
  - evidence: `pi-obsidian-mcp-extension` (installed-artifact, static-excerpt)
- **crossSession**: re-discovered-per-session — artifact-declared. The extension factory connects and lists tools at process startup; a new process re-discovers.
  - evidence: `pi-obsidian-mcp-extension` (installed-artifact, static-excerpt)

### Visual Studio Code (`vscode`)

- Family: vscode; client kind: ide-agent; availability: installed.
- **toolDiscoveryMode**: real — artifact-declared. Exposes chat.agentHost.copilot.toolSearch.enabled (default true) and toolSearch.deferThreshold, and handles tool_search_output transcript entries. Scoped to the Copilot agent host; applicability to arbitrary MCP servers is unverified.
  - evidence: `vscode-toolsearch-setting` (installed-artifact, static-excerpt), `vscode-workbench-tokens` (installed-artifact, static-digest)
- **nativeSchemaAutoLoad**: unknown — unknown. A defer threshold exists for the Copilot agent host, but the load behavior for a third-party MCP server was not exercised.
  - evidence: `vscode-toolsearch-setting` (installed-artifact, static-excerpt)
- **listRefresh**: implemented — artifact-declared. MCP client routes notifications/tools/list_changed to an onDidChangeToolList event.
  - evidence: `vscode-listchanged-handler` (installed-artifact, static-excerpt)
- **crossSession**: unknown — unknown. Not measured in this task.

### WorkBuddy (`workbuddy`)

- Family: workbuddy; client kind: desktop-agent; availability: installed.
- **toolDiscoveryMode**: real — artifact-declared. Tool registry normalizes ToolSearch/tool_search and DeferExecuteTool/defer_execute_tool; MCP entries carry a defer_loading flag.
  - evidence: `workbuddy-tool-registry` (installed-artifact, static-excerpt), `workbuddy-asar-tokens` (installed-artifact, static-digest)
- **nativeSchemaAutoLoad**: eager-auto — artifact-declared. MCP server entries default defer_loading to false for non-builtin servers, so a third-party server loads schemas eagerly unless its config sets the flag.
  - evidence: `workbuddy-defer-loading-default` (installed-artifact, static-excerpt)
- **listRefresh**: implemented — artifact-declared. MCP client validates the notifications/tools/list_changed capability before accepting it.
  - evidence: `workbuddy-asar-tokens` (installed-artifact, static-digest)
- **crossSession**: unknown — unknown. Not measured in this task.

## Runtime sessions observed in this task

Actual sessions driven or observed while building this matrix. `unknown` means the field was not observed in that session; it is never inferred. These records are external attestations (except a repository-test session) and are not verified by `--check`.

| Session | Subject | Method | Captured | Tool count | Native schema | Deferral | list refresh | Cross-session | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `codex-mcp-config-wave4` | `codex-cli` | cli-command | 2026-09-25 | unknown | unknown | unknown | unknown | unknown | `codex-mcp-config-wave4` |
| `gemini-mcp-config-wave4` | `gemini-cli` | cli-command | 2026-09-25 | unknown | unknown | unknown | unknown | unknown | `gemini-mcp-config-wave4` |
| `opencode-mcp-connection-wave4` | `opencode` | cli-command | 2026-09-25 | unknown | unknown | unknown | unknown | unknown | `opencode-mcp-connection-wave4` |
| `pi-session-wave4` | `pi` | agent-session | 2026-09-25 | 85 | eager-auto | false | unknown | unknown | `pi-session-wave4`, `pi-obsidian-mcp-extension` |
| `server-inprocess-session-wave4` | `server` | in-process-mcp-handshake | 2026-09-25 | 85 | eager-auto | false | true | unknown | `server-inprocess-catalog-wave4`, `server-tools-listchanged` |

## Obsidian MCP server baseline

- Catalog tools: 85.
- `tools.listChanged` advertised: true (runtime-observed).
- The server advertises tools.listChanged: true and registers all 85 tools eagerly. Host-side visibility is not authorization; every tools/call is still scope-checked.

## Counts

- Hosts: 7
- By tool discovery: {"eager-fallback":1,"real":5,"unknown":1}
- By schema load: {"eager-auto":3,"unknown":4}
- By list refresh: {"implemented":5,"not-detected":1,"unknown":1}
- By cross-session: {"re-discovered-per-session":1,"unknown":6}
- Runtime sessions: 5

## Not installed (no capability claim): `aider`, `claude-code`, `claude-desktop`, `goose`, `hermes`, `openclaw`, `windsurf`, `zed`

## Static artifact scans

Recipe `1.1.0`. Digests are recomputed by `--check`; re-derive the counts on the probe machine with `--scan <scanId>=<path>` (a directory for `collection` scans).

| Scan id | Artifact | Source | Recorded marker counts | Digest |
| --- | --- | --- | --- | --- |
| `codex-exe-0.151.0` | @openai/codex-win32-x64/vendor/bin/codex.exe (0.151.0) | single file | tool_search=66, defer_loading=3, list_changed=76, listChanged=11, always_defer=8, executor_capability_discovery=8 | `124dc52084a4…` |
| `cursor-workbench-3.21.16` | Cursor 3.21.16 resources/app/out/vs/workbench/workbench.desktop.main.js | single file | tool_search=0, toolSearch=0, defer_loading=0, list_changed=4, listChanged=3 | `9a912833af9c…` |
| `gemini-cli-bundle-0.57.0` | @google/gemini-cli/bundle (0.57.0) | `chunk-*.js` (directory) | includeTools=125, excludeTools=217, list_changed=46, listChanged=65, toolDiscovery=16, tool_search=0, defer_loading=0 | `6b860fdc5e26…` |
| `opencode-bin-1.18.25` | opencode 1.18.25 binary | single file | tool_search=256, toolSearch=16, defer_loading=7, list_changed=6, listChanged=15, excludeTools=10 | `ff4b35ecf562…` |
| `vscode-workbench-1.134.0` | VS Code 1.134.0 workbench.desktop.main.js | single file | tool_search=8, toolSearch=13, defer_loading=0, list_changed=4, listChanged=7 | `1c493310106a…` |
| `workbuddy-asar-5.4.5` | WorkBuddy 5.4.5 resources/app.asar | single file | tool_search=9, defer_loading=41, list_changed=71, listChanged=124, mcpServers=437, tools/list=76 | `d183278ac602…` |

## Verification scope

Verified by `--check`:

- static marker counts are hashed and the digest is recomputed
- tier/evidence-kind correspondence for every cell
- checked-in JSON and Markdown match the authored data

Not verified by `--check`:

- recorded marker counts still matching the currently installed host artifacts (re-run with --scan <scanId>=<path>; collection scans take the bundle directory)
- runtime-session / command-output observations captured outside this repository
- static excerpts that were read by hand from an installed artifact

Evidence verification counts: {"external-attestation":9,"repository-test":2,"static-digest":6,"static-excerpt":13}

## Evidence kinds

`command-output`, `documentation-only`, `installed-artifact`, `runtime-observed`, `runtime-session`

## Unknowns

- No host was driven through an end-to-end agent task in this task.
- Runtime tool-list/deferral behavior of installed hosts against a live MCP server was not exercised except for Pi's own session.
- Cross-session persistence was not measured for any host.
- Codex, OpenCode, and Gemini were observed only at the configuration/connection layer, not at the tool-list layer.
- External documentation of hosts that are not installed was not consulted, so no host is classified as documented-only.
- Byte sizes and token counts of the eager catalog are not repeated here; see docs/review/tool-discovery/inventory.md.
- Recorded marker counts are digest-checked but were not re-scanned by --check; re-derive them on the probe machine with --scan (a directory for collection scans).

## Not measured

- re-scan of installed host artifacts by --check
- runtime tool-list/deferral behavior against a live MCP server for any host other than Pi
- tool count or deferral behavior for codex-cli, opencode, cursor, vscode, and workbuddy
- external attestations recorded outside this repository

## Evidence tiers

| Tier | Meaning |
| --- | --- |
| `runtime-observed` | Observed directly while the host was running against an MCP surface in this task. |
| `artifact-declared` | Found in an installed host artifact (binary strings, bundled source, CLI output, shipped docs). |
| `documentation-only` | Claimed only by external documentation; no local implementation artifact found. |
| `not-detected` | Inspected the installed artifact and did not find the mechanism; absence is not proof of absence. |
| `not-available` | Host binary was not found locally; no capability claim is made. |
| `unknown` | Not measured and not resolvable from available evidence. |

