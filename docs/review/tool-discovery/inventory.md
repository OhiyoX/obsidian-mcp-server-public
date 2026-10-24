# MCP tool inventory — Progressive Tool Discovery Phase 0

Status: **characterization only** (candidate). This report describes the current eager,
always-visible MCP tool catalog. It does **not** implement progressive discovery,
dynamic loading, or any change to registration, authorization, or runtime behavior.

Role: a checked-in copy of this report and `inventory.json` is a **historical evidence snapshot**,
not a byte-for-byte gate. `node scripts/tool-inventory.mjs --check` does not require the snapshot
to match a later generation. It asserts monotonic compatibility against `inventory.json`:
the live tool-name set is a superset, derived risk is not downgraded, required scopes are not
removed, and destructive / idempotent / open-world hints are not weakened.

- Baseline: current main `44e3828e6f38c953464580ed3b135cf771ae1912` (85 tools).
- Tools captured: **86** (unique: 86; missing vs `TOOL_NAMES`: 0; extra: 0).
- Total input-schema bytes: **29,668** (UTF-8, canonical JSON).
- Total output-schema bytes: **67,098**.
- Registration order matches `TOOL_NAMES`: **false**.
  - `tools/list` order follows the `registerObsidianCapabilities` registration sequence (info, notes, search, files, links, workflows, git, intelligence, publish, plans); it is a different order from the `TOOL_NAMES` constant. Parity below is asserted on the name **set**, and this report sorts rows by `TOOL_NAMES` for stable comparison.

## Regeneration

From the repository root, on Node 20+ (validated on Node 24.16 and Node 26.3; `engines` requires >=20). Python 3 is not required by this generator:

```sh
cd app && npm ci
cd .. && node scripts/tool-inventory.mjs            # rewrite the evidence snapshot (not the gate)
node scripts/tool-inventory.mjs --check             # monotonic compatibility; does not write
node scripts/tool-inventory.mjs --stdout            # print one generation; does not write
node --test scripts/tool-inventory.test.mjs         # focused generator test
```

`--check` regenerates in memory and asserts monotonic compatibility against the frozen `inventory.json`. It does not compare these files byte-for-byte and it never writes. Two `--stdout` runs on the same tree are byte-identical; that identity is the generator's determinism check, not a requirement that the snapshot match a later catalog. The generator reads `app/` source only and never mutates the server or Vault.

## Method and evidence source per field

| Field | Evidence source |
| --- | --- |
| `annotations` | runtime `tools/list` response: annotations completed by `app/src/tool-contracts.js` `completeToolAnnotations` |
| `domain` | unknown: no canonical catalog/toolset taxonomy is implemented yet (Progressive Tool Discovery Phase 1); source module is reported instead |
| `inputSchema` | runtime `tools/list` response: the SDK-computed JSON Schema (draft-07 via zod v4, strictUnions, pipeStrategy=input); canonicalized for byte measurement |
| `module` | source evidence: which `app/src/tools/*.js` `register*Tools` function calls `server.registerTool(name, ...)` |
| `name` | runtime `tools/list` response captured from the production registration path over an in-process MCP transport |
| `outputContract` | runtime `tools/list` response `outputSchema`: derived from `app/src/tool-contracts.js` `outputSchemaForTool` |
| `scope` | source evidence: `app/src/scopes.js` `MCP_TOOL_SCOPE_REQUIREMENTS` (authorization truth; not carried in `tools/list`) |

### Byte measurement

- State: canonical JSON text of the `tools/list` inputSchema.
- Encoding: UTF-8.
- Canonicalization: recursive lexicographic object-key sort; JSON.stringify with no insignificant whitespace.
- Measurement: `Buffer.byteLength(canonicalJson, 'utf8')`.
- Digest: sha256 hex over the canonical JSON text.

Toolchain: MCP SDK `1.30.0`, zod `4.5.2`, JSON Schema dialect `http://json-schema.org/draft-07/schema#`.

## Visibility and authorization baseline

- `registerObsidianCapabilities` registers all 86 tools unconditionally; `tools/list` is not filtered by Scope, Vault allowlist, or `OBSIDIAN_READ_ONLY` in current source.
- Scope is enforced per `tools/call` (`app/src/auth.js` `requestedScopes` -> `requiredScopesForTools`), and `OBSIDIAN_READ_ONLY` rejects mutations at execution time (`app/src/vault.js`). A caller can therefore see a tool in `tools/list` and still be denied when calling it.
- Any future Progressive Tool Discovery must preserve this separation: visibility is not authorization.

## Counts

### By source module

| Module | Tools |
| --- | ---: |
| `tools/files.js` | 16 |
| `tools/intelligence.js` | 13 |
| `tools/links.js` | 13 |
| `tools/workflows.js` | 13 |
| `tools/plans.js` | 9 |
| `tools/notes.js` | 8 |
| `tools/git.js` | 6 |
| `tools/search.js` | 4 |
| `tools/info.js` | 2 |
| `tools/publish.js` | 2 |

### By risk (derived from annotations)

| Risk | Tools |
| --- | ---: |
| read-only | 51 |
| destructive | 28 |
| mutating | 7 |

Risk derivation: `read-only` = `readOnlyHint === true`; `destructive` = `destructiveHint === true`; otherwise `mutating`. MCP does not define a `risk` field.

### By open-world hint

| Hint | Tools |
| --- | ---: |
| closed-world | 76 |
| open-world | 10 |

### By individual Scope

| Scope | Tools |
| --- | ---: |
| `obsidian.read` | 86 |
| `obsidian.write` | 34 |
| `obsidian.files` | 13 |

### By Scope set

| Scope set | Tools |
| --- | ---: |
| `obsidian.read` | 46 |
| `obsidian.read+obsidian.write` | 27 |
| `obsidian.read+obsidian.write+obsidian.files` | 7 |
| `obsidian.read+obsidian.files` | 6 |

## Inventory

| # | Tool | Module | Scope | Risk | In bytes | Out fields (req/opt) |
| ---: | --- | --- | --- | --- | ---: | ---: |
| 1 | `agent_bootstrap` | `tools/info.js` | `obsidian.read` | read-only | 739 | 13/1 |
| 2 | `server_info` | `tools/info.js` | `obsidian.read` | read-only | 85 | 5/8 |
| 3 | `get_note` | `tools/notes.js` | `obsidian.read` | read-only | 399 | 1/14 |
| 4 | `pull_note_file` | `tools/files.js` | `obsidian.read, obsidian.files` | read-only | 296 | 3/7 |
| 5 | `get_metadata` | `tools/notes.js` | `obsidian.read` | read-only | 143 | 3/0 |
| 6 | `list_notes` | `tools/search.js` | `obsidian.read` | read-only | 604 | 3/1 |
| 7 | `list_files` | `tools/files.js` | `obsidian.read` | read-only | 506 | 4/1 |
| 8 | `list_recent` | `tools/search.js` | `obsidian.read` | read-only | 181 | 3/0 |
| 9 | `search_notes` | `tools/search.js` | `obsidian.read` | read-only | 1547 | 10/2 |
| 10 | `get_file` | `tools/files.js` | `obsidian.read, obsidian.files` | read-only | 415 | 5/2 |
| 11 | `pull_file` | `tools/files.js` | `obsidian.read, obsidian.files` | read-only | 205 | 10/0 |
| 12 | `write_file` | `tools/files.js` | `obsidian.read, obsidian.write` | destructive | 434 | 9/0 |
| 13 | `start_file_upload` | `tools/files.js` | `obsidian.read, obsidian.write, obsidian.files` | destructive | 378 | 10/1 |
| 14 | `file_upload_status` | `tools/files.js` | `obsidian.read, obsidian.files` | read-only | 332 | 10/0 |
| 15 | `upload_file_chunk` | `tools/files.js` | `obsidian.read, obsidian.write, obsidian.files` | destructive | 490 | 2/8 |
| 16 | `cancel_file_upload` | `tools/files.js` | `obsidian.read, obsidian.write, obsidian.files` | destructive | 332 | 2/2 |
| 17 | `create_archive` | `tools/files.js` | `obsidian.read, obsidian.write, obsidian.files` | destructive | 368 | 9/0 |
| 18 | `inspect_archive` | `tools/files.js` | `obsidian.read, obsidian.files` | read-only | 143 | 9/0 |
| 19 | `read_archive_entry` | `tools/files.js` | `obsidian.read, obsidian.files` | read-only | 281 | 12/1 |
| 20 | `extract_archive` | `tools/files.js` | `obsidian.read, obsidian.write, obsidian.files` | destructive | 301 | 5/7 |
| 21 | `get_canvas` | `tools/files.js` | `obsidian.read` | read-only | 143 | 4/0 |
| 22 | `write_canvas` | `tools/files.js` | `obsidian.read, obsidian.write` | destructive | 546 | 5/0 |
| 23 | `write_note` | `tools/notes.js` | `obsidian.read, obsidian.write` | mutating | 480 | 9/0 |
| 24 | `append_to_note` | `tools/notes.js` | `obsidian.read, obsidian.write` | mutating | 296 | 6/0 |
| 25 | `patch_note` | `tools/notes.js` | `obsidian.read, obsidian.write` | destructive | 541 | 11/0 |
| 26 | `replace_in_note` | `tools/notes.js` | `obsidian.read, obsidian.write` | destructive | 671 | 9/0 |
| 27 | `manage_frontmatter` | `tools/notes.js` | `obsidian.read, obsidian.write` | mutating | 377 | 3/0 |
| 28 | `list_tags` | `tools/search.js` | `obsidian.read` | read-only | 195 | 2/1 |
| 29 | `manage_tags` | `tools/notes.js` | `obsidian.read, obsidian.write` | mutating | 407 | 5/0 |
| 30 | `move_note` | `tools/links.js` | `obsidian.read, obsidian.write` | destructive | 308 | 2/0 |
| 31 | `delete_note` | `tools/links.js` | `obsidian.read, obsidian.write` | destructive | 214 | 3/0 |
| 32 | `list_trash` | `tools/links.js` | `obsidian.read` | read-only | 183 | 2/0 |
| 33 | `restore_from_trash` | `tools/links.js` | `obsidian.read, obsidian.write` | destructive | 284 | 5/0 |
| 34 | `delete_trash_entry` | `tools/links.js` | `obsidian.read, obsidian.write` | destructive | 155 | 1/0 |
| 35 | `list_versions` | `tools/links.js` | `obsidian.read` | read-only | 209 | 2/0 |
| 36 | `restore_version` | `tools/links.js` | `obsidian.read, obsidian.write` | destructive | 260 | 4/0 |
| 37 | `delete_version` | `tools/links.js` | `obsidian.read, obsidian.write` | destructive | 153 | 1/0 |
| 38 | `manage_folders` | `tools/files.js` | `obsidian.read, obsidian.write` | destructive | 255 | 0/5 |
| 39 | `get_backlinks` | `tools/links.js` | `obsidian.read` | read-only | 143 | 2/0 |
| 40 | `get_graph` | `tools/links.js` | `obsidian.read` | read-only | 184 | 4/0 |
| 41 | `get_unresolved_links` | `tools/links.js` | `obsidian.read` | read-only | 236 | 3/0 |
| 42 | `get_orphans` | `tools/links.js` | `obsidian.read` | read-only | 183 | 3/0 |
| 43 | `get_deadends` | `tools/links.js` | `obsidian.read` | read-only | 183 | 3/0 |
| 44 | `list_tasks` | `tools/workflows.js` | `obsidian.read` | read-only | 295 | 3/0 |
| 45 | `update_task` | `tools/workflows.js` | `obsidian.read, obsidian.write` | destructive | 383 | 5/2 |
| 46 | `daily_note` | `tools/workflows.js` | `obsidian.read, obsidian.write` | mutating | 320 | 2/9 |
| 47 | `list_templates` | `tools/workflows.js` | `obsidian.read` | read-only | 204 | 2/1 |
| 48 | `create_from_template` | `tools/workflows.js` | `obsidian.read, obsidian.write` | mutating | 387 | 5/0 |
| 49 | `list_properties` | `tools/workflows.js` | `obsidian.read` | read-only | 195 | 3/0 |
| 50 | `list_aliases` | `tools/workflows.js` | `obsidian.read` | read-only | 213 | 3/0 |
| 51 | `rename_property` | `tools/workflows.js` | `obsidian.read, obsidian.write` | destructive | 411 | 6/0 |
| 52 | `set_property_type` | `tools/workflows.js` | `obsidian.read, obsidian.write` | destructive | 302 | 3/1 |
| 53 | `list_bases` | `tools/workflows.js` | `obsidian.read` | read-only | 183 | 2/0 |
| 54 | `get_base` | `tools/workflows.js` | `obsidian.read` | read-only | 143 | 5/0 |
| 55 | `write_base` | `tools/workflows.js` | `obsidian.read, obsidian.write` | destructive | 310 | 4/0 |
| 56 | `query_base` | `tools/workflows.js` | `obsidian.read` | read-only | 222 | 6/3 |
| 57 | `git_status` | `tools/git.js` | `obsidian.read` | read-only | 85 | 5/0 |
| 58 | `git_diff` | `tools/git.js` | `obsidian.read` | read-only | 232 | 4/0 |
| 59 | `git_log` | `tools/git.js` | `obsidian.read` | read-only | 150 | 1/0 |
| 60 | `git_commit` | `tools/git.js` | `obsidian.read, obsidian.write` | destructive | 371 | 2/6 |
| 61 | `git_pull` | `tools/git.js` | `obsidian.read, obsidian.write` | destructive | 138 | 5/0 |
| 62 | `git_push` | `tools/git.js` | `obsidian.read, obsidian.write` | destructive | 138 | 5/0 |
| 63 | `index_status` | `tools/intelligence.js` | `obsidian.read` | read-only | 133 | 9/1 |
| 64 | `reindex_vault` | `tools/intelligence.js` | `obsidian.read` | mutating | 174 | 2/6 |
| 65 | `recall` | `tools/intelligence.js` | `obsidian.read` | read-only | 660 | 6/0 |
| 66 | `find_related` | `tools/intelligence.js` | `obsidian.read` | read-only | 254 | 4/0 |
| 67 | `graph_health` | `tools/intelligence.js` | `obsidian.read` | read-only | 235 | 6/1 |
| 68 | `suggest_links` | `tools/intelligence.js` | `obsidian.read` | read-only | 253 | 4/0 |
| 69 | `memory_capture` | `tools/intelligence.js` | `obsidian.read, obsidian.write` | destructive | 789 | 3/0 |
| 70 | `memory_recall` | `tools/intelligence.js` | `obsidian.read` | read-only | 378 | 6/0 |
| 71 | `skill_list` | `tools/intelligence.js` | `obsidian.read` | read-only | 199 | 3/0 |
| 72 | `skill_match` | `tools/intelligence.js` | `obsidian.read` | read-only | 320 | 5/0 |
| 73 | `skill_validate` | `tools/intelligence.js` | `obsidian.read` | read-only | 143 | 3/6 |
| 74 | `skill_export` | `tools/intelligence.js` | `obsidian.read, obsidian.write, obsidian.files` | destructive | 224 | 12/0 |
| 75 | `skill_import` | `tools/intelligence.js` | `obsidian.read, obsidian.write, obsidian.files` | destructive | 200 | 8/3 |
| 76 | `get_publish_status` | `tools/publish.js` | `obsidian.read` | read-only | 185 | 5/3 |
| 77 | `manage_publish` | `tools/publish.js` | `obsidian.read, obsidian.write` | destructive | 249 | 6/3 |
| 78 | `plan_note_changes` | `tools/plans.js` | `obsidian.read` | read-only | 1725 | 7/0 |
| 79 | `plan_move_note` | `tools/plans.js` | `obsidian.read` | read-only | 465 | 7/0 |
| 80 | `plan_delete_note` | `tools/plans.js` | `obsidian.read` | read-only | 371 | 7/0 |
| 81 | `plan_restore_version` | `tools/plans.js` | `obsidian.read` | read-only | 417 | 7/0 |
| 82 | `plan_restore_from_trash` | `tools/plans.js` | `obsidian.read` | read-only | 469 | 7/0 |
| 83 | `get_note_plan` | `tools/plans.js` | `obsidian.read` | read-only | 328 | 7/0 |
| 84 | `apply_note_plan` | `tools/plans.js` | `obsidian.read, obsidian.write` | destructive | 464 | 7/0 |
| 85 | `get_note_version` | `tools/plans.js` | `obsidian.read` | read-only | 232 | 8/0 |
| 86 | `compare_note_versions` | `tools/plans.js` | `obsidian.read` | read-only | 1334 | 9/0 |

## Values that cannot be extracted without a real `tools/list`

The authoritative wire shape (`inputSchema`, `outputSchema`, completed `annotations`,
`title`, `description`, `execution`) is produced by the MCP SDK from the registered
zod schemas. A raw source registry or the `inputSchema` raw shape alone would not give
reproducible byte counts, because the SDK converts zod to JSON Schema and completes
annotation defaults. This report therefore captures a **real `tools/list` response**,
generated in-process from the production registration path.

Remaining gaps and unknowns:

- **domain / toolset** (unknown): No canonical capability-catalog taxonomy exists in the runtime (planned Phase 1). The source registration module is reported as a proxy.
- **production deployment tools/list** (unknown): This baseline is a real in-process `tools/list` from current main. It is not a response captured from the deployed NAS process, so deployment drift, host tool filtering, and client-specific visibility are not proven here.

Derived fields:

- **risk**: MCP has no `risk` field. Risk is derived deterministically from the four standard annotation hints (read-only / destructive / mutating); it is not an independent runtime claim.

Additionally, a real *deployed* `tools/list` could differ from this local capture if the NAS checkout drifts from the tagged commit. This report does not claim production-verified parity.

## Determinism

The checked-in `inventory.json` and this report contain no timestamps or git revision identifiers and sort all object keys. They are a frozen historical snapshot. Regeneration on the same commit and lockfile is byte-identical with itself (`--stdout` twice), but that identity does not require this snapshot to match a later catalog. `node scripts/tool-inventory.mjs --check` enforces monotonic compatibility, not byte equality with this file.
