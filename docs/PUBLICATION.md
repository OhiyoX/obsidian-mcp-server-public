# Preparing a public distribution

**Current repository split (2026-10-23):** development and production provenance
belong to private Gitea; public GitHub is a reviewed, sanitized snapshot.
The repositories intentionally need not share commit SHAs or history. For
publication steps, strict allowlisting, review boundaries, mapping receipts,
and rollback/security response, see
[DUAL_REPOSITORY_WORKFLOW.md](DUAL_REPOSITORY_WORKFLOW.md).
This document alone does not automate distribution or authorize a deployment.

Project code is licensed under the [MIT License](../LICENSE). Third-party
packages and bundled fonts retain their own licenses; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

Examples use generic paths, loopback addresses and reserved example domains.
Set your own Vault paths, embedding endpoint and public HTTPS origin in a
protected `.env`. Do not copy a sample address into a production deployment
without reviewing it. The example `127.0.0.1` embedding endpoint refers to the
current network namespace, including the container when used in Compose.

Before deployment, pass the actual project directory with `--project`; the
generic `/srv/obsidian-mcp-server` fallback is an example, not an autodetected
deployment target. Existing deployments must keep their explicit protected
environment and CLI configuration. No production service is changed by a
documentation/source commit.

The repository no longer ships the one-off `record-oauth-deployment.mjs`
utility containing a dated private deployment log. Durable operator notes
belong in the operator's private project memory. Review artifacts may have
local account paths replaced with example account paths; this does not turn
offline characterization into new runtime evidence or recompute its scores.

## History and Actions are a separate publication boundary

A cleanup commit only sanitizes that file tree. Earlier commits, other
branches/tags, PR bodies/comments, commit author emails, Actions logs and
artifacts remain separately accessible when the original repository becomes
public. A current-tree secret scan cannot certify these records.

Preserve required regression evidence privately before any user-authorized
deletion of workflow records. Do not delete audit evidence, force-push rewritten
history or change visibility as part of an ordinary cleanup PR. When retaining
private collaboration history is necessary, review a clean public snapshot
separately rather than assuming a sanitized main hides older versions.

Re-scan the exact tree and all publication surfaces after changes. Avoid
recording real tokens, passwords, complete authorization headers, real Vault
contents or operator identity in examples, fixtures, screenshots or reports.
