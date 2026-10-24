# Repository About and discoverability

This file holds the **proposed repository metadata** for the authoritative Gitea repository and the sanitized public GitHub snapshot. GitHub and Gitea repository descriptions are settings, **not** derived from README; changing this file does not update those settings.

## Recommended About (English)

> Self-hosted Obsidian MCP + Web workspace for shared AI memory, hybrid search, Skills, safe edits, OAuth, and multi-vault access.

Keep the GitHub public repository's About focused on the *product*, not “Public source snapshot”. The snapshot/distribution distinction belongs in README / CONTRIBUTING, where context fits.

## Recommended Gitea About

> Obsidian as shared AI memory: self-hosted MCP, hybrid search, live Web workspace, Skills, safe writes, and per-vault access.

## Suggested topics

`obsidian-mcp`, `obsidian`, `model-context-protocol`, `ai-agent-memory`, `self-hosted`, `semantic-search`, `knowledge-management`, `agent-skills`, `markdown`, `oauth`, `multi-vault`.

## Change and verification checklist

- In each repository's settings, copy the corresponding About text. Do not add unverifiable benchmark rankings, performance numbers, download counts, or claims that PWA/unfinished Bases features have shipped.
- Keep the public GitHub repo's source-snapshot disclosure in README and CONTRIBUTING.
- Confirm that the public snapshot includes the merged README change **only after the normal sanitized publish workflow**; do not manually copy private operational files or credentials.
- Reopen both repository home pages without login, verify About, README language anchors, Quick start, install commands, and the published code/documentation links.
- Avoid screenshots or badges until corresponding artifacts and CI provenance are available.

## Competitive review (2026-10-23)

- https://github.com/topics/obsidian-mcp
- https://github.com/shaqmughal/seekstone — short hook, quantified context-cost benchmarks (numbers are their claims, not ours)
- https://github.com/oomkapwn/enquire-mcp — source citations, recency metadata, PDF/OCR retrieval
- https://github.com/aka-kika/kika-obsidian-mcp — schema-validated Bases support
- https://github.com/bezata/kObsidian — explainable knowledge-maintenance workflows
- https://github.com/maxkuminov/obsidian-mcp — task-led storytelling and self-describing vault

Current product strengths emphasized: one owned Markdown vault, cross-agent memory and Skills, remote self-hosted MCP, browser workspace, scoped authorization, revision-safe collaboration. Candidate feature investigations are tracked as Gitea issues; competitor documentation does not by itself prove our feature gaps or production readiness.
