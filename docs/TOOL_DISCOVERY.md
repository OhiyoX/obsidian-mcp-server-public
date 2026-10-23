# Progressive Tool Discovery runtime policy

Status: **merged** — the runtime policy landed on `main` in #110 (`499347c3`), which is an ancestor
of the current head, and it is active with the default `full` profile. This document does **not**
claim release, deployment or production verification; those follow the normal tag/deploy/production
records. History: it was authored on `feat/discovery-runtime-policy` (base `8e1a519`) and reviewed as
a candidate before #110 landed.

This document describes the Phase 2B runtime policy that constrains which MCP
tools a client can see and call. It is the runtime counterpart of the pure
Capability Catalog (`app/src/capability-catalog.js`) and Capability Policy view
(`app/src/capability-policy.js`) introduced by earlier discovery phases.

## Scope and safety model

Visibility is **not** authorization. The policy view can only remove tools from
the advertised list; it never grants a scope and never bypasses a scope, Vault,
path, revision, or author check. Every real `tools/call` still goes through the
existing auth middleware and tool handler checks.

The runtime policy constrains exactly three surfaces from one resolver:

- `tools/list` — the advertised tool set;
- direct `tools/call` — a tool hidden by the current view fails closed;
- the `server_info` policy summary — a bounded, name-free count summary.

## Resolver pipeline

For every request the view is derived, in order:

1. canonical catalog (`CAPABILITY_CATALOG`, equal to `TOOL_NAMES` membership);
2. **current request granted scopes** hard filter (from `req.auth.scopes`);
3. immutable operator profile (`full` / `core` / `module` / `custom`);
4. explicit `denyTools`;
5. native-order membership filter (see below).

The policy is a **membership filter over the native list**, never a rebuild:

- `tools/list` returns the native SDK descriptors in the native SDK
  registration order with hidden members removed. The default `full` profile
  with an authorized scope set is a byte-for-byte pass-through of the raw
  native array (same descriptors, same order). `core`/`module`/`custom` only
  remove members and therefore keep the native relative order.
- `server_info.tools` keeps the canonical `TOOL_NAMES`/`CAPABILITY_CATALOG`
  order.
- If a policy-visible tool has no native registration, or a native tool is not
  in the catalog, `tools/list` fails loudly instead of silently dropping the
  member. A registration/catalog mismatch is never disguised as a policy
  decision.

The view is recomputed from the request's auth context on every request. It is
never cached on the MCP session. A revoked scope, or a request from a different
identity, can therefore never reuse a broader list:

- the existing per-request auth middleware re-verifies the credential and
  rejects a missing scope with `insufficient_scope` before the handler runs;
- the existing session binding rejects a different `authClientId` with `403`
  before the transport is reached;
- the discovery resolver then applies scope and profile to that request only.

When authorization is disabled (`API_KEY` empty and OAuth disabled,
`authMode === "none"`) `server.js` injects an explicit immutable
`authDisabled: true` runtime option. Only then does a request with **no auth
context** receive all scopes. The resolver default is auth-expected: a missing
auth context with `authDisabled` unset resolves to zero scopes and fails
closed. A **present** auth context is always authoritative — a malformed or
missing scope list fails closed even when the server is open.

## Operator configuration

The operator profile is read **once at process start** from environment
variables. It is static and immutable; there is no mid-session activation and
no host/client-name guessing.

| Variable | Meaning |
| --- | --- |
| `MCP_DISCOVERY_PROFILE` | `full` (default), `core`, `module`, or `custom`. |
| `MCP_DISCOVERY_TOOLSETS` | For `module`: comma/space separated toolsets (`info`, `notes`, `search`, `files`, `links`, `workflows`, `git`, `intelligence`, `publish`, `plans`). |
| `MCP_DISCOVERY_TOOLS` | For `custom`: comma/space separated canonical tool names. |
| `MCP_DISCOVERY_DENY_TOOLS` | Any profile: canonical tool names that are always hidden. |

Profiles:

- `full` — every tool the request is authorized for. This is the default and
  preserves existing behavior apart from the scope filtering below.
- `core` — the frozen six-tool seed (`agent_bootstrap`, `server_info`,
  `get_note`, `list_notes`, `search_notes`, `recall`).
- `module` — the union of the selected source-registration toolsets.
- `custom` — an explicit canonical tool allowlist.

If the configuration is absent, unknown, or internally inconsistent (for
example, a `full` profile with an allowlist, an unknown toolset, or an unknown
tool name), the server logs one bounded, secret-free warning and falls back to
the `full` compatibility profile. Fallback never widens the request's scopes:
the granted-scope hard filter is still applied first.

### Deployment plumbing

These variables are read **once at process start**, so they must be present in
the container environment when the process starts:

- `docker-compose.yaml` forwards all four variables from the host shell or the
  project `.env` into the `obsidian-server` container. Each uses the same
  fallback default as `.env.example` (`:-full` for the profile, `:-` empty for
  the three lists). A missing compose entry means a production `.env` value
  never reaches the container.
- Changing `.env` requires recreating the container, not just restarting it:
  `docker compose up -d --no-build --force-recreate obsidian-server`. A plain
  `docker compose restart` keeps the existing container environment. Source-only
  edits (`app/server.js`, `app/src`) still load on a restart because Compose
  bind-mounts them.
- The variables are validated at startup; an invalid value falls back to `full`
  with the bounded warning in the container logs. It never partially applies.

## Direct-call behavior

A tool that is hidden by the current view (by scope or by operator profile) is
rejected with the same JSON-RPC shape the SDK uses for a tool that was never
registered:

```text
MCP error -32602: Tool <name> not found
```

The runtime does not call the private SDK `McpServer.createToolError` helper.
Instead it uses a tiny local `unknownToolResult(name)` compatibility builder
that returns the pinned SDK's unknown-tool `CallToolResult` shape directly:
`content: [{ type: "text", text: "MCP error -32602: Tool <name> not found" }]`
and `isError: true`. A hidden name and a nonexistent name are therefore
indistinguishable in the response apart from the tool name itself, with no
hidden descriptor, title, description, schema, or annotation returned. The
real-StreamableHTTP test characterizes the pinned SDK response and asserts the
whole result (keys `content`/`isError`, content text, `isError`, and no extra
metadata) after normalizing only the tool name against a never-registered
name; it acts as pinned-SDK drift detection, and the local builder is the
single place to update if that shape ever changes.
The tool remains registered in the SDK; the policy never calls
`enable`/`disable`/`remove`, never mutates the registry, never emits a
`list_changed` notification, and never keeps activation sets or TTLs.

## `server_info` summary

`server_info` returns the same per-request `tools` list plus a bounded
`discovery` object:

```json
{
  "schemaVersion": 1,
  "profile": "full",
  "catalogToolCount": 85,
  "authorizedToolCount": 85,
  "visibleToolCount": 85,
  "hiddenByScope": 0,
  "hiddenByPolicy": 0
}
```

`hiddenByScope` counts catalog tools the request lacks scopes for.
`hiddenByPolicy` counts authorized tools removed by the profile or `denyTools`.
No hidden tool names are included.

## What this does not do

- It does not change `app/src/scopes.js`, `config.js TOOL_NAMES`,
  `tool-contracts.js`, `capability-catalog.js`, or `capabilities.js`.
- It does not add a `discover_tools` tool, a broker, or an activation API.
- It does not read the Vault, embeddings, or any filesystem path while
  resolving a view. (An explicit `server_info` call still performs its existing
  Vault health check.)
- It does not make the Web session trust domain share the MCP credential model.

## Source

- `app/src/discovery-config.js` — immutable operator config + fallback warning.
- `app/src/discovery-runtime.js` — resolver, generic registrar, view context,
  `server_info` summary.
- `app/server.js` — composes the registrar before
  `registerObsidianCapabilities`, injects the immutable `authDisabled` option
  from `authMode === "none"`, and installs the request handlers once.
- `app/src/tools/info.js` — `server_info` policy summary.
- `app/test/discovery-runtime.test.js` — real Streamable HTTP transport tests.
- `app/test/discovery-compose-config.test.js` — compose forwarding of the four
  `MCP_DISCOVERY_*` vars, the real process-env startup read, and (when a Docker
  CLI is present) a secret-free `docker compose config` render.

## Verification

From `app/`:

```sh
npm ci
npm run check
npm test
```

`npm run build:web` is not applicable; no frontend source changed.

## Phase 2C eval & cost gate

The static profiles above are evaluated offline in
`docs/review/tool-discovery/p2c-cost-gate/`. The harness
(`app/scripts/tool-discovery-cost-gate.mjs`) reuses the frozen 50 task fixtures and the native
in-memory `tools/list` descriptors; it never connects to a live server, never calls a tool, and
never touches the Vault.

Result on the current tree: **gate `hold`; production default stays `full`**.

- `full` is a native passthrough of all 87 tools and keeps 100% static expected-tool coverage.
- `core` (six tools) has 24.1% static critical-tool recall and fully covers only 8/50 fixtures;
  it is an engineering hypothesis, not a proven default.
- The smallest fixed `module` bundle that statically covers all 50 fixtures needs all toolsets
  except `context` (85 tools), a 2.6% descriptor reduction: cross-fixture static coverage forces
  almost the whole catalog back. Per-fixture module-oracle cover is far cheaper (p50 ~18 KB), so
  a per-task/host-native path — not a fixed server default — is where the saving lives.
- The offline Scope-negative matrix has 0 visibility leaks across 13 profiles x 4 Scope sets.
- `default-shrink-readiness` fails by design: static expected-tool membership is **not**
  end-to-end task success, and no agent harness ran. See
  `docs/review/tool-discovery/p2c-cost-gate/README.md` for commands, numbers and limits.

### Native order evidence (correction)

The cost gate no longer claims "native registration-order parity" by comparing the policy view to
`TOOL_NAMES`. It captures the **raw native wire order** from a real in-memory `tools/list`, drives
the real discovery-runtime filter for the `full` profile, and compares the output to the raw
descriptors in order with `deepEqual`. The report records **both** the immutable canonical
membership order (`TOOL_NAMES`) and the native wire order separately; the current tree has 52
positional mismatches between them (51 at the 86-tool catalog; inserting `read_archive_entry` after
`inspect_archive` shifts one more row). A permutation regression plus an order-digest check make
`catalog-integrity` fail on pure-policy-only or tampered-order evidence.

### Real-transport Scope-negative runtime matrix

`app/scripts/tool-discovery-runtime-matrix.mjs` drives the real MCP Streamable HTTP transport over
loopback with the real runtime and sentinel-wrapped handlers, across `full` / `core` /
`module:<toolset>` x four Scope sets plus missing-auth and no-scope negatives. It proves visibility
equals the independently computed Scope/profile wire list, 0 metadata leaks, 0 denied-handler
executions, fail-closed negatives, and per-request view recomputation. Artifacts live next to the
cost gate. This is **SDK/runtime transport evidence, not host evidence**: host deferral stays
`unknown` until a real installed host is driven.

Regenerate and verify:

```sh
cd app
node scripts/tool-discovery-cost-gate.mjs --write
node scripts/tool-discovery-cost-gate.mjs --verify
node scripts/tool-discovery-runtime-matrix.mjs --write
node scripts/tool-discovery-runtime-matrix.mjs --verify
node --test test/tool-discovery-cost-gate.test.js
node --test test/tool-discovery-runtime-matrix.test.js
```

### Artifact provenance — frozen evidence vs regenerable reports

`docs/review/tool-discovery/` mixes two kinds of artifact, and they must not be confused:

- **Frozen historical evidence (never regenerated):** `inventory.json` / `inventory.md` record the
  Wave 1 catalog (86 tools) exactly as it was served then. The tools/list contract tests compare the
  *current* served schemas against it with the canonical optional `vaultId` projected away, so a
  regeneration would silently widen that ratchet. `wave2-production/*` and `host-matrix/*` are live
  captures of a deployed server and of installed clients at a recorded commit; they cannot be
  re-created offline and their own `--verify` / `--check` cannot prove live origin.
- **Regenerable deterministic reports:** `p2c-cost-gate/*` and the runtime matrix are recomputed from
  the current worktree by `--write` and checked by `--verify` (and by the cost-gate test), including
  a content digest over everything except the informational source block. Keep them in sync with the
  tree; do not hand-edit them.

At the multi-Vault Wave F2 base (`ad892d99`) all four checks pass on the current tree —
`cost-gate --verify` (87 tools, gate `hold`), `runtime-matrix --verify` (gate `pass`),
`probe-host-tool-discovery --check` (7 hosts, 6 static-scan digests recomputed) and
`tool-discovery-production-eval --verify` (local tools 87) — so no artifact was regenerated in that
slice; the counts that differ between artifacts (85/86/87) come from those different snapshots, not
from drift.


## MCP Interface v2 — experimental compact profile (Issue #598)

This change provides a **server-operator opt-in**: set `MCP_DISCOVERY_PROFILE=compact`
to show a smaller, synthesized native-schema-preserving MCP catalog. The
default remains `full` (all 87 original tools); no production setting is changed
by this PR. Unknown/invalid profiles still fail back to `full` by the existing
operator parser. There is no client-selected profile override.

The underlying 87 tools are still registered and remain the only executing
handlers. `tools/list` presents compact descriptors grouped by capability domain;
`tools/call` accepts a virtual group name and:

```json
{
  "name": "obsidian_read_read",
  "arguments": {
    "action": "get_note",
    "params": { "path": "Projects/README.md", "vaultId": "vault" }
  }
}
```

The example group name is generated from the actual source descriptors; groups
are split whenever required Scope or normalized MCP annotations differ. The
current native inventory is expected to yield **34 visible entries at full
Scope**, instead of forcing 26 semantically mixed groups. `agent_bootstrap`
and `server_info` retain their original names and input/output schemas.

The HTTP authorization gate projects each virtual call to its **original action**
when checking required Scope and selected Vault. The discovery dispatcher
independently rechecks each currently authorized, non-denied action before it
delegates the original validated parameters to the original SDK handler. The
existing temporal AuthZ, Vault runtime, author stamping, history, journal,
versioning, and output schema remain the canonical implementation. Invalid
groups/hidden actions return the existing unknown-tool error shape.

Compact descriptors use a JSON Schema `oneOf` with a different native
`inputSchema` for each named action; a host incapable of faithfully handling
this schema **must remain on `full`**. There is no cross-host A/B evidence of
task-success gains in this PR. Smaller tool counts may not reduce total
descriptor tokens, because action-level schemas must remain available.
This is a compatibility-safe experiment, not permission to retire any legacy
tools or turn on compact production-wide.

Source and tests: `app/src/compact-tools.js`,
`app/test/compact-tools.test.js`, and
`app/test/discovery-runtime.test.js` (real Streamable HTTP). The detailed
contract and GO/HOLD gates are in Obsidian
`_Workspace/40-Projects/obsidian_mcp_server/MCP/DEVELOPMENT - MCP Interface v2 领域工具收敛与完整能力覆盖（2026-10-20）.md`.

### Host schema synchronization

A Host that caches the `tools/list` result keeps serving the schema it received.
The compact profile synthesizes descriptors from the live native catalog, so a
Host with a stale snapshot and a genuinely broken server both look the same from
the caller side: an `action.enum` that is missing a value. Issue #626 is that
case — a ChatGPT connector rejected `list_base_views` because its cached
`obsidian_read_read` enum still had the five pre-#613 values.

Every compact build therefore publishes a **schema fingerprint**: the SHA-256 of
the canonicalized descriptor list (object keys sorted, array order preserved,
which is the `oneOf` branch order), truncated to its first 16 hex characters.
It is reported in `server_info` as `discovery.compactSchemaFingerprint`
(additive; absent in every non-compact profile). It is a reconciliation value
only — never a scope, a policy input, or an authorization.

To reconcile after an upgrade:

1. Call `tools/list` (or read the Host's cached descriptor list) and compute the
   same digest: `sha256(canonicalJson(tools)).slice(0, 16)` with sorted object
   keys and preserved array order. `app/src/compact-descriptor-integrity.js`
   exports `canonicalJson` and `compactDescriptorFingerprint` for exactly this.
2. Compare it with `server_info.discovery.compactSchemaFingerprint`.
   - **Equal** — the cached schema is the served schema.
   - **Different** — either the Host is holding an older snapshot, or the two
     views are not the same view. Compare the same credential and profile: an
     operator `denyTools` or a narrower Scope also removes a branch (and changes
     the fingerprint). `discovery.canonicalVisibleToolCount ==
     discovery.catalogToolCount` together with `hiddenByScope: 0` and
     `hiddenByPolicy: 0` proves nothing was trimmed at the transport/policy
     layer, so a remaining difference is a stale Host snapshot. Reconnect or
     refresh the connector so it re-runs `initialize` + `tools/list`, then
     compare again.
3. If the digests match and a specific `action` is still rejected, the fault is
   in the descriptor itself. `checkCompactDescriptorIntegrity({ tools, routing })`
   from the same module reports every violation by name: `oneOf` branch count vs
   routed members, branch set vs `properties.action.enum`, duplicate branches,
   and each group's `groupMembers` vs `exposedActions` reading.

Reference values on this tree (commit `846c622b`, `MCP_DISCOVERY_PROFILE=compact`,
full Scope, real Streamable HTTP): 34 descriptors, 88 routed actions,
`obsidian_read_read` = 6 branches (`get_note`, `get_metadata`, `get_canvas`,
`get_base`, `query_base`, `list_base_views`), `obsidian_read_read_external` = 1
branch (`get_note_context`), fingerprint `4628724f7f2ed2bb`.

Group membership is an equation, not a name match: a group is split into several
descriptors whenever the required Scope or the normalized MCP annotations differ
(`obsidian_read` = 7 members = 6 + 1 branches), so only the **sum over a group's
descriptors** equals the group member count.

Not verified: the behavior of any specific Host's cache. This repository can
observe its own wire and a client on this machine; it cannot read the ChatGPT
connector's stored descriptor, so "reconnect and re-compare" is the documented
recovery path and not a tested one.

The layers are separable and must be separated before blaming a Host. On this
tree the same 5-branch enum is reachable **from the server side** with
`MCP_DISCOVERY_DENY_TOOLS=list_base_views` (34 descriptors,
`obsidian_read_read` = 5 branches, `canonicalVisibleToolCount` 88 → 87,
`hiddenByPolicy` 1, fingerprint `11cb48ced918e6a2`). So "the wire has 6 branches"
alone does not clear the transport/policy layer; the discriminator is the
caller's own `hiddenByScope` / `hiddenByPolicy` / `canonicalVisibleToolCount`
reading, which is `0 / 0 / 88` on production.
