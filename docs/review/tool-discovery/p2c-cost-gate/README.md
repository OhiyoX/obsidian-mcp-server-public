# Progressive Tool Discovery — Phase 2C eval & cost gate

Status: **candidate** (branch artifact). Default production profile stays `full`. Not merged,
not released, not deployed.

Source commit: `9a99a5a758ec8117ed18a739819c874cd4d610c6` (baseline `main`).
Artifacts: `cost-gate.json` / `cost-gate.md` (generated) + `app/scripts/tool-discovery-cost-gate.mjs`.

## What this slice is

A deterministic, offline evaluation of the already-implemented static discovery profiles
(`full` / `core` / `module`, PR #55 / #110) against the frozen 50 task fixtures. It measures:

- schema/cost of each profile's visible native `tools/list` descriptors;
- static critical-tool coverage (fixture `expectedTools`);
- annotation/Scope-derived wrong/missing-tool **exposure**;
- an authorization x profile Scope-negative matrix with leak detection; and
- an **actual wired-runtime parity check**: the real discovery-runtime `tools/list` output for the
  `full` profile is compared, in order and deep-equal, with the raw native `tools/list` descriptors.

It changes no registration, no visibility default, no Scope truth, and no Vault behavior. It does
**not** rebuild the historical inventory or the capability catalog; both stay as-is and are only
read as inputs.

The Wave 1 inventory remains immutable historical evidence. Later backward-compatible input-schema
widenings are declared narrowly in `app/src/tool-schema-compat.js`: baseline checks project only the
explicitly allowed keyword back to its historical value before comparing the full canonical schema.
Any other schema drift still fails the inventory/parity gates.

### Native wire order vs canonical membership order (correction)

An earlier revision of this slice compared the full *policy* view (itself derived from
`TOOL_NAMES`) to `TOOL_NAMES` and labelled that "native registration-order parity". That was
circular evidence: it never observed the native wire order, and `buildLocalCatalog()` in the
historical helper sorts descriptors alphabetically. The current harness:

- captures the **raw native** `tools/list` handshake in SDK registration order (never sorted);
- drives the real `createDiscoveryRuntimePolicy` + `registerObsidianCapabilities` path and compares
  the `full`-profile output to those raw descriptors with `deepEqual`, in order;
- records **both** orders distinctly: `catalog.canonicalMembershipOrder` (`TOOL_NAMES`, used by
  `server_info.tools` and Scope tables) and `catalog.nativeRegistrationOrder` (the wire order). The
  two currently differ positionally (51 mismatches); that is recorded, not hidden.
- proves order preservation with a permutation regression (`applyViewToNativeDescriptors`) and makes
  `catalog-integrity` fail on pure-policy-only or tampered-order evidence.

That native-order correction itself did not change costs. The current tree later widens the six plan/compare `maxDiffChars` minima from 1000 to 1; the current metrics below include that backward-compatible schema change.

## Gate decision: `hold`

| Check | Result |
| --- | --- |
| `catalog-integrity` (raw native wire order captured; full-profile wired output deep-equals it) | pass — 86 tools, 51 positional mismatches vs canonical membership recorded |
| `full-passthrough` (full hides nothing, critical recall 1.0) | pass |
| `no-scope-escalation` (profile x Scope visibility leaks) | pass — 0 leaks |
| `historical-inventory-preserved` | pass — all 85 inventory tools still registered |
| `fixture-contract` | pass — 50 valid fixtures |
| `static-coverage-expressible` | pass — a fixed module bundle can cover every expected tool |
| `baseline-limit-disclosed` | pass |
| `default-shrink-readiness` | **fail** — requires end-to-end task-success evidence |

**Decision: `hold`; production default remains `full`.** Static expected-tool coverage is
explicitly not task success, so it cannot justify shrinking the production default.

## Results (current tree)

- Native catalog: **86 tools**, descriptor **142,736 bytes** (~35,684 est. tokens),
  inputSchema 29,939 bytes, outputSchema 64,503 bytes.
- Historical inventory: 85 tools; additive since the fixture baseline: `get_note_context`.
- `full`: 86 tools, 0 hidden, critical recall 100%.
- `core` (the frozen six-tool seed): 6 tools, critical recall **24.1%** (14/58 expected refs),
  only **8/50** fixtures fully covered, **44** missing critical refs. Cost 15,110 bytes
  (~89.4% less than full) — cheap but not sufficient.
- **Best fixed module bundle**: every toolset except `context` (10 toolsets, 85 tools,
  139,047 bytes) is needed to statically cover all 50 fixtures, a **2.6%** descriptor reduction.
  Across-fixture static coverage forces almost the whole catalog back.
- Module oracle (per-fixture toolset union, upper bound, not a deployable policy): all fixtures
  expressible; per-fixture cover descriptor bytes min 3,498 / p50 18,070 / p95 27,305 / max 28,604.
  Per-task loading is where the real cost saving lives; a single fixed default is not.
- Scope-negative matrix: **0 visibility leaks** across 13 profiles x 4 Scope sets (52 rows).

## Runtime Scope-negative matrix (real MCP transport)

The offline Scope matrix above is a pure-policy check. `app/scripts/tool-discovery-runtime-matrix.mjs`
adds a **real MCP Streamable HTTP** harness over loopback with the real discovery runtime and
sentinel-wrapped handlers. It drives `full`, `core` and every `module:<toolset>` profile across four
Scope sets plus negatives, and proves:

- visibility equals an **independently computed** expected wire list built from `src/scopes.js` and
  `CORE_TOOL_NAMES` / `TOOLSET_TOOLS` (not from the runtime policy function);
- **0 structural metadata leaks** and 0 hidden names in the returned `tools/list` payload;
- **0 denied-handler executions**: the matrix only calls expected-hidden tools, and the sentinel
  counter stays empty; denied results also carry no descriptor metadata;
- missing auth context and empty scopes both fail closed (0 tools);
- the view is recomputed per request (all -> read -> all within one session, matching the expected
  reduction/restoration for each profile).

Artifacts: `runtime-matrix.json` / `runtime-matrix.md` (generated). This is **SDK/runtime transport
evidence, not host evidence**, and it uses a test auth middleware (header -> `authInfo.scopes`), not
production authentication. It also reports the documented read-only-annotation vs write-Scope
mismatch census without changing the frozen fixtures or Scope truth.

## How to reproduce

```sh
cd app
node scripts/tool-discovery-cost-gate.mjs            # human-readable report
node scripts/tool-discovery-cost-gate.mjs --json     # full machine report
node scripts/tool-discovery-cost-gate.mjs --write    # regenerate cost-gate.json + cost-gate.md
node scripts/tool-discovery-cost-gate.mjs --verify   # offline recompute + checked-in digest + md gate
node scripts/tool-discovery-runtime-matrix.mjs --write   # regenerate runtime-matrix.json + .md
node scripts/tool-discovery-runtime-matrix.mjs --verify  # real-transport recompute + digest + md gate
node --test test/tool-discovery-cost-gate.test.js
node --test test/tool-discovery-runtime-matrix.test.js
```

The reports are deterministic: `contentDigest` covers everything except the informational `source`
block, so any catalog/fixture/policy/gate change fails `--verify` until the artifact is regenerated.
`--verify` also re-renders the Markdown and fails on a hand-edited or stale `.md`. The `.md`
comparison folds CRLF to LF so a Windows `core.autocrlf=true` checkout of the committed LF blob
verifies unchanged; every other edit (trailing whitespace, a changed word, an appended line, a
leading BOM, or a missing/extra final newline) still fails. `source.commit` is
labelled informational (`commitIsInformational: true`, `exactSourceSha: null`): it is the
pre-generation HEAD and is never claimed to be an exact source digest.

## Honest limits

- **No agent harness.** End-to-end task success, tool-selection precision/recall, wrong-tool
  selection rate and discovery rounds are `unmeasured`. `criticalToolRecall` is deterministic set
  membership, not success; annotation-based counts are exposure, not an observed selection rate.
- **Token figures are byte/4 estimates.** No tokenizer ran.
- **No fabricated taxonomy.** Fixtures declare `forbiddenToolCategories`, but the runtime has no
  canonical category→tool mapping, so it is reported `unmeasured` rather than invented.
- **Fixture baseline is the 85-tool era.** The fixtures were authored against
  `inventory.json` (85 tools). Later tools such as `get_note_context` are additive and are not
  referenced by any fixture; that is a fixture coverage gap, not evidence about the tool.
  16 current tools are unreferenced and listed explicitly.
- **Offline only.** No live server, no `tools/call`, no Vault, no latency, no deployed
  Scope-enforcement probe.
- **Runtime matrix is SDK transport, not host.** The real-transport matrix proves server/runtime
  behavior over loopback; it does not prove that any installed host defers tool loading, searches
  for tools, or refreshes its list. Host cells remain `unknown` until a real host is driven. It uses
  a test auth middleware, so it also does not prove production OAuth/Scope derivation.
- **Scope matrix** shows `expectedRefsHiddenByAuthorization`: reduced-scope callers correctly
  lose tools. That is authorization behavior, not a discovery miss.

## Next action

Do not shrink the production default from this slice. The next evidence needed is Phase 3
host-native progressive disclosure: drive a real host against an isolated scratch server, record
the tool list actually delivered to the model, and measure task success/latency. Only after that
does a non-`full` default become a candidate. Server-side dynamic `tools/list`, `list_changed`,
`discover_tools` and a global mutable registry remain out of scope.
