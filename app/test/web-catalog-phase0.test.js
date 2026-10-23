// Phase 0-A characterization for the Web large-Vault architecture.
//
// Contract source:
//   _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
//
// Scope: current-defect characterization only (v1 truncation, per-request
// full-Vault materialization, global browser notes array, the 10k hard cap). This
// is Phase 0-A, not all of Phase 0: the v2 cursor / tree-child / anchorPath /
// catalog-generation API *contract* fixtures the TODO also calls for are not here
// yet — they land with the v2 API surface (Phase 2A) as real route contract tests.
//
// These tests intentionally pin the *current defects* (v1 truncation, per-request
// full-Vault materialization, global browser notes array). They are the regression
// gate that later phases (SQLite Web Catalog + cursor pagination + lazy explorer)
// must flip; they must not be deleted when the runtime changes, only inverted as
// each phase lands. No runtime behavior is modified by this file.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-catalog-p0-"));
const vaultsRoot = path.join(root, "vaults");
const primary = path.join(vaultsRoot, "main");
const bulk = path.join(primary, "_Workspace");

await fs.mkdir(path.join(primary, ".obsidian"), { recursive: true });
await fs.mkdir(bulk, { recursive: true });
await fs.mkdir(path.join(primary, "zzz-last"), { recursive: true });
// B7: the Web inventory is a startup snapshot (contract §4.2), so a Vault directory
// created after the import below would never be discovered. The 10k-note "large"
// fixture Vault therefore exists from the start; its note bodies are still written
// inside the test.
await fs.mkdir(path.join(vaultsRoot, "large", ".obsidian"), { recursive: true });

const BULK_COUNT = 305;
for (let index = 0; index < BULK_COUNT; index += 1) {
  await fs.writeFile(path.join(bulk, `note-${String(index).padStart(4, "0")}.md`), `# note ${index}\n`, "utf8");
}
await fs.writeFile(path.join(primary, "Outside.md"), "# outside workspace\n", "utf8");
await fs.writeFile(path.join(primary, "zzz-last", "Last.md"), "# visited last\n", "utf8");

const TOTAL_NOTES = BULK_COUNT + 2; // _Workspace/* + Outside.md + zzz-last/Last.md

process.env.VAULT_PATH = primary;
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = "main";
process.env.OBSIDIAN_READ_ONLY = "false";

const registry = await import(`../src/app/vault-registry.js?phase0=${Date.now()}`);
after(() => fs.rm(root, { recursive: true, force: true }));

test("v1 explorer still truncates to 300 notes (current defect)", async () => {
  const main = await registry.resolveWebVault("main");
  const tree = await registry.listWebNotes(main, "");

  assert.equal(tree.notes.length, 300, "v1 tree returns exactly the 300-note budget");
  assert.equal(tree.truncated, true);
  assert.ok(TOTAL_NOTES > 300, "fixture must exceed the budget");

  const returned = new Set(tree.notes.map((note) => note.path));
  assert.equal(returned.size, 300);
  // The directory visited last must not appear: the budget is consumed before the
  // walk reaches it. This is the exact "notes outside the first folder disappear"
  // failure users report against a large _Workspace.
  assert.equal(returned.has("zzz-last/Last.md"), false, "last directory is starved by the 300 budget");
});

test("v1 search materializes every note body on each request (current defect)", async (t) => {
  const main = await registry.resolveWebVault("main");
  const spy = t.mock.method(fs, "readFile");

  await registry.listWebNotes(main, "note");

  const bodyReads = spy.mock.calls.filter((call) => String(call.arguments[0]).endsWith(".md")).length;
  assert.ok(
    bodyReads >= TOTAL_NOTES,
    `search should read every note body (>= ${TOTAL_NOTES}); observed ${bodyReads}`,
  );
});

test("v1 keeps total-note scan caps in source (MAX_WEB_NOTES + 301/300)", async () => {
  const source = await fs.readFile(new URL("../src/app/vault-registry.js", import.meta.url), "utf8");
  assert.match(source, /MAX_WEB_NOTES\s*=\s*10_000/);
  assert.match(source, /collected\.slice\(0,\s*300\)/);
  assert.match(source, /typeof pathFilter === "function" \? MAX_WEB_NOTES : 301/);
});

test("browser explorer tree is now lazy per-parent (Phase 0-A defect flipped by 2B-1b-iii)", async () => {
  const core = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");
  const controller = await fs.readFile(new URL("../frontend/app/features/explorer/controller.js", import.meta.url), "utf8");

  // The Explorer tree no longer keeps a global notes array as its source: it is
  // driven by per-parent children + cursors through the lazy controller/renderer.
  assert.doesNotMatch(core, /notes:\s*\[\]/);
  assert.doesNotMatch(controller, /state\.notes = data\.notes;/);
  assert.match(controller, /createLazyTreeController/);
  assert.match(controller, /renderLazyExplorer/);
  assert.match(controller, /childrenByParent|nextCursorByParent/);
  // Phase 3A-3 flipped the search half too: the search view is v2-backed, so the
  // first-party v1 notes consumer is now zero (the endpoint itself stays for now).
  assert.doesNotMatch(controller, /\/api\/web\/v1\/notes/);
  assert.match(controller, /searchPageUrl/);
});

// The 10k+ behavioral gate the source regex above cannot provide: with a real
// >10,000-note fixture, the 10,001st note is provably never read. When MAX_WEB_NOTES
// is removed this assertion must flip (search reads every note), so the
// characterization cannot be silently erased by renaming a constant.
const LARGE_COUNT = 10_001;
const LARGE_MAX = 10_000;

test("v1 search reads exactly MAX_WEB_NOTES bodies, so the 10,001st note is unreachable (current defect)", async (t) => {
  const largeRoot = path.join(vaultsRoot, "large");
  const bulk = path.join(largeRoot, "bulk");
  await fs.mkdir(bulk, { recursive: true });
  const BATCH = 250;
  for (let start = 0; start < LARGE_COUNT; start += BATCH) {
    const jobs = [];
    for (let index = start; index < Math.min(start + BATCH, LARGE_COUNT); index += 1) {
      jobs.push(
        fs.writeFile(path.join(bulk, `n-${String(index).padStart(5, "0")}.md`), `# needle ${index}\n`, "utf8"),
      );
    }
    await Promise.all(jobs);
  }
  assert.equal(LARGE_COUNT, LARGE_MAX + 1, "fixture must exceed the cap by exactly one note");

  const large = await registry.resolveWebVault("large");
  const spy = t.mock.method(fs, "readFile");
  await registry.listWebNotes(large, "needle");
  const bodyReads = spy.mock.calls.filter((call) => String(call.arguments[0]).endsWith(".md")).length;

  assert.equal(
    bodyReads,
    LARGE_MAX,
    `search must stop at MAX_WEB_NOTES bodies (${LARGE_MAX}); the ${LARGE_COUNT}th note is never reachable`,
  );
  assert.ok(bodyReads < LARGE_COUNT);
});
