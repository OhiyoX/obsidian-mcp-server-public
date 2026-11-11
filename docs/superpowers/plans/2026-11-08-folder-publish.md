# Folder Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a whole folder as one continuing public collection with an opaque address, where a note's own `publish: true|false` overrides the folder and everything is invisible by default.

**Architecture:** The existing single document registry (`data/publish/state.json`) gains a `kind` field and a state version 3 migration. One new pure module decides visibility; one new module derives opaque per-item tokens; three new routes serve a folder record. The address never names a path, so the authorization contract (`GET /publish/:id` verifies one record id) is preserved.

**Tech Stack:** Node ESM, `node:test`, Express, the project's own `t()` catalogs and esbuild bundle.

**Spec:** `docs/superpowers/specs/2026-11-08-folder-publish-design.md`

## Global Constraints

- State file `data/publish/state.json` becomes `version: 3`; the loader accepts `1`, `2`, `3`; a v2 record loads as `kind: "document"`.
- Public addresses are opaque: a folder is `/publish/d/<43 base64url chars>`; an item inside is `/publish/d/<id>/n/<22 base64url chars>`. No path, no `..`, no absolute path in any URL.
- Visibility order: `private` hides, `public` shows, a descendant folder named `_*` or `.*` does not inherit, otherwise the folder decides. An unrecognised `publish:` value hides.
- Attachments stay unpublished: `sanitizePublicMarkdownBody` keeps replacing images with `附件未公开`; the publish CSP keeps `media-src 'none'`.
- Caps: 500 notes per folder record, depth 8. Refusals happen before any write: `publish_folder_too_large` 413, `publish_folder_too_deep` 413.
- Every new route needs a row in `src/authorization/catalog.js`; a route without a row fails the P0 gate.
- No user-visible literal text: every string goes through `t()` in `src/i18n/messages/{zh-CN,en}.js`; rebuild the committed bundle with `npm run build:web`.
- Never `fs.rm` user data: a delete moves to Vault Trash.
- Test with `DATA_PATH=/tmp/p4-data node --test --test-concurrency=1 <files>`; this checkout is CIFS, so esbuild needs the wrapper (`PATH=/tmp/esb:$PATH`).

## Review Focus

Each line names an input the spec implies but no task's happy path exercises. The test that pins it is in the task that owns the code.

1. A note deleted from disk while its folder record is published: the index must render without it, not 500. (Task 4)
2. A `publish: true` note inside a `_drafts/` subtree is visible, because the marker beats the draft rule. (Tasks 1, 4)
3. A folder published twice, or two requests at once, must leave one record, not two. (Task 3)
4. A note path with a space, a `#`, a `%`, or non-ASCII characters must round-trip through its token. (Task 4)
5. A published folder renamed outside the service (a Git push) leaves the old address 404 for ever, and re-creating a folder at the old path must not revive it. (Task 7)

---

### Task 1: Visibility predicate and marker reading

**Files:**
- Create: `app/src/publish/visibility.js`
- Test: `app/test/publish-visibility.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `readPublishMarker(data) -> "public" | "private" | "none"`; `isDraftSegment(name) -> boolean`; `visibilityOf({ marker, insidePublishedFolder, inDraftSubtree }) -> "visible" | "hidden"`; `PUBLISH_MARKER` frozen object.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-visibility.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readPublishMarker, isDraftSegment, visibilityOf } from "../src/publish/visibility.js";

test("the marker table", () => {
  assert.equal(readPublishMarker({ publish: true }), "public");
  assert.equal(readPublishMarker({ publish: false }), "private");
  assert.equal(readPublishMarker({ publish: "public" }), "public");
  assert.equal(readPublishMarker({ publish: "private" }), "private");
  assert.equal(readPublishMarker({ private: true }), "private");
  assert.equal(readPublishMarker({}), "none");
  assert.equal(readPublishMarker({ publish: "待定" }), "private", "an unknown value hides");
  assert.equal(readPublishMarker({ publish: false, private: true }), "private");
});

test("the six-row visibility table", () => {
  const cases = [
    ["public", false, false, "visible"],
    ["public", true, false, "visible"],
    ["private", true, false, "hidden"],
    ["private", false, false, "hidden"],
    ["none", true, false, "visible"],
    ["none", false, false, "hidden"],
    ["none", true, true, "hidden"],
    ["public", true, true, "visible"],
  ];
  for (const [marker, insidePublishedFolder, inDraftSubtree, expected] of cases) {
    assert.equal(visibilityOf({ marker, insidePublishedFolder, inDraftSubtree }), expected, `${marker}/${insidePublishedFolder}/${inDraftSubtree}`);
  }
});

test("a draft segment is _ or . prefixed", () => {
  assert.equal(isDraftSegment("_drafts"), true);
  assert.equal(isDraftSegment(".obsidian"), true);
  assert.equal(isDraftSegment("Notes"), false);
  assert.equal(isDraftSegment("_"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && node --test test/publish-visibility.test.js`
Expected: FAIL — `Cannot find module '../src/publish/visibility.js'`.

- [ ] **Step 3: Implement `app/src/publish/visibility.js`**

Pure, no imports from `node:fs`. `readPublishMarker` checks, in order: `data.private === true` → `"private"`; `data.publish === true` → `"public"`; `data.publish === false` → `"private"`; `data.publish === "public"` / `"private"` → that; absent → `"none"`; anything else → `"private"`.

`visibilityOf` short-circuits: `"private"` → `"hidden"`, `"public"` → `"visible"`, then `inDraftSubtree` → `"hidden"`, then `insidePublishedFolder ? "visible" : "hidden"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && node --test test/publish-visibility.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/publish/visibility.js app/test/publish-visibility.test.js
git commit -m "feat(publish): one pure visibility predicate for folder publishing"
```

---

### Task 2: Record kind and the version 3 migration

**Files:**
- Modify: `app/src/publish/service.js:57,164,70` (`STATE_VERSION`, loader, `publicRecord`)
- Modify: `app/src/publish/lifecycle.js:49-50,183-218` (`STATE_VERSION_TARGET`, `normalizeLegacyRecord`, `migratePublishState`)
- Test: `app/test/publish-record-kind.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `PUBLISH_RECORD_KINDS` frozen `{ DOCUMENT: "document", FOLDER: "folder" }` exported from `lifecycle.js`; `publicRecord(record)` now returns `kind`; `migratePublishState({version, records})` accepts `3` and keeps `kind`.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-record-kind.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { migratePublishState, PUBLISH_RECORD_KINDS } from "../src/publish/lifecycle.js";

test("a v2 record loads as a document and keeps its kind across a save", () => {
  const state = { version: 2, records: [{ id: "a", vaultId: "v", path: "n.md", lifecycle: "active", createdAt: "t", updatedAt: "t" }] };
  const migrated = migratePublishState(state);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.records[0].kind, "document");
});

test("a v3 folder record survives migration", () => {
  const state = { version: 3, records: [{ id: "b", kind: "folder", vaultId: "v", path: "Dir", lifecycle: "active", createdAt: "t", updatedAt: "t" }] };
  const migrated = migratePublishState(state);
  assert.equal(migrated.records[0].kind, PUBLISH_RECORD_KINDS.FOLDER);
});
```

Add a third test that saves and reloads through a `PublishService` pointed at a temporary `DATA_PATH`, and asserts `kind` is still `"folder"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-record-kind.test.js`
Expected: FAIL — `migrated.version` is `2`, `records[0].kind` is `undefined`.

- [ ] **Step 3: Implement**

`lifecycle.js`: `STATE_VERSION_TARGET = 3`; export `PUBLISH_RECORD_KINDS`; in `normalizeLegacyRecord` keep `kind: record.kind === "folder" ? "folder" : "document"`; `migratePublishState` treats `1`, `2`, `3` as loadable and writes `version: 3`.
`service.js`: `STATE_VERSION = 3`; the loader's version check accepts `1`, `2`, `3`; `publicRecord` adds `kind`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-record-kind.test.js test/publish-*.test.js`
Expected: PASS, and no earlier publish test regresses.

- [ ] **Step 5: Commit**

```bash
git add app/src/publish/service.js app/src/publish/lifecycle.js app/test/publish-record-kind.test.js
git commit -m "feat(publish): records carry a kind, state file moves to version 3"
```

---

### Task 3: A folder record passes the lifecycle planners

**Files:**
- Modify: `app/src/publish/service.js:104-118` (`probeRecordTarget`), `service.js:221-233` (`status`), `service.js:234-272` (`publish`)
- Modify: `app/src/publish/lifecycle.js:278-358` (`planPublish`), `:359-416` (`planResolve`)
- Modify: `app/src/publish/target.js` (directory branch and two codes)
- Test: `app/test/publish-folder-record.test.js`

**Interfaces:**
- Consumes: `PUBLISH_RECORD_KINDS`, `kind` on records (Task 2).
- Produces: `probeRecordTarget(vault, canonicalPath, kind)` returns `{ exists, isMarkdown, isDirectory }`; `planResolve` keeps a directory `active`; `normalizePublishTarget(userPath, { resolvePath, kind })` accepts `kind: "folder"` and returns `{ path, absolute, kind }`; new codes `PUBLISH_FOLDER_TOO_LARGE = "publish_folder_too_large"`, `PUBLISH_FOLDER_TOO_DEEP = "publish_folder_too_deep"` in `target.js`.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-folder-record.test.js
// A real temp Vault: Dir/a.md, Dir/sub/b.md, Dir/_drafts/c.md
test("publishing a directory creates a folder record that stays active", async () => {
  const service = new PublishService({ file: path.join(tmp, "publish", "state.json") });
  const published = await service.publish(vaultId, "Dir", { kind: "folder" });
  assert.equal(published.kind, "folder");
  assert.match(published.id, /^[A-Za-z0-9_-]{43}$/);
  const again = await service.resolve(published.id);
  assert.equal(again.record.lifecycle, "active", "a directory is never invalid");
});

test("a missing published directory becomes orphaned and never revives", async () => {
  await fs.rm(path.join(tmp, "Dir"), { recursive: true });
  assert.equal(await service.resolve(id), null);
  await fs.mkdir(path.join(tmp, "Dir"));
  assert.equal(await service.resolve(id), null, "an orphaned record is dead for ever");
});

test("publishing the same directory twice keeps one record", async () => {
  const [a, b] = await Promise.all([service.publish(vaultId, "Dir", { kind: "folder" }), service.publish(vaultId, "Dir", { kind: "folder" })]);
  assert.equal(a.id, b.id);
});

test("unpublishing a folder deletes the record and the address 404s", async () => {
  await service.revoke(vaultId, "Dir");
  assert.equal(await service.resolve(id), null);
  const records = await service.list({ vaultIds: [vaultId], includeInactive: true });
  assert.equal(records.filter((r) => r.path === "Dir").length, 0, "no tombstone is written");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-record.test.js`
Expected: FAIL — the directory is refused with `publish_target_missing`, because `normalizePublishTarget` appends `.md`.

- [ ] **Step 3: Implement**

`target.js`: add a `kind` parameter. For `kind: "folder"`, resolve the path without `assumeMarkdownTarget`, and require the stat to answer `isDirectory: true`; refuse a file with `PUBLISH_TARGET_NOT_A_FILE`. Keep the Markdown branch untouched for documents.
`service.js`: `#recordIndex` and `probeRecordTarget` take the record's `kind`; a folder record probes `stat().isDirectory()`. `status()` accepts a directory path for a folder record. `publish()` passes `kind` through; `revoke()` already deletes by path and needs no change. Caps are wired in Task 4, when the walker exists.
`lifecycle.js`: `planPublish` and `planResolve` treat the observation `{ exists: true, isDirectory: true }` as `active` when the record is a folder.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-record.test.js test/publish-*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/publish/service.js app/src/publish/lifecycle.js app/src/publish/target.js app/test/publish-folder-record.test.js
git commit -m "feat(publish): a folder record has its own probe and never turns invalid"
```

---

### Task 4: The folder walker, tokens and caps

**Files:**
- Create: `app/src/publish/folder-listing.js`
- Test: `app/test/publish-folder-listing.test.js`

**Interfaces:**
- Consumes: `visibilityOf`, `readPublishMarker`, `isDraftSegment` (Task 1); `PUBLISH_FOLDER_TOO_LARGE`, `PUBLISH_FOLDER_TOO_DEEP` (Task 3).
- Produces: `folderToken(folderId, relPath) -> string` (22 chars base64url); `listVisibleNotes({ vault, folderPath, folderId, limits }) -> { notes: [{ relPath, path, token, title }], truncated: boolean }`; `resolveToken({ vault, folderPath, folderId, token, limits }) -> { relPath, path } | null`; `assertWithinCaps({ vault, folderPath, limits }) -> void` throwing a `PublishTargetError`.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-folder-listing.test.js
test("the index lists visible notes and hides the rest", async () => {
  // Dir/a.md (no marker), Dir/b.md (publish:false), Dir/c.md (publish:true),
  // Dir/_drafts/d.md (no marker), Dir/_drafts/e.md (publish:true)
  const { notes } = await listVisibleNotes({ vault, folderPath: "Dir", folderId: id, limits: { maxNotes: 500, maxDepth: 8 } });
  assert.deepEqual(notes.map((n) => n.relPath).sort(), ["a.md", "c.md", "_drafts/e.md"]);
});

test("a token round-trips and never matches another record", async () => {
  const token = folderToken(id, "Dir/a.md");
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(await resolveToken({ vault, folderPath: "Dir", folderId: id, token, limits }));
  assert.equal(await resolveToken({ vault, folderPath: "Dir", folderId: "other", token, limits }), null);
});

test("a path with a space, a # and non-ASCII round-trips", async () => {
  const token = folderToken(id, "Dir/我的 笔记#1.md");
  assert.ok(await resolveToken({ vault, folderPath: "Dir", folderId: id, token, limits }));
});

test("a private note and a traversal attempt resolve to nothing", async () => {
  assert.equal(await resolveToken({ vault, folderPath: "Dir", folderId: id, token: folderToken(id, "Dir/b.md"), limits }), null);
  assert.equal(await resolveToken({ vault, folderPath: "Dir", folderId: id, token: folderToken(id, "Dir/../secret.md"), limits }), null);
});

test("the caps refuse before any write", async () => {
  // 501 notes in Dir2
  const before = await fs.readFile(stateFile, "utf8");
  await assert.rejects(() => assertWithinCaps({ vault, folderPath: "Dir2", limits: { maxNotes: 500, maxDepth: 8 } }), (e) => e.code === "publish_folder_too_large");
  await assert.rejects(() => service.publish(vaultId, "Dir2", { kind: "folder" }), (e) => e.code === "publish_folder_too_large");
  assert.equal(await fs.readFile(stateFile, "utf8"), before, "a refusal writes nothing");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-listing.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/src/publish/folder-listing.js`**

`folderToken` is `createHash("sha256").update(`${folderId}\0${relPath}`).digest("base64url").slice(0, 22)`.
The walker sorts entries by name, skips a descendant directory whose name `isDraftSegment`, reads each `.md`, parses frontmatter with the project's `parseFrontmatter`, and keeps a note when `visibilityOf(...)` says `"visible"`. It stops at `maxNotes` and sets `truncated: true`; it refuses a tree deeper than `maxDepth` with `PUBLISH_FOLDER_TOO_DEEP`.
`resolveToken` walks the same way with the same caps and returns the entry whose token matches, so a traversal string simply never matches.
Also wire the caps into the registry: `PublishService.publish()` calls `assertWithinCaps` for `kind: "folder"` before it writes anything, so the refusal leaves `state.json` byte-identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-listing.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/publish/folder-listing.js app/test/publish-folder-listing.test.js
git commit -m "feat(publish): a bounded folder walker with opaque per-item tokens"
```

---

### Task 5: The three public routes

**Files:**
- Modify: `app/src/app/routes.js:215-229` (add the folder routes beside `GET /publish/:id`)
- Modify: `app/src/app/pages.js` (new `publishFolderPage`)
- Modify: `app/src/publish/service.js` (`resolve` returns `kind`; a folder record resolves its directory)
- Modify: `app/src/authorization/catalog.js` (capability + boundary row)
- Modify: `app/src/authorization/adapters/publish.js:22` (boundary as an input)
- Test: `app/test/publish-folder-routes.test.js`

**Interfaces:**
- Consumes: `listVisibleNotes`, `resolveToken`, `folderToken` (Task 4).
- Produces: `GET /publish/d/:id`, `GET /publish/d/:id/n/:token`; catalog operation `publish_folder_read` (`plane: "content"`, `targetKind: "publication"`, `contentEffect: "read"`, `grantable: false`, `oauthScopes: NO_SCOPES`) and the boundary rows for both routes; `publicationAuthorizationRequest({ id, boundary = "GET /publish/:id" })`.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-folder-routes.test.js
test("the index lists visible notes only", async () => {
  const res = await get(`/publish/d/${id}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /a\.md|我的笔记/);
  assert.doesNotMatch(res.text, /b\.md/, "a private note is never listed");
});

test("a note route serves its body and refuses a private note with 404", async () => {
  assert.equal((await get(`/publish/d/${id}/n/${folderToken(id, "Dir/a.md")}`)).status, 200);
  assert.equal((await get(`/publish/d/${id}/n/${folderToken(id, "Dir/b.md")}`)).status, 404);
});

test("a malformed or unknown id is 404, and %2e%2e never reaches a file", async () => {
  assert.equal((await get("/publish/d/short")).status, 404);
  assert.equal((await get(`/publish/d/${otherId}/n/${folderToken(id, "Dir/a.md")}`)).status, 404);
  assert.equal((await get(`/publish/d/${id}/n/..%2F..%2Fsecret.md`)).status, 404);
});

test("a note deleted while the folder is published does not 500 the index", async () => {
  await fs.rm(path.join(tmp, "Dir/a.md"));
  assert.equal((await get(`/publish/d/${id}`)).status, 200);
});

test("a publish:true note in an unpublished folder loads, and no sibling is reachable", async () => {
  // Free/only.md has publish:true; Free/other.md has no marker; Free is not published
  const record = (await service.list({ vaultIds: [vaultId] })).find((r) => r.path === "Free/only.md");
  assert.equal((await get(`/publish/${record.id}`)).status, 200);
  const body = (await get(`/publish/${record.id}`)).text;
  assert.doesNotMatch(body, /other/, "a sibling is never named, linked or listed");
});

test("every new route has a catalog row", () => {
  assert.equal(capabilityForBoundary("GET /publish/d/:id"), "publish_folder_read");
  assert.equal(capabilityForBoundary("GET /publish/d/:id/n/:token"), "publish_folder_read");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-routes.test.js`
Expected: FAIL — 404 for the index, and `capabilityForBoundary(...)` returns `null`.

- [ ] **Step 3: Implement**

Routes mirror the existing `GET /publish/:id`: validate the id shape first, resolve through `publishService.resolve`, answer 404 on any refusal, set `X-Robots-Tag` and the same CSP. `publishFolderPage({ title, notes, publishedAt, locale })` renders a list of links to the token routes; every string through `t()`.
`adapters/publish.js` takes the boundary as a parameter so both rows work; keep the default so the document route is unchanged.
`catalog.js` adds the descriptor and both boundary rows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-routes.test.js test/authorization-catalog.test.js test/authorization-*.test.js`
Expected: PASS, and the catalog test's boundary count is updated deliberately.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/routes.js app/src/app/pages.js app/src/publish/service.js app/src/authorization/catalog.js app/src/authorization/adapters/publish.js app/test/publish-folder-routes.test.js
git commit -m "feat(publish): serve a folder index and its notes by opaque token"
```

---

### Task 6: `publish: true` gets its own address

**Files:**
- Create: `app/src/publish/materialize.js`
- Modify: `app/src/app/web-catalog/indexer.js:203` (`createVaultCatalogSource` gains `onNoteRead`)
- Modify: `app/src/app/web-catalog/runtime.js:193` (`createDefaultRuntime` passes the observer)
- Modify: `server.js` (set the observer once)
- Test: `app/test/publish-materialize.test.js`

**Interfaces:**
- Consumes: `readPublishMarker` (Task 1), `PublishService.publish`/`revoke` (Task 3).
- Produces: `syncNotePublishRecord({ service, vault, relPath, data }) -> "created" | "retired" | "unchanged"`; `createVaultCatalogSource({ ..., onNoteRead = null })`; `setCatalogNoteReadObserver(fn)` exported from `runtime.js`.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-materialize.test.js
test("a marked note gets one record and an address", async () => {
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/n.md", data: { publish: true } }), "created");
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/n.md", data: { publish: true } }), "unchanged");
  const records = await service.list({ vaultIds: [vault.id] });
  assert.equal(records.filter((r) => r.path === "Free/n.md").length, 1);
});

test("removing the marker retires the record and the address 404s", async () => {
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/n.md", data: {} }), "retired");
  assert.equal(await service.list({ vaultIds: [vault.id] }).then((r) => r.length), 0);
});

test("publish:false never creates a record", async () => {
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/m.md", data: { publish: false } }), "unchanged");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-materialize.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`materialize.js` reads the marker, then publishes (create) or revokes (retire) through the service, and returns `"unchanged"` when the marker is not `"public"` and there is no record. `createVaultCatalogSource` calls `onNoteRead(vault, read)` after a successful `upsertCatalogRead`, wrapped so a throw is logged and never fails the index. `runtime.js` holds the observer in a module variable set by `setCatalogNoteReadObserver`; `server.js` sets it to `syncNotePublishRecord`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-materialize.test.js test/web-catalog-*.test.js`
Expected: PASS, and the catalog tests still pass with no observer.

- [ ] **Step 5: Commit**

```bash
git add app/src/publish/materialize.js app/src/app/web-catalog/indexer.js app/src/app/web-catalog/runtime.js server.js app/test/publish-materialize.test.js
git commit -m "feat(publish): a publish:true note keeps its own public address"
```

---

### Task 7: Rename and delete follow the record

**Files:**
- Modify: `app/src/app/web-rename-delete.js:292` (`renameWebEntry`)
- Modify: `app/src/publish/service.js` (new `moveRecord(vaultId, from, to)`)
- Test: `app/test/publish-folder-move.test.js`

**Interfaces:**
- Consumes: folder records (Task 3).
- Produces: `service.moveRecord(vaultId, fromPath, toPath) -> boolean` — rewrites the record's `path` inside one mutation, `false` when there is no record at `fromPath`.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-folder-move.test.js
test("renaming a published folder keeps its address", async () => {
  const before = await service.publish(vaultId, "Dir", { kind: "folder" });
  await renameWebEntry(vault, runtime, { path: "Dir", to: "Dir2", mutationId: "web-rename:test" });
  assert.ok(await service.resolve(before.id), "the same id still resolves");
  assert.equal((await service.resolve(before.id)).record.path, "Dir2");
});

test("a deleted published folder orphans its record", async () => {
  const rec = await service.publish(vaultId, "Gone", { kind: "folder" });
  await deleteWebEntry(vault, runtime, { path: "Gone", confirm: true, mutationId: "web-delete:test" });
  assert.equal(await service.resolve(rec.id), null);
});

test("a rename outside the service orphans the record for ever", async () => {
  await fs.rename(path.join(tmp, "Dir2"), path.join(tmp, "Dir3"));
  assert.equal(await service.resolve(id), null);
  await fs.rename(path.join(tmp, "Dir3"), path.join(tmp, "Dir2"));
  assert.equal(await service.resolve(id), null, "re-creating the old path does not revive the record");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-move.test.js`
Expected: FAIL — after the rename the record still names `Dir`, so `resolve` answers `null`.

- [ ] **Step 3: Implement**

`renameWebEntry` calls `publishService.moveRecord(vault.id, from, to)` after the directory move succeeds and before it returns, and a failure there is logged, not thrown, so a rename never half-fails. `moveRecord` rewrites `path` and `updatedAt` inside `#enqueue`, then saves.
A folder delete already moves the directory to Trash through the same module; because the path is then gone, the next `resolve` answers `orphaned` and 404. Add the assertion to this task's test rather than a new hook.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-folder-move.test.js test/explorer-wiring-seams.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/web-rename-delete.js app/src/publish/service.js app/test/publish-folder-move.test.js
git commit -m "feat(publish): a folder record follows a server-side rename"
```

---

### Task 8: The surfaces: MCP, Web menu, Admin, search

**Files:**
- Modify: `app/src/tools/publish.js:83,95-142` (accept a directory, build the folder path)
- Modify: `app/src/tool-contracts.js:87-88` (widened payload, recorded)
- Modify: `app/src/app/web-catalog/search-api.js:61` (`resolvePublishedPaths` unions folder members)
- Modify: `app/src/app/routes.js:421` (folder public path)
- Modify: `app/src/admin/pages/publishes.js` (a `kind` cell and the visible count)
- Modify: `app/src/app/assets/app.js` and `app/src/i18n/messages/{zh-CN,en}.js` (menu items)
- Test: `app/test/publish-surfaces.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `manage_publish({ action, path, kind })` accepts `kind: "folder"`; `publicPathOf(record) -> "/publish/<id>" | "/publish/d/<id>"` in `service.js`, used by both builders.

- [ ] **Step 1: Write the failing test**

```js
// app/test/publish-surfaces.test.js
test("published=true matches notes inside a published folder", async () => {
  await service.publish(vaultId, "Dir", { kind: "folder" });
  const paths = await resolvePublishedPaths(service, vaultId);
  assert.ok(paths.has("Dir/a.md"), "a folder member counts as published");
  assert.equal(paths.has("Dir/b.md"), false, "a private note does not");
});

test("publicPathOf picks the shape from the kind", () => {
  assert.equal(publicPathOf({ id: "x", kind: "document" }), "/publish/x");
  assert.equal(publicPathOf({ id: "y", kind: "folder" }), "/publish/d/y");
});

test("the tool accepts a directory and its payload carries the folder path", async () => {
  const out = await callTool("manage_publish", { action: "publish", path: "Dir", kind: "folder" });
  assert.equal(out.publicPath, `/publish/d/${out.publicPath.split("/").pop()}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-surfaces.test.js`
Expected: FAIL — `publicPathOf` is not exported; the folder member is missing from the set.

- [ ] **Step 3: Implement**

`publicPathOf` replaces both inline builders. `resolvePublishedPaths` adds the members of each folder record, computed with `listVisibleNotes`. The MCP tool passes `kind` and validates it, and maps `publish_folder_too_large` / `publish_folder_too_deep` to HTTP 413 with the existing error envelope. The explorer menu calls `POST /api/web/v1/publish` with the folder path; both menu labels go through `t()`. Rebuild the bundle.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && DATA_PATH=/tmp/p4-data node --test test/publish-surfaces.test.js test/tool-contracts*.test.js test/i18n*.test.js && npm run check`
Expected: PASS. The contract drift test either passes or fails with the exact new field list; update `tool-contracts.js` only for the fields the test names.

- [ ] **Step 5: Commit**

```bash
git add -A app/src && git commit -m "feat(publish): publish a folder from MCP and the explorer"
```

---

## Execution Handoff

Run Task 1 to Task 8 in order; every task is green before the next starts. After Task 8, one whole-branch review, then `npm run check` plus the release gates in `docs/RELEASE_AND_DEPLOY.md`.
