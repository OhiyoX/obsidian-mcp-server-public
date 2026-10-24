// W0-A — Multi-Vault core path/state inventory (characterization freeze).
//
// Contract: Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置
// §25 W0-A (core path/state inventory), §43 (architecture tests), §44 (old-red).
// Documentation twins this file: docs/multi-vault/W0-A-core-state-inventory.md.
//
// This test records CURRENT facts only (zero behavior change). The frozen sets
// below are ratchets: a new importer / new module singleton / new DATA_PATH
// substate fails here on purpose.
//
// >>> Wave A/B migration MUST update BOTH this FROZEN object AND
// >>> docs/multi-vault/W0-A-core-state-inventory.md in the same commit. <<<
// >>> Wave D lanes add their own lane-owned registry entry the same way (D-search
// >>> `src/search-runtimes.js`, D-git `src/git-runtimes.js`) — never by relaxing an existing one.
//
// Where a frozen value is a *goal* rather than a fact (e.g. greenfield markers)
// the comment says so explicitly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_DIR, "..");
const SRC_ROOT = path.join(APP_ROOT, "src");

const FROZEN = Object.freeze({
  // (1) `app/src/**` importers of each `app/src/config.js` export, exact set equality.
  // Paths are app-relative POSIX. Method: static ES import clause parsing (multi-line safe).
  configImporters: Object.freeze({
    VAULT: Object.freeze([
      "src/app/attachments.js",
      "src/app/auth-routes.js",
      "src/app/themes.js",
      "src/app/vault-registry.js",
      "src/batch-journal.js",
      "src/git.js",
      "src/vault.js",
    ]),
    DATA_PATH: Object.freeze([
      "src/app/route-metrics.js",
      // #428: the Web Catalog default directory is now `<DATA_PATH>/web-catalog` instead of the
      // retired `process.cwd()/data/web-catalog`, so `runtime.js` becomes a DATA_PATH importer.
      "src/app/web-catalog/runtime.js",
      "src/batch-journal.js",
      "src/file-transfer.js",
      // Wave B / B4 (2026): `src/git.js` is now the §43-5 Git compatibility facade and builds the
      // primary GitRuntime from the A5 store file `DATA_PATH/git-vaults.json` (contract §15). It
      // passes `dataRoot` to `createGitConfigStore`, so no `path.join(DATA_PATH, ...)` literal is
      // added to the `dataPathLiterals` map below.
      "src/git.js",
      "src/mutation-idempotency.js",
      "src/oauth-provider.js",
      "src/publish/service.js",
      "src/release-version.js",
      "src/vault.js",
    ]),
    // Wave D / D-files (2026): `src/batch-write.js` no longer imports the global TRASH_PATH. Its
    // pre-commit trash-source containment check now uses the *request's* Vault trash root
    // (`currentLocalFs().trashRoot`, contract §10.1/§13.4), so a secondary mutation can never be
    // validated against — or spill into — the primary Vault's trash. Tightening: one fewer global
    // root importer; the §43-5 facade (`src/vault.js`) and the B6 journal/scope owner
    // (`src/batch-journal.js`, which keeps the legacy fallbacks for primary/schema-1 journals) remain.
    TRASH_PATH: Object.freeze(["src/batch-journal.js", "src/vault.js"]),
    HISTORY_PATH: Object.freeze(["src/batch-journal.js", "src/vault.js"]),
    RETRIEVAL_INDEX_PATH: Object.freeze([
      // Wave B / B3 (2026): `src/retrieval.js` no longer imports this constant. The primary
      // index path now reaches retrieval through the A7 primary mapping
      // (`primaryRuntime.paths.retrievalIndex`), and the new per-vault runtime modules
      // (`src/vault-runtime/retrieval-runtime.js`, `retrieval-rank.js`, `retrieval-status.js`)
      // are not allowed to import a global path constant at all (§43-5; asserted by
      // `app/test/retrieval-runtime.test.js`). Only the §43-5 facade remains.
      "src/vault.js",
    ]),
    // Extension beyond the brief's six: vault-derived layout paths (vaultLayout).
    MEMORY_PATH: Object.freeze(["src/agent-bootstrap.js", "src/tools/intelligence.js"]),
    SKILLS_PATH: Object.freeze(["src/agent-bootstrap.js", "src/skills.js", "src/tools/intelligence.js"]),
    // Wave F / F1 (2026): the two Web multi-Vault reads moved into `config.js` helpers
    // (`configuredWebVaultsRoot` / `configuredWebDefaultVault`) — `server.js`'s inline 1-line read
    // is gone and the three former direct readers consume the single read point. They are helpers
    // (not frozen constants) so each consumer still evaluates them at its own module load, exactly
    // as before; the `envReaders` ratchet below is what proves the single read point.
    // #659 (TIGHTENING): `src/vault.js` no longer reads these helpers at all — its `PRIMARY_VAULT_ID`
    // used to be a verbatim re-derivation of `oauth/primitives.js#DEFAULT_VAULT_ID`; it is now that
    // import, so the helper reads left the importer set instead of being duplicated. Two importers,
    // not three: the surface shrank, the ratchet must record it.
    configuredWebVaultsRoot: Object.freeze(["src/app/vault-registry.js", "src/oauth/primitives.js"]),
    // `vault-registry.js` stopped importing this one too (it now calls
    // `config.js#configuredPrimaryVaultId`, which is the only caller left besides the auth plane).
    configuredWebDefaultVault: Object.freeze(["src/oauth/primitives.js"]),
  }),
  // `WEB_VAULTS_ROOT` / `WEB_DEFAULT_VAULT` are read ONLY by `config.js` since Wave F / F1 (the
  // brief's "_WEB_VAULTS_ROOT_ is not exported" asymmetry is resolved). Files reading
  // `process.env.<name>` directly. Comments are not matches. TIGHTENING: one reader (the single
  // read point) instead of three.
  envReaders: Object.freeze({
    WEB_VAULTS_ROOT: Object.freeze(["src/config.js"]),
    WEB_DEFAULT_VAULT: Object.freeze(["src/config.js"]),
  }),
  // (4) Module-level mutable state = per-vault isolation candidates.
  // Each pattern is matched against comment-stripped, whitespace-collapsed source.
  singletons: Object.freeze({
    // Wave B / B4 (2026): `src/git.js` is now the §43-5 compatibility facade and holds no
    // module-level state. Its eleven pre-migration bindings moved into the per-vault
    // `createGitRuntime` instance and its collaborators: pending batches in
    // `src/git-runtime/pending.js`, the debounce / max-delay / sweep handles (and their re-arm
    // bookkeeping) in `src/git-runtime/timers.js`, the serialized queue / `lastSweep` / config as
    // private instance fields, and the push history in
    // `src/git-push-observability.js#createPushHistory` (contract §16, §44 item 8). The absence
    // ratchet lives in `app/test/git-migration-isolation.test.js`.
    //   "const pendingPaths = new Set();", "const pendingAuthors = new Map();", "let commitTimer;",
    //   "let maxDelayTimer;", "let sweepTimer;", "let pendingSince = null;", "let lastSweep = null;",
    //   "let operationQueue = Promise.resolve();", "let imminentFlushFor = null;",
    //   "let maxDelayDeadlineAt = null;", "let maxDelayKind = null;"
    // Wave B / B4 (2026): `src/git-push-observability.js` no longer declares the push singleton
    // (`let lastOutcome = null;` / `let consecutiveFailures = 0;`). One history per GitRuntime via
    // `createPushHistory()`; the module keeps the three stateless helpers plus a compatibility
    // pointer for the legacy `pushObservability()` / `resetPushObservability()` names.
    // Wave B / B2 (2026): `src/vault-index.js` is now the §11 compatibility facade, so its
    // module-level state anchors were removed by that lane in the same commit (rule 3). The whole
    // index state (note cache / generation / publicationRevision / snapshot identity / build tail /
    // stats) is declared inside the `createVaultIndexRuntime` factory closure in
    // `vault-runtime/vault-index-runtime.js`, i.e. once per Vault, never at module scope.
    // See §4.2 and §6.2 of the W0-A doc, and `app/test/vault-index-runtime.test.js`, which
    // rejects any module-level index state in the new modules.
    // Wave B / B3 (2026): `src/retrieval.js` is now a compatibility facade and holds no
    // module-level state. `state` / `loading` / `operationQueue` / `activeIndexJob` /
    // `refreshTimer` / `refreshTimerOptions` / `lastRefreshAt` / `pendingIndexOptions`
    // moved into the `createRetrievalRuntime` closure of
    // `src/vault-runtime/retrieval-runtime.js` (one instance per Vault; contract §12/§43-7).
    // See §4.3 + §6.2 of the W0-A doc; the absence ratchet lives in
    // `app/test/retrieval-runtime.test.js`.
    "src/mutation-plans.js": Object.freeze(["const plans = new Map();", "const appliedIdempotency = new Map();"]),
    "src/mutation-idempotency.js": Object.freeze([
      'const root = path.join(DATA_PATH, "mutation-idempotency");',
      "let lastPrunedAt = 0;",
    ]),
    "src/batch-journal.js": Object.freeze(['const root = path.join(DATA_PATH, "mutation-journal");']),
    // Wave B / B1 (2026): `src/vault.js` is now the §10.1 compatibility facade; the
    // mutation lock moved into `vault-runtime/local-fs.js` as a per-instance closure
    // (no module-level mutable state is left in the facade). See §3 of the W0-A doc.
    "src/app/web-catalog/runtime.js": Object.freeze([
      "const runtimes = new Map();",
      "let runtimeFactory = createDefaultRuntime;",
      "let runtime = runtimes.get(vault.id);", // per-vault precedent: keyed by vault.id
    ]),
    "src/app/live-events.js": Object.freeze([
      "const watchers = new Map();",
      "const watcherGenerationSeq = new Map();",
      "const watcherRefs = new Map();",
      "const pending = new Map();",
      "const coverageGaps = new Map();",
    ]),
    "src/session-author.js": Object.freeze(["const bySession = new Map();", "const byAuthClient = new Map();"]),
    "src/app/route-metrics.js": Object.freeze(["let shared;"]),
    "src/embeddings.js": Object.freeze(["const defaultClient = createEmbeddingClient();"]),
    "src/release-version.js": Object.freeze(['let cached = { key: "", value: null };']),
    "src/app/vault-registry.js": Object.freeze(["const webNoteWriteLocks = new Map();"]),
    "src/discovery-runtime.js": Object.freeze([
      "const viewStore = new AsyncLocalStorage();",
      "const defaultOperatorConfig = loadDiscoveryOperatorConfig();",
    ]),
    // Wave D / D-search (2026): the per-Vault search runtime registry. It holds *references* only
    // — one composed { index, retrieval } pair per materialized VaultRuntime, keyed by the runtime
    // instance (WeakMap) rather than a vault.id string, so a runtime released by D0's map cannot be
    // served again and no id-keyed inventory is kept (§43-7: the index/retrieval *state* lives
    // inside those instances, not here). Same shape as the per-vault `web-catalog/runtime.js`
    // precedent above. See docs/multi-vault/W0-A-core-state-inventory.md §6.6.
    "src/search-runtimes.js": Object.freeze(["const SECONDARY_RUNTIMES = new WeakMap();"]),
    // Wave D / D-git (2026): the per-Vault GitRuntime registry + request resolver. It holds
    // *references* only — one GitRuntime per materialized VaultRuntime, keyed by the runtime
    // instance (WeakMap) so a runtime released by D0's map cannot be served again — plus the
    // factory/store wiring `src/git.js` injects once at import (the facade is the §43-5 allowlisted
    // module that may read the global root and the `GIT_*` baseline). Pending batches, the
    // debounce/max-delay/sweep timers, the operation queue, `lastSweep` and the push history stay
    // inside those instances, never here (§43-6). Same shape as the `src/search-runtimes.js`
    // precedent above. See docs/multi-vault/W0-A-core-state-inventory.md §6.7.
    "src/git-runtimes.js": Object.freeze([
      "const SECONDARY_GIT_RUNTIMES = new WeakMap();",
      "let wiring = null;",
    ]),
  }),
  // (2) DATA_PATH sub-state literals in `app/src/**` from `path.join(DATA_PATH|dataPath, "<name>"`,
  // mapped to their declaring module(s). `trash`/`history`/`index` are config.js's primary
  // legacy defaults (contract §5.1); `dataPath` is the injected-parameter form.
  // Wave B / B1: `src/vault.js` (compatibility facade) derives the primary runtime's
  // transfers/journal/idempotency roots for the A7 `vaultDataPaths` mapping. Those three
  // derivations are scheduled to collapse onto `runtime.paths` when lanes B2/B5/B6 consume
  // it; until then the facade is an explicit, frozen additional owner.
  dataPathLiterals: Object.freeze({
    "access-policy.json": Object.freeze(["src/access-policy/server-wiring.js"]),
    history: Object.freeze(["src/config.js"]),
    index: Object.freeze(["src/config.js"]),
    "mutation-idempotency": Object.freeze(["src/mutation-idempotency.js", "src/vault.js"]),
    "mutation-journal": Object.freeze(["src/batch-journal.js", "src/vault.js"]),
    oauth: Object.freeze(["src/oauth-provider.js"]),
    publish: Object.freeze(["src/publish/service.js"]),
    "route-metrics.json": Object.freeze(["src/app/route-metrics.js"]),
    transfers: Object.freeze(["src/file-transfer.js", "src/vault.js"]),
    trash: Object.freeze(["src/config.js"]),
    // W2 / #437 (2026): the ONE admission record (contract §2.2 唯一权威文件
    // `DATA_PATH/vault-admissions.json`). Declared in `config.js` — the single read point — exactly
    // like the legacy trash/history/index defaults above, so no consumer derives the path itself.
    "vault-admissions.json": Object.freeze(["src/config.js"]),
    // W2FIX2 / #437 (2026): the independent MANAGED-MODE ENROLLMENT sentinel (RETURN item 1). It
    // records only "this data root is under admission management" + trusted identity bindings, so a
    // lost record cannot be re-read as "never managed". Declared in `config.js` — the single read point.
    "vault-admission-enrollment.json": Object.freeze(["src/config.js"]),
    // #428: the Web Catalog's default directory literal. DATA_PATH is the resolved config.js
    // export; an explicit `WEB_CATALOG_DIR` still overrides it (see the owner anchor below).
    "web-catalog": Object.freeze(["src/app/web-catalog/runtime.js"]),
  }),
  // Indirect DATA_PATH owners reachable only through a parameter or a constant indirection.
  dataPathOwners: Object.freeze({
    "src/app/route-metrics.js": Object.freeze(['path.join(DATA_PATH, "route-metrics.json")']),
    "src/release-version.js": Object.freeze(['path.join(DATA_PATH, MANIFEST_FILE)', 'const MANIFEST_FILE = "deployed-version.json";']),
    "src/access-policy/server-wiring.js": Object.freeze(['path.join(dataPath, "access-policy.json")']),
    "server.js": Object.freeze(['path.join(DATA_PATH, "web", "sessions.json")', "dataPath: DATA_PATH"]),
    // Web Catalog is per-vault, keyed off its OWN env var when set, and off DATA_PATH otherwise
    // (#428; the retired `process.cwd()/data/web-catalog` default is gone).
    "src/app/web-catalog/runtime.js": Object.freeze(['path.join(DATA_PATH, "web-catalog")']),
  }),
  // (4) Greenfield markers — EMPTY as of Wave A3. Each entry was a goal, never a fact: it
  // asserted a future module must not exist yet. `src/vault-runtime` was removed here by Wave A1
  // (`src/vault-runtime/descriptor.js` now exists); `src/vault-scope.js` was removed by Wave A3,
  // which created the canonical tool vault-scope registry. See
  // docs/multi-vault/W0-A-core-state-inventory.md §4.7.
  greenfieldAbsent: Object.freeze([]),
});

// ---------------------------------------------------------------------------
// Scanner: static ES import parsing, multi-line safe.
//
// `stripComments` removes comments only (string contents preserved) so exact
// declaration anchors and `path.join(..., "literal")` regexes stay matchable.
// `stripCommentsAndStrings` additionally blanks every string/template body that is
// not directly a `from "..."` / `import "..."` specifier, so an `import`-looking
// text inside a string or HTML template can never be read as a module import.
// Both keep text length/line structure so positions stay honest.
// ---------------------------------------------------------------------------

const SPECIFIER_BEFORE = /[^\w$](?:from|import)\s*$/;

function scanSource(source, blankStrings) {
  let out = "";
  let i = 0;
  let state = "code";
  let keep = false;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"') { keep = !blankStrings || SPECIFIER_BEFORE.test(` ${out.slice(-32)}`); state = c === "'" ? "sq" : "dq"; out += c; i += 1; continue; }
      if (c === "`") { keep = false; state = "tpl"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") { out += c === "\n" ? c : " "; if (c === "\n") state = "code"; i += 1; continue; }
    if (state === "block") { out += c === "\n" ? c : " "; if (c === "*" && n === "/") { state = "code"; i += 2; continue; } i += 1; continue; }
    if (state === "sq" || state === "dq") {
      if (c === "\\") { out += keep ? c + (n ?? "") : "  "; i += 2; continue; }
      if (c === (state === "sq" ? "'" : '"')) { state = "code"; out += c; i += 1; continue; }
      out += keep ? c : " "; i += 1; continue;
    }
    // state === "tpl": template bodies are never module specifiers.
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === "`") { state = "code"; out += c; i += 1; continue; }
    out += c === "\n" ? c : " "; i += 1; continue;
  }
  return out;
}

export function stripComments(source) {
  return scanSource(source, false);
}

export function stripCommentsAndStrings(source) {
  return scanSource(source, true);
}

/** Named + default bindings of every static import: [{ specifier, names }]. */
export function parseImports(source) {
  const text = stripCommentsAndStrings(source);
  // The clause may span lines but never quotes/semicolons, so the optional
  // `from` group cannot jump across statements into a later import.
  const re = /\bimport\s*(?:([^"'`;]*?)\s+from\s+)?["']([^"']+)["']/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const clause = (m[1] || "").trim();
    const names = [];
    let rest = clause;
    if (!clause.startsWith("{")) {
      const brace = clause.indexOf("{");
      const head = (brace === -1 ? clause : clause.slice(0, brace)).replace(/,\s*$/, "").trim();
      if (head && !head.startsWith("*")) names.push(head);
      rest = brace === -1 ? "" : clause.slice(brace);
    }
    if (rest.startsWith("{")) {
      for (const part of rest.slice(1, rest.lastIndexOf("}")).split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    found.push({ specifier: m[2], names });
  }
  return found;
}

const sourceCache = new Map();

function listJsFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out.sort();
}

function appRelative(absolute) {
  return path.relative(APP_ROOT, absolute).split(path.sep).join("/");
}

export function readSource(relative) {
  if (!sourceCache.has(relative)) sourceCache.set(relative, fs.readFileSync(path.join(APP_ROOT, relative), "utf8"));
  return sourceCache.get(relative);
}

function addTo(index, key, value) {
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(value);
}

const commentsOnlyCache = new Map();
const blankedCache = new Map();

function commentsOnlySource(relative) {
  if (!commentsOnlyCache.has(relative)) commentsOnlyCache.set(relative, stripComments(readSource(relative)));
  return commentsOnlyCache.get(relative);
}

function blankedSource(relative) {
  if (!blankedCache.has(relative)) blankedCache.set(relative, stripCommentsAndStrings(readSource(relative)));
  return blankedCache.get(relative);
}

// One pass over app/src/**: named bindings imported per file, and (independent
// instrument) files with a non-comment line mentioning one of the frozen names.
let indexCache = null;
function buildIndex() {
  if (indexCache) return indexCache;
  const importers = new Map();
  const mentions = new Map();
  const watched = new Set(Object.keys(FROZEN.configImporters));
  for (const file of listJsFiles(SRC_ROOT)) {
    const relative = appRelative(file);
    for (const imp of parseImports(blankedSource(relative))) for (const name of imp.names) addTo(importers, name, relative);
    if (relative === "src/config.js") continue; // the definition site
    for (const line of readSource(relative).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const word of line.matchAll(/[A-Za-z_$][\w$]*/g)) if (watched.has(word[0])) addTo(mentions, word[0], relative);
    }
  }
  indexCache = { importers, mentions };
  return indexCache;
}

/** Files in app/src/** importing `name` as a default or named binding. */
export function importersOf(name) {
  return [...(buildIndex().importers.get(name) || [])].sort();
}

function mentionedInCode(name) {
  return [...(buildIndex().mentions.get(name) || [])].sort();
}

function collapsedSource(relative) {
  return commentsOnlySource(relative).replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Scanner self-proof + controls
// ---------------------------------------------------------------------------

test("scanner extracts multi-line, default+named, and side-effect imports", () => {
  const fixture = [
    'import {',
    "  VAULT,",
    "  DATA_PATH,",
    "} from './config.js';",
    'import defaultThing, { TRASH_PATH as TP } from "../config.js";',
    "import * as ns from './other.js';",
    "import './side-effect.js';",
    "// import { NOT_REAL } from './config.js';",
    'const text = "import { FAKE } from \'./config.js\'";',
  ].join("\n");
  const parsed = parseImports(fixture);
  const specifiers = parsed.map((imp) => imp.specifier).sort();
  assert.deepEqual(specifiers, ["../config.js", "./config.js", "./other.js", "./side-effect.js"]);
  const names = parsed.flatMap((imp) => imp.names).sort();
  assert.deepEqual(names, ["DATA_PATH", "TRASH_PATH", "VAULT", "defaultThing"]);
  assert.ok(!names.includes("NOT_REAL") && !names.includes("FAKE"), "comments/strings must not produce bindings");
});

test("positive control: vault.js is a real importer of all four core primaries", () => {
  for (const name of ["VAULT", "DATA_PATH", "TRASH_PATH", "HISTORY_PATH"]) {
    assert.ok(importersOf(name).includes("src/vault.js"), `src/vault.js must import ${name}`);
  }
  assert.deepEqual(mentionedInCode("VAULT"), importersOf("VAULT"), "independent identifier scan must agree");
});

for (const [name, expected] of Object.entries(FROZEN.configImporters)) {
  test(`config.js importer ratchet: ${name}`, () => {
    const actual = importersOf(name);
    assert.deepEqual(actual, [...expected], `importer set of ${name} changed (Wave A/B: update FROZEN + docs)`);
    // Second, independent instrument: no file may mention the identifier in code without importing it.
    assert.deepEqual(mentionedInCode(name), [...expected], `non-import mention of ${name} found`);
  });
}

for (const [name, expected] of Object.entries(FROZEN.envReaders)) {
  test(`direct process.env reader ratchet: ${name}`, () => {
    const actual = listJsFiles(SRC_ROOT)
      .map(appRelative)
      .filter((relative) => blankedSource(relative).includes(`process.env.${name}`))
      .sort();
    assert.deepEqual(actual, [...expected], `${name} env readers changed (Wave A/B: update FROZEN + docs)`);
  });
}

test("DATA_PATH substate literals and their owner modules are frozen", () => {
  const found = {};
  for (const file of listJsFiles(SRC_ROOT)) {
    const relative = appRelative(file);
    for (const m of commentsOnlySource(relative).matchAll(/path\.join\((?:DATA_PATH|dataPath),\s*"([^"]+)"/g)) {      found[m[1]] = [...new Set([...(found[m[1]] || []), relative])].sort();
    }
  }
  assert.deepEqual(found, FROZEN.dataPathLiterals, "DATA_PATH substates changed (Wave A/B: update FROZEN + docs)");
});

for (const [relative, patterns] of Object.entries(FROZEN.dataPathOwners)) {
  test(`DATA_PATH-derived state owner anchors: ${relative}`, () => {
    const text = collapsedSource(relative);
    for (const pattern of patterns) {
      assert.ok(text.includes(pattern.replace(/\s+/g, " ")), `${relative} must still contain: ${pattern}`);
    }
  });
}

for (const [relative, patterns] of Object.entries(FROZEN.singletons)) {
  test(`module-level state ratchet: ${relative}`, () => {
    const text = collapsedSource(relative);
    for (const pattern of patterns) {
      assert.ok(text.includes(pattern.replace(/\s+/g, " ")), `${relative} must still declare: ${pattern}`);
    }
  });
}

test("greenfield markers: no Wave A module is outstanding (list empty)", () => {
  // Wave A3 (2026) flipped the last entry (`src/vault-scope.js`) in the same commit as this change.
  for (const relative of FROZEN.greenfieldAbsent) {
    assert.equal(fs.existsSync(path.join(SRC_ROOT, relative.slice("src/".length))), false,
      `${relative} now exists — update FROZEN.greenfieldAbsent and the W0-A doc in the same commit`);
  }
});

// ---------------------------------------------------------------------------
// config.js path derivation (contract §1.1 / §5.1 primary legacy paths)
// ---------------------------------------------------------------------------

test("config.js derives legacy data paths from DATA_PATH when unset (subprocess)", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mv-w0a-config-"));
  const env = { ...process.env, VAULT_PATH: path.join(scratch, "vault"), DATA_PATH: path.join(scratch, "data") };
  for (const key of ["TRASH_PATH", "HISTORY_PATH", "RETRIEVAL_INDEX_PATH"]) delete env[key];
  const code = [
    "import('./src/config.js').then((m) => {",
    "  console.log(JSON.stringify({ VAULT: m.VAULT, DATA_PATH: m.DATA_PATH,",
    "    TRASH_PATH: m.TRASH_PATH, HISTORY_PATH: m.HISTORY_PATH, RETRIEVAL_INDEX_PATH: m.RETRIEVAL_INDEX_PATH }));",
    "});",
  ].join("\n");
  let out;
  try {
    out = execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: APP_ROOT, env, encoding: "utf8" });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const actual = JSON.parse(out.trim().split("\n").pop());
  assert.equal(path.resolve(actual.VAULT), path.resolve(env.VAULT_PATH));
  assert.equal(path.resolve(actual.DATA_PATH), path.resolve(env.DATA_PATH));
  assert.equal(path.resolve(actual.TRASH_PATH), path.resolve(env.DATA_PATH, "trash"));
  assert.equal(path.resolve(actual.HISTORY_PATH), path.resolve(env.DATA_PATH, "history"));
  assert.equal(path.resolve(actual.RETRIEVAL_INDEX_PATH), path.resolve(env.DATA_PATH, "index", "retrieval-index.json"));
});
