# Progressive Tool Discovery — Phase 2C runtime Scope-negative matrix

Status: **candidate** (branch artifact). This is **SDK/runtime transport evidence, not host evidence**.
Source commit: `427225bf2e28aefceb3ed5d132a7fb26f5f964a9` (informational).

Real MCP Streamable HTTP over loopback with the real discovery runtime and sentinel-wrapped handlers.
No Vault write, no production auth, no NAS state. Scope truth: `src/scopes.js`.

## Gate decision

**Decision: `pass`**

| Check | Result | Detail |
| --- | --- | --- |
| `visibility-matches-independent-truth` | pass | profile x scope rows with a visibility mismatch: 0 |
| `zero-metadata-leaks` | pass | structural leaks 0; hidden names in payload 0 |
| `zero-denied-handler-executions` | pass | denied calls that reached a handler: 0 |
| `denied-call-no-metadata` | pass | denied results containing descriptor metadata: 0 |
| `missing-auth-fail-closed` | pass | profiles where missing auth exposed tools: 0 |
| `no-scope-fail-closed` | pass | profiles where empty scopes exposed tools: 0 |
| `current-request-scope-recompute` | pass | profiles where scope change did not recompute/restore: 0 |
| `full-descriptors-equal-raw-native` | pass | full-profile wired tools/list descriptors deep-equal the raw native descriptor array |

- Profiles: 13; scope rows: 52.
- Native registration order digest: `41e0d5589794ad05a9c79cf5dcc544797a6639eef4c29c74259056cd502c422a` (90 tools).
- ReadOnly-annotation-but-write-scoped tools: 36.

## Per-profile visibility

| Profile | Scope set | Expected | Visible | Match order | Structural leaks | Denied calls | Denied handler runs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | `read` | 48 | 48 | true | 0 | 6 | 0 |
| `full` | `read+files` | 54 | 54 | true | 0 | 6 | 0 |
| `full` | `read+write` | 77 | 77 | true | 0 | 6 | 0 |
| `full` | `all` | 90 | 90 | true | 0 | 0 | 0 |
| `core` | `read` | 6 | 6 | true | 0 | 6 | 0 |
| `core` | `read+files` | 6 | 6 | true | 0 | 6 | 0 |
| `core` | `read+write` | 6 | 6 | true | 0 | 6 | 0 |
| `core` | `all` | 6 | 6 | true | 0 | 6 | 0 |
| `module:info` | `read` | 2 | 2 | true | 0 | 6 | 0 |
| `module:info` | `read+files` | 2 | 2 | true | 0 | 6 | 0 |
| `module:info` | `read+write` | 2 | 2 | true | 0 | 6 | 0 |
| `module:info` | `all` | 2 | 2 | true | 0 | 6 | 0 |
| `module:notes` | `read` | 2 | 2 | true | 0 | 6 | 0 |
| `module:notes` | `read+files` | 2 | 2 | true | 0 | 6 | 0 |
| `module:notes` | `read+write` | 8 | 8 | true | 0 | 6 | 0 |
| `module:notes` | `all` | 8 | 8 | true | 0 | 6 | 0 |
| `module:search` | `read` | 4 | 4 | true | 0 | 6 | 0 |
| `module:search` | `read+files` | 4 | 4 | true | 0 | 6 | 0 |
| `module:search` | `read+write` | 4 | 4 | true | 0 | 6 | 0 |
| `module:search` | `all` | 4 | 4 | true | 0 | 6 | 0 |
| `module:files` | `read` | 2 | 2 | true | 0 | 6 | 0 |
| `module:files` | `read+files` | 8 | 8 | true | 0 | 6 | 0 |
| `module:files` | `read+write` | 5 | 5 | true | 0 | 6 | 0 |
| `module:files` | `all` | 16 | 16 | true | 0 | 6 | 0 |
| `module:links` | `read` | 7 | 7 | true | 0 | 6 | 0 |
| `module:links` | `read+files` | 7 | 7 | true | 0 | 6 | 0 |
| `module:links` | `read+write` | 13 | 13 | true | 0 | 6 | 0 |
| `module:links` | `all` | 13 | 13 | true | 0 | 6 | 0 |
| `module:workflows` | `read` | 8 | 8 | true | 0 | 6 | 0 |
| `module:workflows` | `read+files` | 8 | 8 | true | 0 | 6 | 0 |
| `module:workflows` | `read+write` | 16 | 16 | true | 0 | 6 | 0 |
| `module:workflows` | `all` | 16 | 16 | true | 0 | 6 | 0 |
| `module:git` | `read` | 3 | 3 | true | 0 | 6 | 0 |
| `module:git` | `read+files` | 3 | 3 | true | 0 | 6 | 0 |
| `module:git` | `read+write` | 6 | 6 | true | 0 | 6 | 0 |
| `module:git` | `all` | 6 | 6 | true | 0 | 6 | 0 |
| `module:intelligence` | `read` | 10 | 10 | true | 0 | 6 | 0 |
| `module:intelligence` | `read+files` | 10 | 10 | true | 0 | 6 | 0 |
| `module:intelligence` | `read+write` | 11 | 11 | true | 0 | 6 | 0 |
| `module:intelligence` | `all` | 13 | 13 | true | 0 | 6 | 0 |
| `module:context` | `read` | 1 | 1 | true | 0 | 6 | 0 |
| `module:context` | `read+files` | 1 | 1 | true | 0 | 6 | 0 |
| `module:context` | `read+write` | 1 | 1 | true | 0 | 6 | 0 |
| `module:context` | `all` | 1 | 1 | true | 0 | 6 | 0 |
| `module:publish` | `read` | 1 | 1 | true | 0 | 6 | 0 |
| `module:publish` | `read+files` | 1 | 1 | true | 0 | 6 | 0 |
| `module:publish` | `read+write` | 2 | 2 | true | 0 | 6 | 0 |
| `module:publish` | `all` | 2 | 2 | true | 0 | 6 | 0 |
| `module:plans` | `read` | 8 | 8 | true | 0 | 6 | 0 |
| `module:plans` | `read+files` | 8 | 8 | true | 0 | 6 | 0 |
| `module:plans` | `read+write` | 9 | 9 | true | 0 | 6 | 0 |
| `module:plans` | `all` | 9 | 9 | true | 0 | 6 | 0 |

## Negatives (fail closed)

| Profile | Missing auth visible | No-scope visible | Scope change recompute |
| --- | --- | --- | --- |
| `full` | 0 | 0 | true |
| `core` | 0 | 0 | true |
| `module:info` | 0 | 0 | true |
| `module:notes` | 0 | 0 | true |
| `module:search` | 0 | 0 | true |
| `module:files` | 0 | 0 | true |
| `module:links` | 0 | 0 | true |
| `module:workflows` | 0 | 0 | true |
| `module:git` | 0 | 0 | true |
| `module:intelligence` | 0 | 0 | true |
| `module:context` | 0 | 0 | true |
| `module:publish` | 0 | 0 | true |
| `module:plans` | 0 | 0 | true |

## Semantics and limits

- `deniedHandlerExecutions`: Every registered handler is wrapped with a sentinel counter. The matrix only calls tools that are expected to be hidden; a nonzero count means a denied call reached a handler.
- `metadataLeaks`: structuralLeaks counts returned tool names outside the independently computed expected set; hiddenNameInPayload counts expected-hidden names that leaked into the returned `name` field.

- Unmeasured: installed host deferred loading / tool search (Phase 3 host evidence)
- Unmeasured: production authentication and OAuth scope derivation
- Unmeasured: end-to-end agent task success
- Unmeasured: latency

Content digest (excludes `source`): `be97f68fb5c46270aae7edc259b313c563c5577a922e96865d1d1da995db4130` (35927 bytes).

