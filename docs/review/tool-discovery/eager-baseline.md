# Progressive Tool Discovery — Phase 0 eager task baseline

Status: **candidate** (branch `wave1/progressive-eager`, based on main `44e3828e6f38c953464580ed3b135cf771ae1912`).
Scope: characterization only. No runtime behavior, tool registration, authorization, or catalog visibility changes.

## Purpose

Phase 0 freezes a reproducible baseline of the **eager/full MCP catalog** (today's behavior) so later
Progressive Tool Discovery work can be compared against it. This slice establishes:

1. a representative natural-language task fixture set covering the current 85-tool catalog;
2. a deterministic, read-only measurement entry point that reports catalog and schema sizes;
3. focused tests that keep the fixture set and the runner honest.

The eager catalog still exposes every tool of `TOOL_NAMES` through `tools/list`. Nothing on this branch
defers, filters, hides, or dynamically registers a tool.

## Artifacts

- `app/test/fixtures/tool-discovery-eager-tasks.json` — 50 task fixtures.
- `app/scripts/tool-discovery-eager.mjs` — read-only measurement runner.
- `app/test/tool-discovery-eager.test.js` — 8 focused tests.
- This note.

## Fixture model

Each fixture records:

- `taskId` — stable identifier;
- `category` — one of ten required coverage domains;
- `language` — `en`, `zh`, or `mixed`;
- `request` — natural-language task. Requests do not name tools, except where a user-visible
  technical identifier or a negative-authorization attempt legitimately does;
- `expectedTools` — tools that satisfy the task;
- `alternativeTools` — permissible alternatives;
- `forbiddenToolCategories` — tool categories that must not be used for this task;
- `safetyExpectations` — read-only / preview-only / fail-closed / etc.

For `negative-authorization` fixtures, `expectedTools` are the tools an authorized client may use to
detect the refusal (for example `server_info`, `git_status`); the forbidden capability under test is
described in `notes`. A passing negative case is a closed refusal with no mutation, not a tool call.

### Coverage (50 fixtures)

| Category | Count |
| --- | --- |
| note-read-write-metadata | 7 |
| search-recall | 4 |
| links-graph-tasks-templates-bases | 9 |
| files | 4 |
| memory-skills | 5 |
| git | 4 |
| publish | 3 |
| plan-apply-recovery | 7 |
| negative-authorization | 4 |
| bootstrap-context | 3 |

Language mix: 20 `en`, 18 `zh`, 12 `mixed`. Fixture references cover 70 of the 85 catalog tools
(expected or alternative). Uncovered tools are reported by the runner and are mostly specialized
recovery/upload/Bases/Canvas tools; they are not silently treated as covered.

## Measurement entry point

```sh
cd app
node scripts/tool-discovery-eager.mjs          # human-readable report
node scripts/tool-discovery-eager.mjs --json   # deterministic JSON
node scripts/tool-discovery-eager.mjs --fixtures <path>   # custom fixture file
```

The runner:

1. loads and validates the fixtures (unique IDs, known categories/languages/safety labels,
   every expected and alternative tool resolves against `TOOL_NAMES`, no expected/alternative overlap);
2. builds a real in-memory MCP server via `registerObsidianCapabilities`, connects an in-memory
   client, and reads the actual `tools/list` payload;
3. reports byte sizes and distributions;
4. exits non-zero when validation fails.

It never calls a tool, never reads or writes the vault, and produces stable output across runs.

### Schema-size methodology

- Size is the **utf8 byte length** of `JSON.stringify(value)` (`TextEncoder`), not a character count
  and not a token count.
- `descriptorBytes` — the full serialized tool descriptor per tool (name, title, description,
  inputSchema, outputSchema, annotations, `_meta`), summed.
- `inputSchemaBytes` / `outputSchemaBytes` — the two schema fields summed separately.
- `toolsListPayloadBytes` — the serialized `{ tools: [...] }` payload.
- Tools are sorted by name before serialization; aggregate values are derived from the per-tool rows
  so the report is internally consistent.
- No tokenizer is run. A byte figure is not a token figure; token cost is explicitly unmeasured.

### Baseline snapshot at `44e3828`

| Field | Value |
| --- | --- |
| Catalog tools | 85 (equals `TOOL_NAMES`) |
| Descriptor bytes | 138,975 |
| inputSchema bytes | 29,032 |
| outputSchema bytes | 62,455 |
| `tools/list` payload bytes | 139,071 |
| Annotations | readOnly 50, destructive 28, idempotent 52, openWorld 10 |
| Scope histogram | read 47, read+files 5, read+write 26, read+write+files 7 |

These values are reproducible with the command above on this commit. They characterize the payload
size only; they do not by themselves prove that progressive discovery is beneficial.

## Measured vs unmeasured

Measured: fixture count and distributions; tool-name resolution against `TOOL_NAMES`; real eager
catalog tool count; descriptor/input/output byte sizes; annotation counts; scope histogram; catalog
coverage by fixture references.

**Unmeasured (deliberately):** end-to-end agent task success, tool-selection precision/recall,
wrong-tool rate, discovery rounds, real MCP call counts, latency, real token usage,
unauthorized-metadata-leak behavior, and host/client progressive-disclosure support.

This branch does not claim any agent completed any task. No host connection was exercised, and no
latency number was captured.

## Acceptance mapping

- 30–50 fixtures with ID / request / category / expected tools / safety expectations — 50 fixtures.
- All expected tool names resolve against current `TOOL_NAMES` — enforced by tests and the runner.
- Deterministic runner reports fixture counts/coverage, eager catalog size, and schema-size
  methodology without fabricated latency or agent success — implemented.
- Focused checks plus `npm run check` and `npm test` — see the handoff.
- Allowed write scope only; no `app/src/`, configuration, bundle, or other-worktree changes.

## Next action

Decide the Phase 1 catalog layer (domain/toolset/aliases/visibility per tool) with a parity test
against `TOOL_NAMES`, Scope requirements, output contracts, and annotations — still without changing
default `tools/list` behavior.
