# Demo vault

Two fully synthetic Obsidian vaults used by the showcase screenshots and by anyone who wants to try the server without touching their own notes.

```
vaults/
  aurora/   primary demo vault, mirrors a _Workspace layout
  atlas/    secondary vault: used to demonstrate per-call vault selection
```

## Workspace layout

`aurora` follows the same `_Workspace` convention the server documents:

```
_Workspace/
  00-System/      conventions and agent contracts
  10-Inbox/       captures and daily notes
  20-Memory/      Facts / Decisions / Episodes
  30-Knowledge/   engineering, research, resources
  40-Projects/    one directory per project, README is current state
  50-Ops/         meetings and sandbox notes
  60-Skills/      portable skill packages (SKILL.md + references)
  70-Todos/       cross-project tasks
  80-Maps/        Home and navigation
  90-Archive/     read-only archive
```

Start the server with the workspace root set so memory and skill tools resolve to these areas:

```sh
export VAULT_PATH="$PWD/demo/vaults/aurora"
export WEB_VAULTS_ROOT="$PWD/demo/vaults"
export WEB_DEFAULT_VAULT=aurora
export VAULT_WORKSPACE_ROOT=_Workspace
```

## What is inside

- Wikilinks, aliases, embeds, unresolved links and an intentional orphan
- Frontmatter properties (`status`, `priority`, `updated`, `tags`, `aliases`)
- Tasks, callouts, tables, code blocks, KaTeX math, footnotes and Mermaid
- Three Bases views (`Project Board`, `Reading Queue`, `Memory Index`)
- One JSON Canvas (`Canvas/System Map.canvas`)
- Daily notes, templates, a small SVG asset and a Chinese note for bilingual search
- Managed memories for decision, fact and episode, plus one validated skill package

Everything here is generated for the demo. Names, numbers, links and email addresses are fictional, and no production note has been copied into this directory.
