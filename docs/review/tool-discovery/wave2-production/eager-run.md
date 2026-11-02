# Eager real run — Wave 2 production anchors

Status: **candidate**. A real, read-only `tools/call` run against the deployed eager catalog, reusing the Wave 1 50 task fixtures.
Target: redacted endpoint `http-private-custom-port` (`obsidian-mcp-server 1.0.0`), captured 2026-09-24T20:56:36.167Z.
Offline verification of this artifact cannot prove it was captured from a live server.

## Calls and outcomes

- Real MCP calls: **47** (6 discovery + 41 probes).
- Read-only tools in catalog: 50; probed: 41; not probed: 9.
- Write/destructive tools excluded from probing by safety policy: 35.
- Probe success rate (success / invoked): **0.951**.

| Outcome | Calls |
| --- | --- |
| `not_probed` | 9 |
| `output_contract_violation` | 2 |
| `success` | 39 |

### Non-success probes

| Tool | Outcome | Reason |
| --- | --- | --- |
| `get_note_version` | `output_contract_violation` | output_validation |
| `git_diff` | `output_contract_violation` | output_validation |

### Read-only tools not probed (and why)

| tool:reason | Count |
| --- | --- |
| file_upload_status:requires_upload_id_stateful | 1 |
| get_canvas:missing_context:path | 1 |
| get_note_plan:requires_plan_id_stateful | 1 |
| inspect_archive:missing_context:path | 1 |
| plan_delete_note:creates_plan_stateful | 1 |
| plan_move_note:creates_plan_stateful | 1 |
| plan_note_changes:creates_plan_stateful | 1 |
| plan_restore_from_trash:creates_plan_stateful | 1 |
| plan_restore_version:creates_plan_stateful | 1 |

## Fixtures (50 tasks)

- Readiness histogram: {"blocked_harness":5,"blocked_safety":15,"failed":1,"ready":29}.
- Expected-tool reachable rate: **1.000**; fully ready rate: **0.580**.

| reason | Count |
| --- | --- |
| failed:git_diff:output_validation | 1 |
| safety_skipped:append_to_note | 1 |
| safety_skipped:apply_note_plan | 1 |
| safety_skipped:create_archive | 1 |
| safety_skipped:create_from_template | 1 |
| safety_skipped:extract_archive | 1 |
| safety_skipped:git_commit | 1 |
| safety_skipped:manage_frontmatter | 1 |
| safety_skipped:manage_publish | 2 |
| safety_skipped:manage_tags | 1 |
| safety_skipped:memory_capture | 1 |
| safety_skipped:rename_property | 1 |
| safety_skipped:replace_in_note | 1 |
| safety_skipped:skill_export | 1 |
| safety_skipped:update_task | 1 |
| safety_skipped:write_note | 1 |
| unprobed:plan_delete_note:creates_plan_stateful | 1 |
| unprobed:plan_move_note:creates_plan_stateful | 1 |
| unprobed:plan_note_changes:creates_plan_stateful | 1 |
| unprobed:plan_restore_from_trash:creates_plan_stateful | 1 |
| unprobed:plan_restore_version:creates_plan_stateful | 1 |

## Schema cost

- Deployed catalog: inputSchema 29032 bytes, outputSchema 62455 bytes, descriptors 138997 bytes.
- Per-fixture expected-tool inputSchema cost: total 24417 bytes, max 2534 bytes.

## Agent task success

Status: **blocked** — No model/agent harness exists in this slice. Task-level completion, tool-selection precision/recall and discovery rounds are not deterministically measurable here and were not simulated.

## Observed output-contract violations

| Tool | Observed |
| --- | --- |
| `get_note_version` | deployed server returned structured content rejected by its own declared outputSchema |
| `git_diff` | deployed server returned structured content rejected by its own declared outputSchema |

## Safety

- only tools annotated readOnlyHint:true by the deployed server were invoked.
- Stateful read-only tools skipped: `file_upload_status`, `get_note_plan`, `plan_note_changes`, `plan_move_note`, `plan_delete_note`, `plan_restore_version`, `plan_restore_from_trash`.
- Write/destructive tools invoked: 0; payload bodies recorded: false.

## Measured / unmeasured

Measured: real tools/call outcomes per read-only deployed tool; fixture-level readiness against the real eager catalog; real MCP call counts and per-call result byte sizes; task-relevant input-schema byte cost per fixture.

Unmeasured: end-to-end agent task success (blocked: no agent harness); tool-selection precision/recall and wrong-tool rate; latency (intentionally not captured); write/destructive tool execution (intentionally never invoked).

