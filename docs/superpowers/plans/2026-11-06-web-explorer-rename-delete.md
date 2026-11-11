# Web explorer safe delete and rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Web operator rename a note or a folder (rewriting its links) and delete one into Trash from the explorer, by right-click menu or `F2`.

**Architecture:** New Vault-scoped module `app/src/app/web-rename-delete.js` holds the decisions. A note rename and a note/attachment delete reuse the plan engine (`createMovePlan` / `createDeletePlan` / `createDeleteFilePlan` + `applyNotePlan`) inside a `withRequestContextPatch` that binds the selected Vault's runtime. A folder is renamed or trashed by one `fs.rename`, and only its links are rewritten through a text-only plan. Two routes expose this; the explorer gets a context menu that reuses `createPopupMenuController` and the existing inline draft row.

**Tech Stack:** Node ESM, Express router, `node --test`, esbuild for the browser bundle, no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-06-web-explorer-rename-delete-design.md`

## Global Constraints

- Caps: refuse above **500 files** in one folder operation and above **200 rewritten notes**. A refusal happens before anything is written.
- Delete always moves bytes into the Vault's own Trash (`vaultRuntime.paths.trash`); never `fs.rm` on user data.
- Every write route runs `requireApi`, `requireCsrf`, `writeRouteGate`, `allowsRoute(…, WRITE_CLASS)`, `assertWritable`, and writes one audit line.
- A Vault without a materialized runtime answers **503** `vault_unavailable`; never the primary Vault.
- `confirm: true` is required by `POST /api/web/v1/delete`; without it the answer is 400.
- Paths come from `resolveWebVaultPath(vault, …)` only. A body path never decides the root.
- Tests set `VAULT_PATH`, `DATA_PATH` and `WEB_DEFAULT_VAULT` **before** importing `../src/app/routes.js`.
- The browser bundle `app/src/app/assets/app.js` is generated and committed: after any `frontend/` change run `npm run build:web` in `app/`.
- No literal user-facing text in `frontend/`: every label goes through `t()` with a key present in both `app/src/i18n/messages/zh-CN.js` and `en.js`.

## Review Focus

1. A path with `..`, an absolute path, the Vault root, or a symlink target must be refused with no filesystem change. (Task 1)
2. A folder holding a binary must keep byte-identical content after rename; nothing re-encodes it. (Task 2)
3. A rename into an existing destination must never overwrite it. (Tasks 2, 3)
4. A delete retried after success must answer 404, not a second success. (Task 4)
5. A link from outside the folder is rewritten; a link inside the moved folder that points at a sibling inside it is rewritten to the new sibling path, not left on the old one. (Task 2)

---

### Task 1: Folder delete — one Trash rename

**Files:**
- Create: `app/src/app/web-rename-delete.js`
- Test: `app/test/web-rename-delete.test.js`

**Interfaces:**
- Consumes: `resolveWebVaultPath(vault, userPath, { allowMissing })` from `app/src/app/vault-registry.js`; `assertWritable()` from `app/src/vault.js`.
- Produces:
  - `class WebEntryError extends Error { constructor(message, status, code = null) }`
  - `export async function deleteWebFolder(vault, runtime, { path: fromPath }) -> { kind: "folder", deleted: string, trash: string, files: number }`

- [ ] **Step 1: Write the failing test**

```js
// app/test/web-rename-delete.test.js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-rename-delete-"));
const vaultRoot = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vaultRoot, "Projects/deep"), { recursive: true });
await fs.writeFile(path.join(vaultRoot, "Projects/deep/Note.md"), "# hi\n", "utf8");
await fs.writeFile(path.join(vaultRoot, "Top.md"), "# top\n", "utf8");
process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = data;

const { deleteWebFolder, WebEntryError } = await import("../src/app/web-rename-delete.js");
const { resolveWebVault } = await import("../src/app/vault-registry.js");

const vault = { id: "vault", root: vaultRoot, primary: true };
const runtime = { id: "vault", paths: { trash: path.join(data, "trash") } };

test.after(async () => fs.rm(root, { recursive: true, force: true }));

test("folder delete moves the whole tree into the Vault Trash and keeps its bytes", async () => {
  const result = await deleteWebFolder(vault, runtime, { path: "Projects" });
  assert.equal(result.kind, "folder");
  assert.equal(result.deleted, "Projects");
  assert.equal(result.files, 1);
  await assert.rejects(fs.stat(path.join(vaultRoot, "Projects")), { code: "ENOENT" });
  const trashed = path.join(runtime.paths.trash, result.trash, "Projects/deep/Note.md");
  assert.equal(await fs.readFile(trashed, "utf8"), "# hi\n");
  assert.match(result.trash, /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}$/);
});

test("folder delete refuses the vault root, a traversal path and a missing folder", async () => {
  await assert.rejects(deleteWebFolder(vault, runtime, { path: "" }), { status: 400 });
  await assert.rejects(deleteWebFolder(vault, runtime, { path: "../data" }), { status: 400 });
  await assert.rejects(deleteWebFolder(vault, runtime, { path: "Nope" }), { status: 404 });
  assert.equal((await fs.stat(vaultRoot)).isDirectory(), true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd app && node --test test/web-rename-delete.test.js`
Expected: FAIL — `Cannot find module '../src/app/web-rename-delete.js'`.

- [ ] **Step 3: Implement `deleteWebFolder`**

`app/src/app/web-rename-delete.js`:

- `WebEntryError` carries `this.status` and `this.code`.
- `resolveEntry(vault, userPath, { allowMissing })` → `resolveWebVaultPath`; a thrown `Invalid Vault path` or containment failure becomes `WebEntryError(message, 400)`.
- `assertRenamable(fullPath)` → refuse `""` (the root, status 400), a path containing a segment `..` (400), a segment starting with `.git`/`.obsidian` (400).
- `countFiles(absPath)` → recursive `fs.readdir(absPath, { withFileTypes: true })`, skip symbolic links, count regular files; above 500 → `WebEntryError("Too many files: N > 500", 413, "FOLDER_TOO_LARGE")`.
- `deleteWebFolder`: `assertWritable()`; resolve with `allowMissing: true`; `fs.lstat` → not a directory or missing → `WebEntryError("Folder not found", 404)`; `assertRenamable`; count; then
  `const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID();`
  `await fs.mkdir(path.join(runtime.paths.trash, stamp), { recursive: true });`
  `await fs.rename(abs, path.join(runtime.paths.trash, stamp, rel));`
  A `runtime?.paths?.trash` that is not a string → `WebEntryError("Vault Trash is unavailable", 503, "TRASH_UNAVAILABLE")`.
  Return `{ kind: "folder", deleted: rel, trash: stamp, files }`.

- [ ] **Step 4: Run the test again**

Run: `cd app && node --test test/web-rename-delete.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd app && git add src/app/web-rename-delete.js test/web-rename-delete.test.js
git commit -m "feat(web): delete a folder into the vault Trash in one rename"
```

---

### Task 2: Folder rename with a text-only link plan

**Files:**
- Modify: `app/src/app/web-rename-delete.js`
- Test: `app/test/web-rename-delete.test.js`

**Interfaces:**
- Consumes: `replaceVaultLinks(content, fromPath, toPath, sourcePath)` from `app/src/obsidian.js`; Task 1's helpers.
- Produces:
  - `export function planFolderLinks({ from, to, files, notes }) -> Array<{ path, content }>` — pure; `files` = `[{ fromRel, toRel }]` for the moved notes, `notes` = `[{ path, raw }]` for every note in the Vault.
  - `export async function renameWebFolder(vault, runtime, { from, to, applyLinks }) -> { kind: "folder", from, to, updatedLinksIn: string[], files: number }` — `applyLinks(items)` is injected (Task 4 passes the plan engine); the function itself never imports `mutation-plans.js`.

- [ ] **Step 1: Write the failing tests**

```js
test("folder rename keeps a binary byte-identical and rewrites outside links only", async () => {
  await fs.mkdir(path.join(vaultRoot, "Assets/img"), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await fs.writeFile(path.join(vaultRoot, "Assets/img/pixel.png"), png);
  await fs.writeFile(path.join(vaultRoot, "Assets/a.md"), "see [[Assets/b]] and [[Top]]\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "Assets/b.md"), "inner\n", "utf8");
  const applied = [];
  const result = await renameWebFolder(vault, runtime, {
    from: "Assets", to: "Media",
    applyLinks: async (items) => { applied.push(...items); },
  });
  assert.equal(result.kind, "folder");
  assert.deepEqual(await fs.readFile(path.join(vaultRoot, "Media/img/pixel.png")), png);
  assert.deepEqual(result.updatedLinksIn.sort(), ["Assets/a.md"]);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].content, "see [[Media/b]] and [[Top]]\n");
});

test("folder rename refuses an existing destination and a destination inside the source", async () => {
  await fs.mkdir(path.join(vaultRoot, "A"), { recursive: true });
  await fs.mkdir(path.join(vaultRoot, "B"), { recursive: true });
  await assert.rejects(renameWebFolder(vault, runtime, { from: "A", to: "B", applyLinks: async () => {} }), { status: 409 });
  await assert.rejects(renameWebFolder(vault, runtime, { from: "A", to: "A/inner", applyLinks: async () => {} }), { status: 400 });
  assert.equal((await fs.stat(path.join(vaultRoot, "A"))).isDirectory(), true);
});

test("folder rename renames an empty folder without a plan item", async () => {
  await fs.mkdir(path.join(vaultRoot, "Empty"), { recursive: true });
  const applied = [];
  await renameWebFolder(vault, runtime, { from: "Empty", to: "StillEmpty", applyLinks: async (items) => applied.push(...items) });
  assert.equal((await fs.stat(path.join(vaultRoot, "StillEmpty"))).isDirectory(), true);
  assert.deepEqual(applied, []);
});

test("folder rename renames back when the link plan fails", async () => {
  await fs.mkdir(path.join(vaultRoot, "Roll"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Roll/x.md"), "x\n", "utf8");
  await assert.rejects(renameWebFolder(vault, runtime, {
    from: "Roll", to: "Rolled",
    applyLinks: async () => { throw new Error("link plan exploded"); },
  }), /link plan exploded/);
  assert.equal((await fs.stat(path.join(vaultRoot, "Roll"))).isDirectory(), true);
  await assert.rejects(fs.stat(path.join(vaultRoot, "Rolled")), { code: "ENOENT" });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && node --test test/web-rename-delete.test.js`
Expected: FAIL — `renameWebFolder is not a function`.

- [ ] **Step 3: Implement `planFolderLinks` and `renameWebFolder`**

- `planFolderLinks` returns one item per referring note whose text changes: for each note, `replaceVaultLinks(raw, fromRel, toRel, note.path)` for every moved pair, then keep the note when the result differs from `raw`. Items are `{ path: note.path, content: next }`. Above 200 items → `WebEntryError("Too many notes to rewrite: N > 200", 413, "LINKS_TOO_MANY")`.
- `renameWebFolder` order matters, so the refusals cost nothing:
  1. `assertWritable()`; resolve both paths (`to` with `allowMissing: true`).
  2. `assertRenamable(fromRel)`; `fs.lstat(fromAbs)` must be a directory and not a symbolic link (`WebEntryError(…, 400)`).
  3. `fs.lstat(toAbs)` must not exist → else `WebEntryError("Destination exists", 409, "DESTINATION_EXISTS")`; `toRel` inside `fromRel + "/"` → 400.
  4. Walk the source: `movedNotes` = `[{ fromRel, toRel }]`, `files` = count (cap 500).
  5. `const items = planFolderLinks({ files: movedNotes, notes: await readAllNotes(vault) })` — read **before** the rename, so a refusal leaves the Vault untouched.
  6. `await fs.rename(fromAbs, toAbs)`.
  7. `await applyLinks(items)`; on a throw, `await fs.rename(toAbs, fromAbs)` and rethrow.
- `readAllNotes(vault)` walks `vault.root` with `fs.readdir(..., { withFileTypes: true })`, skips symbolic links and directories starting with `.`, reads `*.md` as utf8.

- [ ] **Step 4: Run the tests**

Run: `cd app && node --test test/web-rename-delete.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd app && git add src/app/web-rename-delete.js test/web-rename-delete.test.js
git commit -m "feat(web): rename a folder as one directory rename plus a link plan"
```

---

### Task 3: Note rename and file delete through the plan engine

**Files:**
- Modify: `app/src/app/web-rename-delete.js`
- Test: `app/test/web-rename-delete.test.js`

**Interfaces:**
- Consumes: Task 1's `resolveEntry` / `assertRenamable`; `runtime` from the caller.
- Produces:
  - `export async function renameWebNote(vault, runtime, { from, to, ifMatch, mutationId }) -> { kind: "note", from, to, updatedLinksIn: string[] }`
  - `export async function deleteWebFile(vault, runtime, { path }) -> { kind: "note" | "attachment", deleted, trash }`
  - `export function entryKind(absPath) -> Promise<"folder" | "note" | "attachment">`

- [ ] **Step 1: Write the failing tests**

```js
test("note rename moves the file, rewrites links and reports the changed notes", async () => {
  await fs.writeFile(path.join(vaultRoot, "From.md"), "# from\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "Referrer.md"), "link [[From]]\n", "utf8");
  const result = await renameWebNote(vault, runtime, { from: "From.md", to: "To.md", mutationId: "m-1" });
  assert.deepEqual(result, { kind: "note", from: "From.md", to: "To.md", updatedLinksIn: ["Referrer.md"] });
  assert.equal(await fs.readFile(path.join(vaultRoot, "Referrer.md"), "utf8"), "link [[To]]\n");
  await assert.rejects(fs.stat(path.join(vaultRoot, "From.md")), { code: "ENOENT" });
});

test("note rename without an extension keeps .md and refuses an existing target", async () => {
  await fs.writeFile(path.join(vaultRoot, "Alpha.md"), "a\n", "utf8");
  await fs.writeFile(path.join(vaultRoot, "Beta.md"), "b\n", "utf8");
  const ok = await renameWebNote(vault, runtime, { from: "Alpha", to: "Gamma", mutationId: "m-2" });
  assert.equal(ok.to, "Gamma.md");
  await assert.rejects(renameWebNote(vault, runtime, { from: "Gamma", to: "Beta", mutationId: "m-3" }), { status: 409 });
});

test("file delete puts the bytes in the Vault Trash and reports the backup", async () => {
  await fs.mkdir(path.join(vaultRoot, "files"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "files/report.pdf"), Buffer.from("%PDF-1.4", "utf8"));
  const result = await deleteWebFile(vault, runtime, { path: "files/report.pdf" });
  assert.equal(result.kind, "attachment");
  assert.ok(result.trash.startsWith("files/report.pdf") === false, "trash names the backup, not the old path");
  await assert.rejects(fs.stat(path.join(vaultRoot, "files/report.pdf")), { code: "ENOENT" });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && node --test test/web-rename-delete.test.js`
Expected: FAIL — `renameWebNote is not a function`.

- [ ] **Step 3: Implement the three functions**

- `entryKind`: `fs.lstat` → directory or symbolic link → `"folder"`; a `.md` name → `"note"`; else `"attachment"`.
- `renameWebNote`: `assertWritable()`; both paths resolved with `assumeMarkdown` semantics — append `.md` when `path.posix.extname` is empty; `assertRenamable`; `ifMatch` compared against the file's `sha256:<hex>` revision (`createHash("sha256")` over the bytes) → a mismatch is `WebEntryError("Revision conflict", 409, "REVISION_CONFLICT")`; `fs.lstat(toAbs)` exists → 409 `DESTINATION_EXISTS`; then `const plan = await createMovePlan({ from: fromRel, to: toRel, overwrite: false, updateLinks: true, ifMatch: null }, { runtime }); const applied = await applyNotePlan(plan.planId, plan.planHash, mutationId);` and `updatedLinksIn = applied.changed.map((c) => c.path).filter((p) => p !== fromRel && p !== toRel)`.
- `deleteWebFile`: `assertWritable()`; resolve; `entryKind` — a folder here is `WebEntryError("Use the folder route", 400)`; then `createDeletePlan({ path: rel, backup: true })` for a note and `createDeleteFilePlan({ path: rel })` for an attachment; `applyNotePlan(plan.planId, plan.planHash, randomUUID())`; return `{ kind, deleted: rel, trash: applied.changed[0].backup }`.
- Both call the plan engine. The runtime binding is the **caller's** job (Task 4 wraps them in `withRequestContextPatch`); these functions take `runtime` only to refuse early when it is missing: `if (!runtime) throw new WebEntryError("Vault runtime unavailable", 503, "vault_unavailable")`.

- [ ] **Step 4: Run the tests**

Run: `cd app && node --test test/web-rename-delete.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd app && git add src/app/web-rename-delete.js test/web-rename-delete.test.js
git commit -m "feat(web): rename a note and delete a file through the plan engine"
```

---

### Task 4: The two routes, bound to the selected Vault

**Files:**
- Modify: `app/src/app/routes.js` (import block; `createWebAppRouter` signature at line 79; new routes next to `POST /api/web/v1/folder` at line 575)
- Modify: `app/server.js:308` (pass `resolveVaultRuntime`)
- Test: `app/test/web-rename-delete-routes.test.js`

**Interfaces:**
- Consumes: `renameWebEntry` / `deleteWebEntry` — **new** dispatchers this task adds to `web-rename-delete.js`:
  - `export async function renameWebEntry(vault, runtime, { path, to, ifMatch, mutationId }) → { kind, from, to, updatedLinksIn }`
  - `export async function deleteWebEntry(vault, runtime, { path, confirm }) → { kind, deleted, trash, files }`
- Produces: `POST /api/web/v1/rename { path, to, ifMatch?, mutationId }` and `POST /api/web/v1/delete { path, confirm }`; `createWebAppRouter({ …, resolveVaultRuntime })`.

- [ ] **Step 1: Write the failing tests**

Copy the harness of `app/test/web-folder-route.test.js` (`startAuthedApp`: provider stub, login, `GET /app/` → `csrf-token` meta). Then:

```js
test("rename returns 401 without a session and 403 without CSRF", async () => { /* POST without cookie → 401; with cookie, without X-CSRF-Token → 403 */ });
test("rename a folder rewrites an outside link and answers the new path", async () => {
  const res = await post("/api/web/v1/rename", { path: "Projects", to: "Work", mutationId: "m-1" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { kind: "folder", from: "Projects", to: "Work", updatedLinksIn: ["Index.md"] });
});
test("rename into an existing target answers 409 and changes nothing", async () => {
  const res = await post("/api/web/v1/rename", { path: "Work", to: "Index.md", mutationId: "m-2" });
  assert.equal(res.status, 409);
});
test("delete requires confirm and answers 400 without it", async () => {
  const res = await post("/api/web/v1/delete", { path: "Work" });
  assert.equal(res.status, 400);
});
test("delete a note answers the Trash backup and a retry answers 404", async () => {
  const first = await post("/api/web/v1/delete", { path: "Index.md", confirm: true });
  assert.equal(first.status, 200);
  assert.ok(first.body.trash);
  const second = await post("/api/web/v1/delete", { path: "Index.md", confirm: true });
  assert.equal(second.status, 404);
});
test("a vault without a runtime answers 503 vault_unavailable", async () => { /* startAuthedApp({ resolveVaultRuntime: () => null }) → 503, body.code === "vault_unavailable" */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && node --test test/web-rename-delete-routes.test.js`
Expected: FAIL — 404 on the new routes.

- [ ] **Step 3: Implement the routes and the wiring**

- `createWebAppRouter({ …, resolveVaultRuntime = null })`; each handler:
  ```js
  const vault = await currentVault(req);
  const runtime = resolveVaultRuntime?.(vault.id) ?? null;
  if (!runtime) return res.status(503).json({ error: "Vault runtime unavailable", code: "vault_unavailable" });
  const result = await withRequestContextPatch({ vaultId: vault.id, vaultRuntime: runtime }, () =>
    renameWebEntry(vault, runtime, { path: req.body?.path, to: req.body?.to, ifMatch: readPrecondition(req), mutationId: req.body?.mutationId }));
  provider.recordAudit({ action: "web.rename", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: `${vault.id}:${result.from} -> ${result.to}` });
  ```
  The delete handler mirrors it with `action: "web.delete"` and `confirm: req.body?.confirm === true`.
- Both routes carry `express.json({ limit: "8kb" })`, `requireApi`, `requireCsrf`, `writeRouteGate(…)`, and `allowsRoute(…, WRITE_CLASS)` → 403 `"Account does not have write permission"`.
- Error mapping: `WebEntryError.status` → that status with `{ error: message, code }`; `vault_unavailable` → 503; anything else → `next(error)`.
- `server.js:308` gains `resolveVaultRuntime: (id) => vaultScopeDeps?.resolveVaultRuntime(id) ?? null`.
- `renameWebEntry` dispatches on `entryKind`: folder → `renameWebFolder` (with `applyLinks` = a `createNotePlan` + `applyNotePlan` over `items`, using `baseRevision` from `fileRevision` — import both from `mutation-plans.js`), note → `renameWebNote`, attachment → `WebEntryError("Attachments cannot be renamed", 400)`.
- `deleteWebEntry` dispatches: folder → `deleteWebFolder`, else `deleteWebFile`.

- [ ] **Step 4: Run the tests**

Run: `cd app && node --test test/web-rename-delete-routes.test.js test/web-rename-delete.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
cd app && git add src/app/routes.js server.js src/app/web-rename-delete.js test/web-rename-delete-routes.test.js
git commit -m "feat(web): expose rename and safe delete, bound to the selected vault runtime"
```

---

### Task 5: Strings

**Files:**
- Modify: `app/src/i18n/messages/zh-CN.js`
- Modify: `app/src/i18n/messages/en.js`

**Interfaces:**
- Produces keys used by Tasks 6 and 7: `explorer.menu.label`, `explorer.menu.rename`, `explorer.menu.delete`, `explorer.menu.shortcutF2`, `explorer.rename.ariaNote`, `explorer.rename.ariaFolder`, `explorer.rename.placeholder`, `explorer.delete.confirm` (`{name}`), `explorer.delete.done`, `explorer.rename.done` (`{from}`,`{to}`), `explorer.rename.links` (`{count}`), `explorer.rename.failed`, `explorer.delete.failed`, `explorer.error.conflict`, `explorer.error.tooLarge`.

- [ ] **Step 1: Add the keys to both catalogs**

zh-CN: `重命名`、`安全删除`、`移到回收站`、`将「{name}」移到回收站？可以还原。`、`已移到回收站：{name}`、`已重命名为 {to}`、`另更新了 {count} 个笔记里的链接`、`重命名失败，请重试`、`删除失败，请重试`、`同名笔记或文件夹已存在`、`这个文件夹太大，请分批处理`。
en: the same keys in English.

- [ ] **Step 2: Run the catalog test**

Run: `cd app && node --test test/i18n-catalog.test.js`
Expected: PASS — both catalogs carry identical keys.

- [ ] **Step 3: Commit**

```bash
cd app && git add src/i18n/messages/zh-CN.js src/i18n/messages/en.js
git commit -m "feat(web): strings for the explorer rename and delete menu"
```

---

### Task 6: The context menu module

**Files:**
- Create: `app/frontend/app/features/explorer/context-menu.js`
- Test: `app/test/explorer-context-menu.test.js`

**Interfaces:**
- Consumes: `createPopupMenuController` from `app/frontend/app/ui/popup-menu.js`; `t` from `app/frontend/app/core/i18n.js`.
- Produces:
  - `export function targetFromRow(row) -> { kind: "folder" | "note" | "file" | "base", path } | null`
  - `export function createExplorerContextMenu({ host, documentRef, windowRef, onRename, onDelete }) -> { openFor(target, { anchor, viaKeyboard }), close(), itemFor(action), target(), destroy() }`
  - `export const ROW_SELECTOR = ".tree-folder-row, .tree-note-row, .tree-file-row, .tree-base-row";`

- [ ] **Step 1: Write the failing test**

Use `test/helpers/base-dom.mjs` (`createDomHarness`), as `test/document-tabs-menu.test.js` does:

```js
test("the menu opens on a right click and reports the row's kind and path", async () => {
  const { menu, doc } = mount([{ kind: "folder", path: "Projects" }]);
  doc.querySelector('[data-folder-path="Projects"]').dispatchEvent(new doc.defaultView.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  assert.equal(menu.target()?.path, "Projects");
  assert.equal(menu.itemFor("rename").textContent.includes("重命名"), true);
});

test("F2 renames the focused row and Shift+F10 opens the menu", async () => {
  const calls = [];
  const { menu, doc, host } = mount([{ kind: "note", path: "Top.md" }], { onRename: (target) => calls.push(target.path) });
  const row = doc.querySelector('[data-path="Top.md"]');
  row.focus();
  host.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
  assert.deepEqual(calls, ["Top.md"]);
  host.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
  assert.equal(menu.target()?.path, "Top.md");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd app && node --test test/explorer-context-menu.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

- Build one `div.tree-context-menu[role=menu]` with two `button[role=menuitem]` (`data-menu-action="rename" | "delete"`), the `F2` hint inside the rename item as `<kbd>`; append to `documentRef.body`, `hidden` until opened.
- `openFor(target, { anchor, viaKeyboard })`: set `data-menu-target`, enable both items, position with `computePopupLayout` + `applyPopupLayout` from `app/frontend/app/ui/popup-position.js`, then `controller.open({ viaKeyboard })`.
- `targetFromRow`: `.tree-folder-row` → `{ kind: "folder", path: row.dataset.folderPath }`; a name button inside → `dataset.path` with `kind` from `dataset.kind ?? "note"`.
- Delegated listeners on `host`: `contextmenu` (prevent default), `keydown` — `F2` → `onRename(focusedTarget)`, `ContextMenu` or `Shift+F10` → `openFor(focusedTarget, { viaKeyboard: true })`. `focusedTarget` = `targetFromRow(documentRef.activeElement?.closest(ROW_SELECTOR))`.
- A click on an item → `close()` then `onRename(target)` / `onDelete(target)`.

- [ ] **Step 4: Run the test**

Run: `cd app && node --test test/explorer-context-menu.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd app && git add frontend/app/features/explorer/context-menu.js test/explorer-context-menu.test.js
git commit -m "feat(web): explorer context menu with F2 and Shift+F10"
```

---

### Task 7: Wiring — rename row, delete confirm, controller

**Files:**
- Modify: `app/frontend/app/features/explorer/create-draft.js` (`renderActiveDraft`, line ~156)
- Modify: `app/frontend/app/features/explorer/controller.js` (next to `createEntries`, line ~418)
- Test: `app/test/explorer-rename-draft.test.js`

**Interfaces:**
- Consumes: Task 6's `createExplorerContextMenu`; Task 5's keys; the controller's `api`, `toast`, `state`, `openNote`.
- Produces: `createExplorerController(…)` returns two more seams: `rename(target)` and `removeEntry(target)`.

- [ ] **Step 1: Write the failing test**

```js
test("a rename draft prefills the current name and posts to /api/web/v1/rename on Enter", async () => {
  const posts = [];
  const { controller, doc } = mountController({ api: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return { kind: "note", from: "Top.md", to: "Home.md", updatedLinksIn: [] }; } });
  await controller.rename({ kind: "note", path: "Top.md" });
  const input = doc.querySelector(".note-create-input");
  assert.equal(input.value, "Top.md");
  input.value = "Home.md";
  input.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(posts[0].body.path, "Top.md");
  assert.deepEqual(posts[0].body.to, "Home.md");
  assert.match(posts[0].body.mutationId, /^web-rename:/);
});

test("Enter on an unchanged name writes nothing", async () => { /* no api call, row removed */ });
test("a conflict answers 409 and reopens the row with 同名 already exists", async () => { /* toast text from explorer.error.conflict */ });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd app && node --test test/explorer-rename-draft.test.js`
Expected: FAIL — `controller.rename is not a function`.

- [ ] **Step 3: Implement**

- `create-draft.js`: when `draft.mode === "rename"`, the input's `placeholder` is `t("explorer.rename.placeholder")` and `aria-label` is `t("explorer.rename.ariaNote")` / `ariaFolder` by kind. Nothing else changes: `draftCommitDecision` already cancels on an unchanged value.
- `controller.js`: `const contextMenu = createExplorerContextMenu({ host, onRename: (target) => rename(target), onDelete: (target) => removeEntry(target) });`
  - `rename(target)`: `beginDraft({ host, container: row of target.path, mode: "rename", kind, initialValue: basename, onCommit: async (name) => { const data = await api("/api/web/v1/rename", { method: "POST", body: JSON.stringify({ path: target.path, to: siblingPath(target.path, name), mutationId: \`web-rename:\${crypto.randomUUID()}\` }) }); … } })`; on success `toast(t("explorer.rename.done", { to: data.to }))`, plus `t("explorer.rename.links", { count })` when `updatedLinksIn.length`, then update `state.path` when it equals the old path, `openNote` is not called, `render()`.
  - Failure mapping: 409 → `t("explorer.error.conflict")`, 413 → `t("explorer.error.tooLarge")`, else `t("explorer.rename.failed")`; the row comes back because `onCommit` returns `false`.
  - `removeEntry(target)`: `if (!confirm(t("explorer.delete.confirm", { name: target.path }))) return false;` → `api("/api/web/v1/delete", { method: "POST", body: JSON.stringify({ path: target.path, confirm: true }) })` → toast `t("explorer.delete.done", …)`, close the note when `state.path === target.path` (`enterWelcome()` when available), `render()`.
  - `destroy()` must call `contextMenu.destroy()`.
  - Return `rename` and `removeEntry` from the controller object.

- [ ] **Step 4: Run the tests**

Run: `cd app && node --test test/explorer-rename-draft.test.js test/explorer-context-menu.test.js test/explorer-create-draft.test.js test/explorer-create-draft-interleave.test.js`
Expected: PASS (the two existing create-draft files must stay green — the rename mode may not change create behaviour).

- [ ] **Step 5: Rebuild the committed bundle and commit**

```bash
cd app && npm run build:web && git status --porcelain src/app/assets/app.js
git add frontend/app/features/explorer/create-draft.js frontend/app/features/explorer/controller.js test/explorer-rename-draft.test.js src/app/assets/app.js
git commit -m "feat(web): wire the explorer rename row, delete confirm and F2"
```

---

### Task 8: Gates, then the branch

**Files:** none new.

- [ ] **Step 1: Run the focused suites**

Run: `cd app && node --test test/web-rename-delete.test.js test/web-rename-delete-routes.test.js test/explorer-context-menu.test.js test/explorer-rename-draft.test.js test/i18n-catalog.test.js test/web-folder-route.test.js test/web-folder-readonly.test.js test/web-files-scope.test.js`
Expected: all pass.

- [ ] **Step 2: Run the architecture and syntax gate**

Run: `cd app && npm run check`
Expected: `architecture check passed for 1287 source files` (the count rises by the new module).

- [ ] **Step 3: Confirm the bundle is current**

Run: `cd app && npm run build:web && git status --porcelain`
Expected: no output (the committed bundle matches the source).

- [ ] **Step 4: Commit anything the gates changed, then open the PR**

```bash
cd /workspace/projects/obsidian-mcp-server/repo && git push -u origin feat/web-rename-delete
```

PR body: the defect (a folder the browser could not remove, and the escape-residue name), the two routes, the caps, the reviewer checklist from Review Focus, and the proof commands of Steps 1–3.
