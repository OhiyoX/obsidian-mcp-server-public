// Wave F / F1 — real dual-Vault matrix for the tools the Wave D lane matrices did not invoke.
//
// Why this file exists (§31 "complete full matrix"): the Wave D matrices each prove *their* toolset;
// a per-tool audit of the 87 canonical tools against every `multi-vault-*matrix*` suite showed 26
// vault-scoped tools whose behaviour was never driven through the production registration chain.
// "Not covered by a lane" was NOT evidence of "needs no coverage", so this file drives them against
// a real primary + secondary Vault pair and asserts on-disk effects, isolation and fail-closed
// refusals. `multi-vault-full-matrix.test.js` freezes the per-tool coverage table that points here.
//
// Contract authority: §29 (a REAL two-Vault matrix per toolset), §10.1 (the request runtime seam),
// §13.4 (cross-call handles are Vault-bound), §21 MV-I01/I02/I03/I07, §42 SEC-MV01/SEC-MV06,
// §47 (no secondary → primary fallback, no partial support claim).
//
// Matrix scope here: `pull_note_file`, `pull_file`, `patch_note`, `replace_in_note`, the upload
// face (`start_file_upload`/`file_upload_status`/`upload_file_chunk`/`cancel_file_upload`), the
// archive face (`create_archive`/`inspect_archive`/`read_archive_entry`/`extract_archive`), the
// canvas face (`get_canvas`/`write_canvas`), the link/graph readers (`get_backlinks`,
// `get_unresolved_links`, `get_orphans`, `get_deadends`), `find_related`, `suggest_links`, the
// workflow face (`daily_note`, `list_templates`, `create_from_template`, `rename_property`,
// `set_property_type`), and `git_pull`/`git_push` (the git face's remote operations).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";

import { PRIMARY_ID, SECONDARY_ID, configureDualVaultEnv, createDualVaultHarness } from "./helpers/multi-vault-f1-harness.js";

const env = await configureDualVaultEnv({ prefix: "obsidian-mv-f1-gap-" });
const SECONDARY_ROOT = env.secondaries[SECONDARY_ID];
const PRIMARY_ROOT = env.primaryRoot;
// The secondary's A7 data root (§3.3/§5.2): `<DATA_PATH>/vaults/<sha256(vaultId)>`.
const SECONDARY_DATA = path.join(env.dataRoot, "vaults", createHash("sha256").update(SECONDARY_ID).digest("hex"));

const BINARY = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x7f, 0x80]);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Same relative path in BOTH Vaults, different content: the isolation discriminator. */
async function seedVault(root, marker) {
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
  await fs.mkdir(path.join(root, "Templates"), { recursive: true });
  await fs.writeFile(path.join(root, "notes", "same.md"), `---\nstatus: ${marker}-status\n---\n# same\n\n${marker}-marker shared-topic\n\n[[leaf]]\n`);
  await fs.writeFile(path.join(root, "notes", "other.md"), `# other ${marker}\n\nshared-topic ${marker}-only-word\n`);
  await fs.writeFile(path.join(root, "leaf.md"), `# leaf ${marker}\n`);
  await fs.writeFile(path.join(root, "orphan.md"), `# orphan ${marker}\n`);
  await fs.writeFile(path.join(root, "assets", "data.bin"), Buffer.concat([BINARY, Buffer.from(marker)]));
  await fs.writeFile(path.join(root, "canvas.base.json"), "{\"nodes\":[],\"edges\":[]}\n");
  await fs.writeFile(path.join(root, "Templates", "T1.md"), `# {{title}}\n\n${marker} template\n`);
  await fs.writeFile(path.join(root, ".obsidian", "templates.json"), `${JSON.stringify({ folder: "Templates" })}\n`);
  await fs.writeFile(path.join(root, ".obsidian", "daily-notes.json"), `${JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD", template: "T1" })}\n`);
}

await seedVault(SECONDARY_ROOT, "secondary");
await seedVault(PRIMARY_ROOT, "primary");

const harness = await createDualVaultHarness(env);
const { map, treeSnapshot, exists, drainAll } = harness;
after(async () => { await harness.teardown(); });

const primaryBefore = await treeSnapshot(PRIMARY_ROOT);
const assertPrimaryUntouched = async () => assert.deepEqual(await treeSnapshot(PRIMARY_ROOT), primaryBefore, "the primary Vault must be untouched");

// ---------------------------------------------------------------------------------------------
// 1. §29 notes/files read + in-place edit face
// ---------------------------------------------------------------------------------------------

test("§29: pull/patch/replace/canvas resolve the selected Vault's own bytes", async () => {
  const client = await harness.toolClient();
  try {
    // `pull_note_file`: same path, two Vaults, two different documents.
    const secondaryNote = await client.call("pull_note_file", { vaultId: SECONDARY_ID, path: "notes/same.md", encoding: "text" });
    assert.equal(secondaryNote.path, "notes/same.md");
    assert.match(secondaryNote.content, /secondary-marker/);
    assert.doesNotMatch(secondaryNote.content, /primary-marker/);
    const primaryNote = await client.call("pull_note_file", { path: "notes/same.md", encoding: "text" });
    assert.match(primaryNote.content, /primary-marker/, "omitting vaultId keeps the legacy primary path (MV-I07)");

    // `pull_file`: the binary face.
    const secondaryBin = await client.call("pull_file", { vaultId: SECONDARY_ID, path: "assets/data.bin" });
    assert.equal(Buffer.from(secondaryBin.content, "base64").subarray(0, BINARY.length).equals(BINARY), true);
    assert.match(Buffer.from(secondaryBin.content, "base64").toString("latin1"), /secondary$/);

    // `patch_note` (frontmatter target) and `replace_in_note` rewrite only the secondary file.
    const patched = await client.call("patch_note", { vaultId: SECONDARY_ID, path: "notes/same.md", targetType: "frontmatter", target: "status", operation: "replace", content: "patched" });
    assert.equal(patched.path, "notes/same.md");
    const replaced = await client.call("replace_in_note", { vaultId: SECONDARY_ID, path: "notes/same.md", replacements: [{ search: "secondary-marker", replace: "replaced-marker" }] });
    assert.equal(replaced.path, "notes/same.md");
    const after = await fs.readFile(path.join(SECONDARY_ROOT, "notes", "same.md"), "utf8");
    assert.match(after, /status: patched/);
    assert.match(after, /replaced-marker/);
    assert.doesNotMatch(after, /primary-marker/);

    // Canvas face: write into the secondary, read back the secondary's own canvas.
    const canvas = { nodes: [{ id: "n1", type: "text", text: "secondary canvas", x: 1, y: 2, width: 10, height: 10 }], edges: [] };
    const written = await client.call("write_canvas", { vaultId: SECONDARY_ID, path: "boards/plan.canvas", canvas, overwrite: true });
    assert.equal(written.path, "boards/plan.canvas");
    assert.equal(written.created, true);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "boards", "plan.canvas")), true);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "boards", "plan.canvas")), false);
    const readBack = await client.call("get_canvas", { vaultId: SECONDARY_ID, path: "boards/plan.canvas" });
    assert.deepEqual(readBack.canvas.nodes.map((node) => node.id), ["n1"]);
    assert.equal((await fs.stat(path.join(SECONDARY_ROOT, "boards", "plan.canvas"))).isFile(), true);
  } finally {
    await client.close();
  }
  await assertPrimaryUntouched();
});

// ---------------------------------------------------------------------------------------------
// 2. §13.4 transfer face + the archive face
// ---------------------------------------------------------------------------------------------

test("§29/§13.4: the upload face is Vault-bound end to end and archives stay inside one Vault", async () => {
  const client = await harness.toolClient();
  const payload = Buffer.from(`secondary upload ${Date.now()}\n`);
  try {
    const started = await client.call("start_file_upload", { vaultId: SECONDARY_ID, path: "assets/upload.bin", totalBytes: payload.length, sha256: sha256(payload), overwrite: true });
    assert.equal(typeof started.uploadId, "string");
    // §13.4: the durable metadata lives under THIS Vault's A7 transfers root and carries the Vault id.
    const metadataFile = path.join(SECONDARY_DATA, "transfers", "uploads", `${started.uploadId}.json`);
    assert.equal(await exists(metadataFile), true, "the upload metadata must live under the secondary's own A7 root");
    assert.equal(JSON.parse(await fs.readFile(metadataFile, "utf8")).vaultId, SECONDARY_ID);
    assert.equal(await exists(path.join(env.dataRoot, "transfers", "uploads", `${started.uploadId}.json`)), false, "never the primary legacy transfers root");

    assert.equal((await client.call("file_upload_status", { vaultId: SECONDARY_ID, uploadId: started.uploadId })).totalBytes, payload.length);
    // A handle is bound to its Vault: another Vault may not drive it (§13.4/§47).
    const crossed = await client.attempt("file_upload_status", { vaultId: PRIMARY_ID, uploadId: started.uploadId });
    assert.equal(crossed.isError, true, "a handle from another Vault must be refused");

    const finished = await client.call("upload_file_chunk", { vaultId: SECONDARY_ID, uploadId: started.uploadId, offset: 0, base64: payload.toString("base64"), finalize: true });
    assert.equal(finished.complete, true);
    assert.equal(finished.sha256, sha256(payload));
    assert.equal(await fs.readFile(path.join(SECONDARY_ROOT, "assets", "upload.bin"), "utf8"), payload.toString("utf8"));
    assert.equal(await exists(path.join(PRIMARY_ROOT, "assets", "upload.bin")), false);

    // A cancelled upload leaves no payload behind in either Vault.
    const cancelledUpload = await client.call("start_file_upload", { vaultId: SECONDARY_ID, path: "assets/cancelled.bin", totalBytes: 4, overwrite: true });
    const cancelled = await client.call("cancel_file_upload", { vaultId: SECONDARY_ID, uploadId: cancelledUpload.uploadId });
    assert.equal(cancelled.cancelled, true);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "assets", "cancelled.bin")), false);
    assert.equal(await exists(path.join(SECONDARY_DATA, "transfers", "uploads", `${cancelledUpload.uploadId}.part`)), false, "the staged payload must be removed");

    // Archive face: create → inspect → read entry → extract, all inside the selected Vault.
    const archive = await client.call("create_archive", { vaultId: SECONDARY_ID, sourcePaths: ["notes/same.md", "assets/data.bin"], destination: "out/bundle.zip", overwrite: true });
    assert.equal(archive.path, "out/bundle.zip");
    assert.equal(await exists(path.join(SECONDARY_ROOT, "out", "bundle.zip")), true);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "out", "bundle.zip")), false);
    const inspected = await client.call("inspect_archive", { vaultId: SECONDARY_ID, path: "out/bundle.zip" });
    const entryNames = inspected.entries.map((entry) => entry.path);
    assert.deepEqual([...entryNames].sort(), ["assets/data.bin", "notes/same.md"]);
    const entry = await client.call("read_archive_entry", { vaultId: SECONDARY_ID, archivePath: "out/bundle.zip", entry: "notes/same.md", maxBytes: 65536 });
    assert.match(String(entry.content ?? entry.text ?? ""), /replaced-marker/, "the entry must be the selected Vault's own file");
    const extracted = await client.call("extract_archive", { vaultId: SECONDARY_ID, archivePath: "out/bundle.zip", destinationDirectory: "restored", dryRun: false, overwrite: true });
    assert.equal(extracted.dryRun, false);
    assert.equal(await exists(path.join(SECONDARY_ROOT, "restored", "notes", "same.md")), true);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "restored")), false);
  } finally {
    await client.close();
  }
  await assertPrimaryUntouched();
});

// ---------------------------------------------------------------------------------------------
// 3. §29 workflow face: daily notes, templates, property registry
// ---------------------------------------------------------------------------------------------

test("§29 workflows: daily_note/templates/property tools read and write the selected Vault only", async () => {
  const client = await harness.toolClient();
  try {
    const templates = await client.call("list_templates", { vaultId: SECONDARY_ID, includeContent: true });
    assert.deepEqual(templates.templates.map((entry) => entry.path), ["Templates/T1.md"]);
    assert.match(templates.templates[0].content, /secondary template/);
    assert.doesNotMatch(templates.templates[0].content, /primary template/);

    const created = await client.call("create_from_template", { vaultId: SECONDARY_ID, template: "T1", path: "notes/from-template.md", date: "2026-10-07" });
    assert.equal(created.path, "notes/from-template.md");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "from-template.md"), "utf8"), /secondary template/);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "notes", "from-template.md")), false);

    const daily = await client.call("daily_note", { vaultId: SECONDARY_ID, action: "create", date: "2026-10-07" });
    assert.equal(daily.path, "Journal/2026-10-07.md");
    assert.equal(await exists(path.join(SECONDARY_ROOT, "Journal", "2026-10-07.md")), true);
    assert.equal(await exists(path.join(PRIMARY_ROOT, "Journal")), false);
    assert.equal((await client.call("daily_note", { vaultId: SECONDARY_ID, action: "path", date: "2026-10-07" })).exists, true);

    const renamed = await client.call("rename_property", { vaultId: SECONDARY_ID, from: "status", to: "state", dryRun: false, limit: 50 });
    assert.ok(renamed.changed.length >= 1, "the secondary note's property must be renamed");
    assert.match(await fs.readFile(path.join(SECONDARY_ROOT, "notes", "same.md"), "utf8"), /state: /);
    assert.match(await fs.readFile(path.join(PRIMARY_ROOT, "notes", "same.md"), "utf8"), /status: primary-status/, "the primary note keeps its own frontmatter");

    await client.call("set_property_type", { vaultId: SECONDARY_ID, name: "rating", type: "number" });
    const secondaryTypes = JSON.parse(await fs.readFile(path.join(SECONDARY_ROOT, ".obsidian", "types.json"), "utf8"));
    assert.equal(secondaryTypes.rating, "number");
    assert.equal(await exists(path.join(PRIMARY_ROOT, ".obsidian", "types.json")), false, "the primary Vault has no types.json");
  } finally {
    await client.close();
  }
  await assertPrimaryUntouched();
});

// ---------------------------------------------------------------------------------------------
// 4. §29 index-backed link/graph readers + related-note suggestions
// ---------------------------------------------------------------------------------------------

test("§29: link/graph readers and related-note tools answer from the selected Vault's index", async () => {
  const client = await harness.toolClient();
  try {
    const backlinks = await client.call("get_backlinks", { vaultId: SECONDARY_ID, path: "leaf.md" });
    // The secondary's own copy of `same.md` (test 2 extracted an archive copy) links [[leaf]]; what
    // must never appear is another Vault's note, and the answer must come from this Vault's index.
    const backlinkPaths = [...new Set(backlinks.backlinks.map((entry) => entry.path))].sort();
    assert.ok(backlinkPaths.includes("notes/same.md"), `the secondary's own backlink must be reported: ${JSON.stringify(backlinkPaths)}`);
    assert.ok(backlinkPaths.every((entry) => entry.endsWith("notes/same.md")), `every backlink must be this Vault's copy: ${JSON.stringify(backlinkPaths)}`);
    for (const entry of backlinkPaths) assert.equal(await exists(path.join(SECONDARY_ROOT, entry)), true, `${entry} must exist inside the secondary Vault`);
    assert.equal(backlinkPaths.some((entry) => String(entry).includes("primary")), false);

    const unresolved = await client.call("get_unresolved_links", { vaultId: SECONDARY_ID, limit: 50 });
    assert.deepEqual(unresolved.links, []);

    const orphans = await client.call("get_orphans", { vaultId: SECONDARY_ID, limit: 50 });
    const orphanPaths = orphans.notes.map((entry) => entry.path);
    assert.ok(orphanPaths.includes("orphan.md"), `the secondary's orphan must be reported: ${JSON.stringify(orphanPaths)}`);
    assert.equal(orphanPaths.some((entry) => String(entry).includes("primary")), false);

    const deadends = await client.call("get_deadends", { vaultId: SECONDARY_ID, limit: 50 });
    const deadendPaths = deadends.notes.map((entry) => entry.path);
    assert.equal(deadendPaths.some((entry) => String(entry).includes("primary")), false);

    // `find_related` / `suggest_links` read THIS Vault's retrieval index. Build both Vaults' indexes
    // and prove the ranking never crosses corpora (vault-relative paths are identical in both, so
    // the discriminator is the content of each hit, exactly like the search lane's matrix).
    await client.call("reindex_vault", { vaultId: SECONDARY_ID });
    await drainAll();
    const related = await client.call("find_related", { vaultId: SECONDARY_ID, path: "notes/same.md", semantic: false, limit: 10 });
    assert.ok(related.results.length >= 1, "the secondary's own corpus must produce related notes");
    const relatedText = JSON.stringify(related.results);
    assert.match(relatedText, /secondary-only-word/);
    assert.doesNotMatch(relatedText, /primary-only-word/);
    assert.equal(related.results.some((entry) => String(entry.path).includes("primary")), false);

    const suggested = await client.call("suggest_links", { vaultId: SECONDARY_ID, path: "notes/same.md", semantic: false, limit: 10 });
    const suggestedText = JSON.stringify(suggested.suggestions);
    assert.doesNotMatch(suggestedText, /primary-only-word/);
    assert.ok(suggested.suggestions.every((entry) => !entry.directlyLinked), "suggestions must exclude already-linked notes");

    // Reverse direction: the primary's own lookup never sees the secondary corpus.
    await client.call("reindex_vault", {});
    await drainAll();
    const primaryRelated = await client.call("find_related", { path: "notes/same.md", semantic: false, limit: 10 });
    const primaryText = JSON.stringify(primaryRelated.results);
    assert.match(primaryText, /primary-only-word/);
    assert.doesNotMatch(primaryText, /secondary-only-word/);
  } finally {
    await client.close();
  }
  await drainAll();
  await assertPrimaryUntouched();
});

// ---------------------------------------------------------------------------------------------
// 5. §47 — every gap tool refuses an unknown/unmaterialized Vault before its handler runs
// ---------------------------------------------------------------------------------------------

test("§47: the gap tools refuse an unknown Vault structurally and touch no Vault", async () => {
  const client = await harness.toolClient();
  const secondaryBefore = await treeSnapshot(SECONDARY_ROOT);
  const calls = [
    ["pull_note_file", { path: "notes/same.md" }],
    ["pull_file", { path: "assets/data.bin" }],
    ["patch_note", { path: "notes/same.md", targetType: "frontmatter", target: "status", content: "x" }],
    ["replace_in_note", { path: "notes/same.md", replacements: [{ search: "a", replace: "b" }] }],
    ["start_file_upload", { path: "assets/x.bin", totalBytes: 4 }],
    ["file_upload_status", { uploadId: "00000000-0000-4000-8000-000000000000" }],
    ["upload_file_chunk", { uploadId: "00000000-0000-4000-8000-000000000000", offset: 0, base64: "AAAA", finalize: false }],
    ["cancel_file_upload", { uploadId: "00000000-0000-4000-8000-000000000000" }],
    ["create_archive", { sourcePaths: ["notes/same.md"], destination: "out/x.zip" }],
    ["inspect_archive", { path: "out/x.zip" }],
    ["read_archive_entry", { archivePath: "out/x.zip", entry: "notes/same.md" }],
    ["extract_archive", { archivePath: "out/x.zip" }],
    ["get_canvas", { path: "boards/plan.canvas" }],
    ["write_canvas", { path: "boards/plan.canvas", canvas: { nodes: [], edges: [] }, overwrite: true }],
    ["get_backlinks", { path: "leaf.md" }],
    ["get_unresolved_links", {}],
    ["get_orphans", {}],
    ["get_deadends", {}],
    ["daily_note", { action: "create", date: "2026-10-07" }],
    ["list_templates", {}],
    ["create_from_template", { template: "T1", path: "notes/x.md" }],
    ["rename_property", { from: "status", to: "state", dryRun: false }],
    ["set_property_type", { name: "rating", type: "number" }],
    ["find_related", { path: "notes/same.md", semantic: false }],
    ["suggest_links", { path: "notes/same.md", semantic: false }],
    ["git_pull", {}],
    ["git_push", {}],
  ];
  try {
    for (const [name, args] of calls) {
      // The registrar's vault gate refuses before the handler: the process's REAL map has no `ghost`.
      const refused = await client.attempt(name, { ...args, vaultId: "ghost" });
      assert.equal(refused.isError, true, `${name} must refuse an unknown Vault`);
      assert.match(String(refused.text), /ghost/, `${name} must name the refused Vault`);
    }
    assert.deepEqual(await treeSnapshot(SECONDARY_ROOT), secondaryBefore, "a refused call must not touch any Vault");
    await assertPrimaryUntouched();
  } finally {
    await client.close();
  }
});
