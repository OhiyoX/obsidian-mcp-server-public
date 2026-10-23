// Phase 2B target-platform (Linux) benchmark. Runs inside the production
// container's runtime against the current main code. All data lives in a temp dir;
// the production Vault is never touched.
//
// The final PASS is bound to the hard checks below (not to timing). Any failing hard
// check exits non-zero, so a broken environment (old Node, no WAL, capped enumeration,
// missing Unicode, lost persistence, wrong anchor, degraded incremental reconcile)
// cannot print PASS. Timings are observations only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createVaultCatalogSource } from "../src/app/web-catalog/indexer.js";
import { readNoteInRoot } from "../src/app/web-catalog/note-reader.js";
import { createWebCatalogReconciler } from "../src/app/web-catalog/reconcile.js";
import { applyWatcherEvent, createWebCatalogRuntime } from "../src/app/web-catalog/runtime.js";
import { openWebCatalogStore } from "../src/app/web-catalog/store.js";
import { listMarkdownUnder, toRootRelative } from "../src/app/web-catalog/vault-source.js";

const ROOT = path.join(os.tmpdir(), "obsidian-catalog-bench");
const VAULT = path.join(ROOT, "vault");
const CATALOG = path.join(ROOT, "catalog"); // derived DB lives OUTSIDE the vault
const TOTAL = 50000;
const HOT = 5000;
const UNICODE = ["中文笔记.md", "日本語.md", "한국어.md", "e\u0301.md", "\u00e9.md", "emoji-\u{1F600}.md"];
const EXPECTED = TOTAL + UNICODE.length; // 50006
const FORCE_FAIL = /^(?:1|true|on|yes)$/i.test(String(process.env.BENCH_SELFTEST_FAIL ?? ""));
const pad = (value, width) => String(value).padStart(width, "0");

const out = [];
const say = (line) => { out.push(line); console.log(line); };
const checks = [];
function check(name, ok, detail = "") {
  // BENCH_SELFTEST_FAIL proves the harness is fail-closed: it deliberately fails the
  // first hard check, so the run must exit non-zero.
  const passed = FORCE_FAIL && checks.length === 0 ? false : Boolean(ok);
  checks.push({ name, ok: passed });
  say(`check ${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

function sourceFor(maxEntries) {
  return createVaultCatalogSource({
    vaultRoot: VAULT,
    // A cap keeps the 1k/10k observations deterministic; 50k walks everything.
    listMarkdown: (options) => listMarkdownUnder(VAULT, maxEntries ? { ...options, maxEntries } : options),
    stat: (absolute) => fs.stat(absolute),
    readNote: (absolute, options) => readNoteInRoot(VAULT, absolute, options),
    toVaultPath: (absolute) => toRootRelative(VAULT, absolute),
  });
}

async function buildVault() {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(VAULT, "Hot"), { recursive: true });
  await fs.mkdir(path.join(VAULT, "Unicode"), { recursive: true });
  const pending = [];
  const flush = async () => { if (pending.length >= 400) await Promise.all(pending.splice(0)); };
  for (let index = 0; index < HOT; index += 1) {
    pending.push(fs.writeFile(path.join(VAULT, "Hot", `h-${pad(index, 5)}.md`), `# hot ${index}\n`));
    await flush();
  }
  for (let index = 0; index < TOTAL - HOT; index += 1) {
    const folder = path.join(VAULT, "Deep", `D${pad(Math.floor(index / 90), 3)}`, `S${Math.floor((index % 90) / 9)}`);
    await fs.mkdir(folder, { recursive: true });
    pending.push(fs.writeFile(path.join(folder, `note-${pad(index, 5)}.md`), `# deep ${index}\n`));
    await flush();
  }
  for (const name of UNICODE) pending.push(fs.writeFile(path.join(VAULT, "Unicode", name), `# ${name}\n`));
  await Promise.all(pending);
  await fs.mkdir(CATALOG, { recursive: true });
}

async function coldBuild(label, maxEntries) {
  const dbFile = path.join(CATALOG, `catalog-${label}.sqlite`);
  const store = openWebCatalogStore({ file: dbFile });
  const reconciler = createWebCatalogReconciler({ store, source: sourceFor(maxEntries) });
  const started = performance.now();
  const result = await reconciler.reconcile();
  const ms = performance.now() - started;
  // WAL mode: rows may still live in the -wal sidecar, so report both.
  const wal = await fs.stat(`${dbFile}-wal`).then((stat) => stat.size, () => 0);
  const journal = store.testDb().prepare("PRAGMA journal_mode").get().journal_mode;
  return { store, dbFile, ms, result, wal, journal, size: (await fs.stat(dbFile)).size + wal };
}

function sample(store, options, samples = 30) {
  const times = [];
  let last = null;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    last = store.listChildren(options.parent, options);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor(times.length * 0.5)], p95: times[Math.ceil(times.length * 0.95) - 1], last };
}

function plan(store, options) {
  const detail = store.planListChildren(options.parent, options).map((row) => row.detail).join("\n");
  return { detail, index: /USING INDEX nodes_parent_/.test(detail), tempBtree: /TEMP B-TREE/.test(detail), scanNodes: /\bSCAN nodes\b/.test(detail) };
}

say(`env node=${process.version} sqlite=${new DatabaseSync(":memory:").prepare("select sqlite_version() v").get().v} arch=${process.arch} platform=${process.platform}`);
check("Node satisfies the >=22.13 baseline", Number(process.version.slice(1).split(".")[1]) >= 13 && Number(process.version.slice(1).split(".")[0]) >= 22, process.version);

const startedBuild = performance.now();
await buildVault();
say(`vault built: total=${EXPECTED} hot=${HOT} unicode=${UNICODE.length} in ${Math.round(performance.now() - startedBuild)}ms (temp dir)`);

const built = {};
for (const [label, maxEntries] of [["1k", 1000], ["10k", 10000], ["50k", null]]) {
  const result = await coldBuild(label, maxEntries);
  built[label] = result;
  say(`cold build ${label}: ${Math.round(result.ms)}ms db=${Math.round(result.size / 1024)}KiB journal=${result.journal} indexed=${result.result.reparsed} reused=${result.result.reused} removed=${result.result.removed}`);
}

const full = built["50k"];
check("WAL is active on the file-backed catalog DB", full.journal === "wal", `journal_mode=${full.journal} wal_bytes=${full.wal}`);
check("50k cold build indexes every file (no cap truncation)", full.result.reparsed === EXPECTED && full.result.reused === 0 && full.result.removed === 0, `indexed=${full.result.reparsed}/${EXPECTED}`);

const store = full.store;
const WARM = [
  ["root", { parent: "", limit: 100, sort: "name", direction: "asc" }, 3],
  ["hot page", { parent: "Hot", limit: 100, sort: "name", direction: "asc" }, 100],
  ["hot anchor", { parent: "Hot", limit: 100, sort: "name", direction: "asc", anchorPath: `Hot/h-${pad(HOT - 1, 5)}.md` }, 1],
  ["deep page", { parent: "Deep/D000/S0", limit: 100, sort: "name", direction: "asc" }, 9],
  ["unicode page", { parent: "Unicode", limit: 100, sort: "name", direction: "asc" }, UNICODE.length],
];
let plansOk = true;
let anchorsOk = true;
for (const [label, options, expectedItems] of WARM) {
  const result = sample(store, options);
  const queryPlan = plan(store, options);
  if (!queryPlan.index || queryPlan.tempBtree || queryPlan.scanNodes) plansOk = false;
  if (result.last.items.length !== expectedItems) anchorsOk = false;
  if (options.anchorPath && result.last.items[0]?.path !== options.anchorPath) anchorsOk = false;
  say(`warm ${label}: p50=${result.p50.toFixed(2)}ms p95=${result.p95.toFixed(2)}ms items=${result.last.items.length} index=${queryPlan.index} temp_btree=${queryPlan.tempBtree} scan_nodes=${queryPlan.scanNodes}`);
}
// A mid-list anchor must start at the anchor and stay ordered, not just return something.
const midAnchor = `Hot/h-${pad(2500, 5)}.md`;
const midPage = store.listChildren("Hot", { limit: 100, sort: "name", direction: "asc", anchorPath: midAnchor });
const midOrdered = midPage.items.every((item, index) => index === 0 || item.path > midPage.items[index - 1].path);
check("anchor page starts at the anchor and stays ordered", midPage.items[0]?.path === midAnchor && midPage.items.length === 100 && midOrdered, `first=${midPage.items[0]?.path} items=${midPage.items.length}`);
check("last-item anchor yields a clean terminal page", anchorsOk, `items=${WARM.map(([, options]) => options.anchorPath ? 1 : "-").join("/")}`);
check("warm pages are index-only (no TEMP B-TREE, no SCAN nodes)", plansOk);

// close -> reopen: a true warm restart. The first connection must be closed before the
// second is opened, otherwise this only proves a second concurrent reader works.
store.close();
const reopened = openWebCatalogStore({ file: full.dbFile });
const reopenStarted = performance.now();
const reopenedPage = reopened.listChildren("", { limit: 100, sort: "name", direction: "asc" });
const reopenMs = performance.now() - reopenStarted;
say(`reopen warm root: ${reopenMs.toFixed(2)}ms items=${reopenedPage.items.length} lastReconciledAt=${reopened.metaGet("lastReconciledAt") ? "present" : "missing"}`);
check("reopened catalog serves warm pages from the persisted snapshot", Boolean(reopened.metaGet("lastReconciledAt")) && reopenedPage.items.length === 3, `items=${reopenedPage.items.length}`);

const unicodePaths = UNICODE.map((name) => `Unicode/${name}`);
const unicodeFound = unicodePaths.filter((rel) => reopened.locate(rel)).length;
say(`unicode in catalog: ${unicodeFound}/${unicodePaths.length}`);
check("Unicode names (CJK/Hangul/combining/emoji) are indexed", unicodeFound === unicodePaths.length, `${unicodeFound}/${unicodePaths.length}`);

// Real runtime watcher/index path (createWebCatalogRuntime -> indexFile), not a direct
// store write: one note.created event must publish one catalog mutation.
const runtime = createWebCatalogRuntime({
  vault: { id: "bench", root: VAULT },
  store: reopened,
  source: sourceFor(null),
  logger: { error: () => {} },
});
const added = path.join(VAULT, "Hot", "mutated.md");
const edited = path.join(VAULT, "Deep", "D000", "S0", "note-00000.md");
await fs.writeFile(added, "# mutated\n");
await fs.writeFile(edited, "# edited\n");
const addedStarted = performance.now();
const addedResult = await applyWatcherEvent(runtime, { type: "note.created", path: "Hot/mutated.md", absolute: added });
say(`runtime watcher index (note.created): ${(performance.now() - addedStarted).toFixed(2)}ms ok=${addedResult?.ok} skipped=${addedResult?.skipped}`);
check("runtime watcher index path publishes the added note", addedResult?.ok === true && Boolean(reopened.locate("Hot/mutated.md")));

const reconcileStarted = performance.now();
const incremental = await createWebCatalogReconciler({ store: reopened, source: sourceFor(null) }).reconcile();
say(`incremental reconcile: ${Math.round(performance.now() - reconcileStarted)}ms scanned=${incremental.scanned} reparsed=${incremental.reparsed} reused=${incremental.reused} removed=${incremental.removed}`);
check(
  "incremental reconcile re-reads only the changed files",
  incremental.scanned === EXPECTED + 1 && incremental.reparsed >= 1 && incremental.reparsed <= 2 && incremental.reused === incremental.scanned - incremental.reparsed && incremental.removed === 0,
  `scanned=${incremental.scanned} reparsed=${incremental.reparsed} reused=${incremental.reused}`,
);
reopened.close();

await fs.rm(ROOT, { recursive: true, force: true });
say(`cleanup: temp dir removed`);
const failed = checks.filter((entry) => !entry.ok);
say(`RESULT: ${failed.length === 0 ? "PASS" : "FAIL"} (${checks.length - failed.length}/${checks.length} hard checks)`);
if (failed.length > 0) {
  say(`failed: ${failed.map((entry) => entry.name).join("; ")}`);
  process.exitCode = 1;
}
