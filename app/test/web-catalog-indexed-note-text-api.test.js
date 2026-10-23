// Contract + source guard for the *production* read API of the indexed note text.
//
// Background (P0 on PR #288): `store.testDb()` is declared in sqlite-store.js as an
// explicitly test-only hook ("the raw handle is not part of the production API"), yet
// `note-context-unlinked.js` reached through it to read `notes_fts.raw`. Production
// code must not depend on a test escape hatch. The fix adds the public, read-only
// `readIndexedNoteText(path)` accessor (one indexed lookup, never the Vault
// filesystem) and points the unlinked-mention route at it; `testDb` stays the
// test-only hook.
//
// The source guard below fails on the fix's own parent commit (that file referenced
// `store.testDb()`), so it is the regression that keeps the P0 from coming back.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

// The only production file allowed to mention the test-only handle is the module that
// declares it; every other `app/src/**` file must go through a public store method.
const TEST_HOOK_OWNER = "app/web-catalog/sqlite-store.js";

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

test("source guard: no production source reaches for the test-only raw handle", async () => {
  const files = await sourceFiles(SRC_ROOT);
  assert.ok(files.length > 100, `expected to scan the production tree, saw ${files.length} files`);
  const offenders = [];
  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file).replaceAll("\\", "/");
    if (relative === TEST_HOOK_OWNER) continue;
    const source = await fs.readFile(file, "utf8");
    if (/\btestDb\b/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], "production sources must use the public store API, never testDb()");
});

test("readIndexedNoteText is a public accessor that returns the indexed note text", () => {
  const store = openWebCatalogStore();
  try {
    store.upsertDirectory({ path: "Notes", name: "Notes" });
    const raw = "---\ntags: [u2]\n---\n# Alpha\n\nalpha body\n";
    store.upsertNote({ path: "Notes/Alpha.md", size: raw.length, raw, content: "alpha body" });

    assert.equal(typeof store.readIndexedNoteText, "function", "the store must expose the accessor");
    assert.equal(store.readIndexedNoteText("Notes/Alpha.md"), raw, "the indexed full text comes back verbatim");

    // Byte-for-byte the same value the pre-fix route obtained through the raw handle,
    // so routing the read through the public API cannot change the response.
    const legacy = store
      .testDb()
      .prepare("SELECT notes_fts.raw AS raw FROM notes_fts JOIN nodes ON nodes.fts_rowid = notes_fts.rowid WHERE nodes.path = ?")
      .get("Notes/Alpha.md").raw;
    assert.equal(store.readIndexedNoteText("Notes/Alpha.md"), legacy);

    // No FTS row (directory, Base, unknown path): null, so callers fail closed.
    assert.equal(store.readIndexedNoteText("Notes"), null);
    assert.equal(store.readIndexedNoteText("Nope.md"), null);

    // The test-only hook stays available to tests (it is not renamed or removed).
    assert.equal(typeof store.testDb, "function");
  } finally {
    store.close();
  }
});
