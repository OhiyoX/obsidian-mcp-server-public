# Progressive Tool Discovery — Phase 2C eval & cost gate

Status: **candidate** (offline, deterministic branch artifact). Default production profile stays `full`.
Source commit: `d2bdabe43c78909d5eb3a20ff8b7ba04e471d6f6`.

This slice is evaluation/evidence only. It changes no registration, no visibility default,
no Scope truth, and no Vault behavior. It reuses the frozen 50 task fixtures and the native
in-memory `tools/list` descriptors; it does not rebuild the inventory or catalog.

## Gate decision

**Decision: `hold`** — production default remains `full`.

| Check | Result | Detail |
| --- | --- | --- |
| `catalog-integrity` | pass | native catalog 90 tools; TOOL_NAMES 90; wired full-profile output deep-equals raw native descriptors in order=true; native wire order positional mismatches vs canonical membership=54 (informational: membership order and wire order are distinct and both recorded) |
| `full-passthrough` | pass | full hides 0 tools; critical recall 1 |
| `no-scope-escalation` | pass | scope x profile rows with a visibility leak: 0 |
| `historical-inventory-preserved` | pass | all 86 historical inventory tools still registered |
| `fixture-contract` | pass | fixtures valid=true, count=50 |
| `static-coverage-expressible` | pass | best fixed module bundle statically covers every expected tool with 89/86 tools (2.2% descriptor reduction); single-toolset/core profiles do not |
| `default-shrink-readiness` | **fail** | HELD: the TODO requires end-to-end task-success (critical safety/recovery/auth) evidence before any production default shrink. This slice has no agent harness; static expected-tool coverage is explicitly not task success. Default stays `full`. |
| `baseline-limit-disclosed` | pass | additive tools: patch_base, create_base_entry, list_base_views, get_note_context; unreferenced tools: 20 |

Blockers:
- default-shrink-readiness: HELD: the TODO requires end-to-end task-success (critical safety/recovery/auth) evidence before any production default shrink. This slice has no agent harness; static expected-tool coverage is explicitly not task success. Default stays `full`.

## Catalog baseline

- Native catalog: **90** tools; descriptor 169895 bytes (~42474 est. tokens); inputSchema 41349 bytes; outputSchema 71912 bytes.
- Canonical membership order (`TOOL_NAMES`, `server_info.tools`, Scope tables): 90 names — **immutable membership order, not the wire order**.
- Native wire order (raw `tools/list`): positional mismatches vs canonical membership = **54**; set equality = `true`. The two orders are recorded separately; neither is inferred from the other.
- Wired runtime parity (full profile, all scopes): output deep-equals raw native descriptors in order = **true** (names true, descriptors true).
- Annotations: readOnly 53, destructive 29, mutating 8.
- Historical inventory: 86 tools; additive since fixture baseline: `patch_base`, `create_base_entry`, `list_base_views`, `get_note_context`.
- Fixture baseline: eager/full (TOOL_NAMES, 85 tools) (`44e3828e6f38c953464580ed3b135cf771ae1912`), 50 tasks.

## Profile cost x critical coverage

`criticalToolRecall` is deterministic set membership of fixture expectedTools, **not** task success.

| Profile | Visible | Hidden | Descriptor B | Est. tokens | Bytes saved | Critical recall | Fixtures fully covered | Missing critical refs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | 90 | 0 | 169895 | ~42474 | 0.0% | 100.0% | 50/50 | 0 |
| `core` | 6 | 84 | 17272 | ~4318 | 89.8% | 24.1% | 8/50 | 44 |
| `module:info` | 2 | 88 | 5476 | ~1369 | 96.8% | 10.3% | 2/50 | 52 |
| `module:notes` | 8 | 82 | 16690 | ~4173 | 90.2% | 19.0% | 7/50 | 47 |
| `module:search` | 4 | 86 | 9191 | ~2298 | 94.6% | 5.2% | 2/50 | 55 |
| `module:files` | 16 | 74 | 31616 | ~7904 | 81.4% | 8.6% | 5/50 | 53 |
| `module:links` | 13 | 77 | 16902 | ~4226 | 90.1% | 6.9% | 4/50 | 54 |
| `module:workflows` | 16 | 74 | 30909 | ~7728 | 81.8% | 8.6% | 5/50 | 53 |
| `module:git` | 6 | 84 | 8137 | ~2035 | 95.2% | 8.6% | 4/50 | 53 |
| `module:intelligence` | 13 | 77 | 24480 | ~6120 | 85.6% | 15.5% | 7/50 | 49 |
| `module:context` | 1 | 89 | 3793 | ~949 | 97.8% | 0.0% | 0/50 | 58 |
| `module:publish` | 2 | 88 | 3622 | ~906 | 97.9% | 5.2% | 3/50 | 55 |
| `module:plans` | 9 | 81 | 19079 | ~4770 | 88.8% | 12.1% | 7/50 | 51 |

### Wrong/missing-tool exposure (annotation/Scope derived, not a selection rate)

| Profile | readOnly visible | destructive visible | mutating visible | write-scoped visible | files-scoped visible |
| --- | --- | --- | --- | --- | --- |
| `full` | 53 | 29 | 8 | 36 | 13 |
| `core` | 6 | 0 | 0 | 0 | 0 |
| `module:info` | 2 | 0 | 0 | 0 | 0 |
| `module:notes` | 2 | 2 | 4 | 6 | 0 |
| `module:search` | 4 | 0 | 0 | 0 | 0 |
| `module:files` | 8 | 8 | 0 | 8 | 11 |
| `module:links` | 7 | 6 | 0 | 6 | 0 |
| `module:workflows` | 8 | 5 | 3 | 8 | 0 |
| `module:git` | 3 | 3 | 0 | 3 | 0 |
| `module:intelligence` | 9 | 3 | 1 | 3 | 2 |
| `module:context` | 1 | 0 | 0 | 0 | 0 |
| `module:publish` | 1 | 1 | 0 | 1 | 0 |
| `module:plans` | 8 | 1 | 0 | 1 | 0 |

## Module oracle (upper bound, not a deployment)

- All fixtures expressible by a toolset union: **true**.
- Per-fixture cover descriptor bytes: min 3622, p50 19079, p95 31616, max 31616.

## Best fixed module bundle (diagnostic optimizer)

- Toolsets: `info`, `notes`, `search`, `files`, `links`, `workflows`, `git`, `intelligence`, `publish`, `plans`.
- Omitted toolsets: `context`.
- Visible tools 89; descriptor 166102 bytes; descriptor reduction vs full 2.2%.

## Scope-negative matrix

- Visibility leaks across all profile x scope rows: **0** (must be 0).

| Profile | Scopes | Visible | Authorized | Leaks | Expected refs visible | Hidden by profile | Hidden by authorization |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | `read` | 48 | 48 | 0 | 40 | 0 | 18 |
| `full` | `read+files` | 54 | 54 | 0 | 42 | 0 | 16 |
| `full` | `read+write` | 77 | 77 | 0 | 53 | 0 | 5 |
| `full` | `all` | 90 | 90 | 0 | 58 | 0 | 0 |
| `core` | `read` | 6 | 48 | 0 | 14 | 26 | 18 |
| `core` | `read+files` | 6 | 54 | 0 | 14 | 28 | 16 |
| `core` | `read+write` | 6 | 77 | 0 | 14 | 39 | 5 |
| `core` | `all` | 6 | 90 | 0 | 14 | 44 | 0 |
| `module:info` | `read` | 2 | 48 | 0 | 6 | 34 | 18 |
| `module:info` | `read+files` | 2 | 54 | 0 | 6 | 36 | 16 |
| `module:info` | `read+write` | 2 | 77 | 0 | 6 | 47 | 5 |
| `module:info` | `all` | 2 | 90 | 0 | 6 | 52 | 0 |
| `module:notes` | `read` | 2 | 48 | 0 | 6 | 34 | 18 |
| `module:notes` | `read+files` | 2 | 54 | 0 | 6 | 36 | 16 |
| `module:notes` | `read+write` | 8 | 77 | 0 | 11 | 42 | 5 |
| `module:notes` | `all` | 8 | 90 | 0 | 11 | 47 | 0 |
| `module:search` | `read` | 4 | 48 | 0 | 3 | 37 | 18 |
| `module:search` | `read+files` | 4 | 54 | 0 | 3 | 39 | 16 |
| `module:search` | `read+write` | 4 | 77 | 0 | 3 | 50 | 5 |
| `module:search` | `all` | 4 | 90 | 0 | 3 | 55 | 0 |
| `module:files` | `read` | 2 | 48 | 0 | 1 | 39 | 18 |
| `module:files` | `read+files` | 8 | 54 | 0 | 3 | 39 | 16 |
| `module:files` | `read+write` | 5 | 77 | 0 | 1 | 52 | 5 |
| `module:files` | `all` | 16 | 90 | 0 | 5 | 53 | 0 |
| `module:links` | `read` | 7 | 48 | 0 | 4 | 36 | 18 |
| `module:links` | `read+files` | 7 | 54 | 0 | 4 | 38 | 16 |
| `module:links` | `read+write` | 13 | 77 | 0 | 4 | 49 | 5 |
| `module:links` | `all` | 13 | 90 | 0 | 4 | 54 | 0 |
| `module:workflows` | `read` | 8 | 48 | 0 | 2 | 38 | 18 |
| `module:workflows` | `read+files` | 8 | 54 | 0 | 2 | 40 | 16 |
| `module:workflows` | `read+write` | 16 | 77 | 0 | 5 | 48 | 5 |
| `module:workflows` | `all` | 16 | 90 | 0 | 5 | 53 | 0 |
| `module:git` | `read` | 3 | 48 | 0 | 4 | 36 | 18 |
| `module:git` | `read+files` | 3 | 54 | 0 | 4 | 38 | 16 |
| `module:git` | `read+write` | 6 | 77 | 0 | 5 | 48 | 5 |
| `module:git` | `all` | 6 | 90 | 0 | 5 | 53 | 0 |
| `module:intelligence` | `read` | 10 | 48 | 0 | 7 | 33 | 18 |
| `module:intelligence` | `read+files` | 10 | 54 | 0 | 7 | 35 | 16 |
| `module:intelligence` | `read+write` | 11 | 77 | 0 | 8 | 45 | 5 |
| `module:intelligence` | `all` | 13 | 90 | 0 | 9 | 49 | 0 |
| `module:context` | `read` | 1 | 48 | 0 | 0 | 40 | 18 |
| `module:context` | `read+files` | 1 | 54 | 0 | 0 | 42 | 16 |
| `module:context` | `read+write` | 1 | 77 | 0 | 0 | 53 | 5 |
| `module:context` | `all` | 1 | 90 | 0 | 0 | 58 | 0 |
| `module:publish` | `read` | 1 | 48 | 0 | 1 | 39 | 18 |
| `module:publish` | `read+files` | 1 | 54 | 0 | 1 | 41 | 16 |
| `module:publish` | `read+write` | 2 | 77 | 0 | 3 | 50 | 5 |
| `module:publish` | `all` | 2 | 90 | 0 | 3 | 55 | 0 |
| `module:plans` | `read` | 8 | 48 | 0 | 6 | 34 | 18 |
| `module:plans` | `read+files` | 8 | 54 | 0 | 6 | 36 | 16 |
| `module:plans` | `read+write` | 9 | 77 | 0 | 7 | 46 | 5 |
| `module:plans` | `all` | 9 | 90 | 0 | 7 | 51 | 0 |

## Fixture coverage by category (full profile)

| Category | Fixtures | Expected refs | Missing refs | Fully covered |
| --- | --- | --- | --- | --- |
| `note-read-write-metadata` | 7 | 9 | 0 | 7 |
| `search-recall` | 4 | 4 | 0 | 4 |
| `links-graph-tasks-templates-bases` | 9 | 9 | 0 | 9 |
| `files` | 4 | 4 | 0 | 4 |
| `memory-skills` | 5 | 6 | 0 | 5 |
| `git` | 4 | 4 | 0 | 4 |
| `publish` | 3 | 3 | 0 | 3 |
| `plan-apply-recovery` | 7 | 7 | 0 | 7 |
| `negative-authorization` | 4 | 6 | 0 | 4 |
| `bootstrap-context` | 3 | 6 | 0 | 3 |

## Baseline limits and honesty

- The 50 task fixtures were authored against the historical 85-tool catalog recorded in docs/review/tool-discovery/inventory.json. The current native catalog is larger; this slice does NOT rebuild the inventory or rewrite the fixtures.
- Any tool that appears after the fixture baseline (for example get_note_context) is additive: it is not referenced by any fixture, so its absence from per-fixture coverage is a fixture coverage gap, not evidence about the tool.
- Unreferenced tools are listed explicitly instead of being silently folded into a coverage percentage.
- Tools not referenced by fixtures (20): `file_upload_status`, `upload_file_chunk`, `cancel_file_upload`, `read_archive_entry`, `get_canvas`, `write_canvas`, `delete_note`, `delete_trash_entry`, `delete_version`, `manage_folders`, `get_deadends`, `set_property_type`, `write_base`, `patch_base`, `create_base_entry`, `list_base_views`, `git_pull`, `git_push`, `get_note_context`, `skill_import`.

### Metric semantics

- `staticCoverageIsNotSuccess`: true
- `criticalToolRecall`: Deterministic set membership: fixture expectedTools present in a profile's visible names. This is NOT end-to-end task success and was not produced by a model.
- `wrongToolRisk`: Counts of visible destructive/mutating-annotated and write-scoped tools (annotation/Scope-derived exposure). This is NOT an observed wrong-tool selection rate; no model ran.
- `estimatedTokens`: ceil(utf8 bytes / 4). A coarse byte/4 English heuristic; NO tokenizer was run, so this is an estimate only.
- `schemaCost`: utf8 bytes of JSON.stringify of the native descriptor / inputSchema / outputSchema from an in-memory client.listTools() handshake.
- `forbiddenToolCategories`: Unmeasured: fixtures declare forbidden tool categories, but no canonical category->tool mapping exists in the runtime. No mapping was invented for this slice.

### Unmeasured

- end-to-end agent task success (no model/agent harness in this slice)
- observed tool-selection precision/recall and wrong-tool selection rate
- latency (intentionally not captured)
- real tokenizer counts (only byte/4 estimates)
- forbiddenToolCategories -> tool mapping (no canonical runtime mapping; not invented)
- host/client deferred loading behavior (Phase 3 live host evidence)
- deployed-server scope enforcement (needs a scope-limited credential)

Content digest (excludes `source`): `3700672786e430544c7a0a3185c6fabd36bbdabfe4972ca79c17a795f5dcdc40` (110059 bytes).

