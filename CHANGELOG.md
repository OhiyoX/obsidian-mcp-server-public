# Changelog

Public snapshots of Obsidian MCP Server. Each entry lists what changed for users
of this repository since the previous snapshot. Deployment details and internal
records stay private.

## 2026-11-10 — snapshot

### Timed authorization, per Vault

One subject can now hold **different time windows on different Vaults**: Vault A
on workdays 09:00–18:00, Vault B at weekends, a third Vault with no window. A new
「定时授权」 (Timed authorization) page edits these constraints; each one carries a
Vault scope, a set of operations and a weekly window. Constraints only subtract
from what a credential may already do.

The page always states which backend decides. Until an operator switches the
deployment to the new model, the page says so plainly: the constraints are
recorded and do not decide yet.

The previous per-policy editor is now read-only. Its write endpoints answer
`409 access_policy_frozen`, because an accepted edit there would be stored and
never apply.

### Publish a whole folder

A folder can be published as one public link: a folder index page, an opaque
token per item, and a record that follows a server-side rename. Notes keep their
own public addresses.

### Explorer: rename and safe delete

The file explorer renames and deletes notes and folders. A rename rewrites the
links that point at the moved note or folder across the Vault. Delete moves the
item into the Vault Trash in one step; it never unlinks a file tree.

### Default Vault per account

An OAuth account can carry a default Vault. Clients that set none inherit it,
including the Web workspace after login.

### Editor

Typing `###`, `>` or `-` and then moving the caret away no longer hides the
marker and restyles the line: an empty block mark stays the text that was typed
until the construct applies.

### Security and operations

- The proxy → process hop can be encrypted with a private CA.
- A shadow mode records the new authorization verdict beside the old one without
  changing any response.
- `deploy --rebuild` rebuilds the image when it predates the payload.

## 2026-11-02 — snapshot

First public snapshot: MCP server, Web workspace, hybrid search, Skills,
OAuth, multi-vault access, and the Admin plane.
