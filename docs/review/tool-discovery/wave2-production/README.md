# Progressive Tool Discovery — Wave 2 production parity + eager real run

Status: **candidate** (branch artifact). Baseline: local `main` `fc926a5d853888072c60454a2fffaa86cbe78b33`;
target: deployed NAS `obsidian-mcp-server` reachable at the configured LAN MCP endpoint.

This slice is characterization/evidence only. It changes no server registration, tool
visibility, authorization, or default `tools/list` behavior, and it touches no vault data.

## What this slice establishes

1. The **deployed** `tools/list` wire contract is compared field by field with the Wave 1
   local inventory (`docs/review/tool-discovery/inventory.json`).
2. The Wave 1 **50 task fixtures** are reused for a **real** eager run: the harness actually
   connects to the deployed server and issues read-only `tools/call` probes.
3. Success/failure is recorded with explicit, non-fabricated semantics; anything that cannot
   be measured deterministically is marked `blocked`/`unknown`.

## Artifacts

- `production-parity.json` / `production-parity.md` — deployed catalog vs Wave 1 inventory.
- `eager-run.json` / `eager-run.md` — real read-only probe run + fixture readiness.
- `app/scripts/tool-discovery-production-eval.mjs` — capturing and probing harness.
- `app/test/tool-discovery-production-eval.test.js` — offline tests for the harness.

Wave 1 inputs (`docs/review/tool-discovery/inventory.json`, `inventory.md`,
`eager-baseline.md`, `app/test/fixtures/tool-discovery-eager-tasks.json`) are read-only here.

## How to regenerate

```sh
cd app
# Offline: fixtures + current source must still reproduce the Wave 1 inventory, and both
# checked-in artifacts must satisfy their contracts and cross-consistency. This offline
# check cannot prove the artifacts were captured from a live server.
node scripts/tool-discovery-production-eval.mjs --verify

# Live capture (needs the MCP endpoint + API key in an environment variable):
OBSIDIAN_MCP_API_KEY=... node scripts/tool-discovery-production-eval.mjs --capture --url <mcp-url>
OBSIDIAN_MCP_API_KEY=... node scripts/tool-discovery-production-eval.mjs --run --url <mcp-url>

node --test test/tool-discovery-production-eval.test.js
```

`--capture` and `--run` never print or store the API key. Missing host or credentials produce a
`blocked` result and a non-zero exit; nothing is invented. `--run` writes both artifacts.
The committed artifacts redact the target to a stable endpoint category
(`target.endpoint.endpointClass`); the harness never writes the raw host, userinfo, path, query
string or fragment, so internal addresses and credential/signature query parameters cannot leak.
`--verify` is an offline check of the two artifact contracts and their cross-consistency; it does
not and cannot prove live provenance.

## Findings (data captured against the deployed server)

### 1. Exact wire parity — `match`

| Field | Result |
| --- | --- |
| Name set | 85 deployed = 85 `TOOL_NAMES` = 85 inventory; 0 missing/extra |
| `inputSchema` canonical sha256 + utf8 bytes | 0 mismatches (29,032 bytes total) |
| `outputSchema` (output contract) canonical sha256 + utf8 bytes | 0 mismatches (62,455 bytes total) |
| Annotations | 0 mismatches (readOnly 50, destructive 28, idempotent 52, openWorld 10) |
| `title` | 0 mismatches |

The deployed `tools/list` is byte-identical to local `main` for the compared fields. This proves
the deployed wire contract matches the baseline registration; it does **not** prove the deployed
checkout equals `fc926a5` (only the catalog was compared).

### 2. Scope is not wire-observable — `unknown`

`tools/list` does not carry Scope. The scope histogram in the report is mapped from local source
(`app/src/scopes.js MCP_TOOL_SCOPE_REQUIREMENTS`) onto the deployed tool names. Deployed Scope
*enforcement* was not behaviourally probed, because that needs a scope-limited second credential
that this slice did not acquire. Status: `not_wire_observable` / `deployedScopeEnforcement: unknown`.

### 3. Real eager run over the 50 fixtures

- 47 real MCP calls: 6 discovery + 41 read-only probes (35 write/destructive tools excluded by policy).
- Probe success rate: **0.951** (39/41); 2 `output_contract_violation`; 9 read-only tools not probed.
- Expected-tool reachable rate: **1.000** (every fixture's expected tools exist in the deployed catalog).
- Fixture readiness: 29 `ready`, 15 `blocked_safety` (expected tool is a write/destructive tool that
  was deliberately not invoked), 5 `blocked_harness` (read-only plan tools skipped), 1 `failed`.
- Schema cost: deployed catalog inputSchema 29,032 bytes / outputSchema 62,455 bytes;
  per-fixture expected-tool inputSchema cost totals 24,417 bytes (max 2,534 bytes).

The run is a **live snapshot** of a mutable vault. Re-running can change individual probe outcomes
(e.g. the most-recently-modified note grows past the 1 MiB probe budget, yielding a
`payload_exceeds_probe_budget` tool error). The committed `eager-run.json` is the single captured run;
re-run `--run` to refresh it.

Not probed (read-only, no safe probe): `file_upload_status` (needs an upload id),
`get_canvas` / `inspect_archive` (no object found), `get_note_plan` (needs a plan id), and the five
`plan_*` preview tools (probing would create durable server-side plan state).

### 4. Observed deployed output-contract defects

Two read-only calls fail against the deployed server because the returned `structuredContent` does
not satisfy the server's own declared `outputSchema` (a genuine product defect, not a harness
limitation):

| Tool | Deployed error |
| --- | --- |
| `git_diff` | `MCP error -32602: Output validation error: ... expected string, received boolean at staged` |
| `get_note_version` | `MCP error -32602: Output validation error: ... expected boolean, received string at created` |

Both trace to `app/src/tool-contracts.js` field typing: the field name is typed per-tool by
inference, and `staged`/`created` collide across tools. Because `outputSchema` parity matches
local main, the defect exists on the baseline source too. Fixing it is **out of scope** for this
evidence slice; it should be a separate, tested change.

## Honest limits

- **Agent task success is `blocked`.** No model/agent harness exists here, so task completion,
  tool-selection precision/recall, wrong-tool rate, and discovery rounds were not measured or
  simulated. The fixture "readiness" numbers describe what the real eager catalog reached, not
  whether an agent would finish the task.
- **No latency** is captured (matching the Wave 1 eager baseline methodology).
- **The eager run is a live snapshot, not a reproducible replay.** Per-tool outcomes depend on current
  vault state (file sizes, dirty git state, version history); only the structural parity capture is
  deterministic.
- **Byte sizes are not tokens.**
- **Host/client filtering is unmeasured**: this is a raw HTTP capture, not a specific host's
  filtered `tools/list`.
- **Scope enforcement is `unknown`** (see above).
- Mutation paths are intentionally never exercised: only tools the deployed server annotates
  `readOnlyHint: true` are invoked, and payload bodies are never recorded or committed.

## Evidence trail

- Inventory (Wave 1, read-only): `docs/review/tool-discovery/inventory.{json,md}`.
- Fixtures (Wave 1, read-only): `app/test/fixtures/tool-discovery-eager-tasks.json`.
- Eager baseline (Wave 1, read-only): `docs/review/tool-discovery/eager-baseline.md`.
- This slice's captured parity and run output: this directory.
