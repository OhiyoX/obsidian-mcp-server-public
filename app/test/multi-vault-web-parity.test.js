// W0-F — Web parity characterization (Wave 0, zero behavior change).
//
// Freezes the *current* primary/secondary behavior of app/src/app/vault-registry.js
// and the Web catalog/session plumbing, so Wave B/C changes must update this file
// deliberately. No production file is touched by this slice. Every case below notes:
//   current  = what the frozen BASE does today;
//   contract = the target clause in
//              `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置.md`;
//   moved by = which later slice is expected to change it.
//
// Characterization only: the assertions describe BASE behavior, including the
// known gaps (secondary semantic, write-engine asymmetry). B7 (the Web adapter onto
// the canonical registry) moved one entry: the duplicate-canonical-root gap is now a
// fail-closed refusal (SEC-MV02), frozen in `test/web-vault-registry-canonical.test.js`,
// and the ID rule is delegated to the canonical validator instead of a forked literal.
// A "gap" test is not an endorsement.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mv-w0f-web-parity-"));
const vaultsRoot = path.join(root, "vaults");
// Production shape (and B7's requirement): the primary root lives OUTSIDE the vaults
// root. BASE additionally exercised a "primary directory inside WEB_VAULTS_ROOT" alias
// topology; the canonical registry refuses two ids on one canonical root (SEC-MV02),
// so that topology now lives in its own subprocess test in
// `test/web-vault-registry-canonical.test.js`.
const primaryRoot = path.join(root, "alpha");
const secondaryRoot = path.join(vaultsRoot, "beta");
const alphaSecondaryRoot = path.join(vaultsRoot, "alpha");
const outsideFile = path.join(root, "outside.md");

for (const dir of [primaryRoot, secondaryRoot, alphaSecondaryRoot]) await fs.mkdir(path.join(dir, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(vaultsRoot, ".hidden", ".obsidian"), { recursive: true });
await fs.writeFile(path.join(secondaryRoot, "Home.md"), "# Home\n", "utf8");
await fs.writeFile(outsideFile, "# outside\n", "utf8");

// vault-registry.js reads these at module load; one import = one frozen topology.
process.env.VAULT_PATH = primaryRoot;
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = "dup";
process.env.DATA_PATH = path.join(root, "data");
process.env.HISTORY_PATH = path.join(root, "data", "history");
process.env.TRASH_PATH = path.join(root, "data", "trash");
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
process.env.WEB_CATALOG_ENABLED = "false";
process.env.OBSIDIAN_READ_ONLY = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

const registry = await import(`../src/app/vault-registry.js?w0f=${Date.now()}`);
// No query string: vault.js imported this same specifier, so the author context
// must be the same module instance.
const { withRequestContext } = await import("../src/request-context.js");
const catalog = await import("../src/app/web-catalog/runtime.js");

const withAuthor = (task) => withRequestContext({ author: { agent: "obsidian-web", model: "human:dev" } }, task);
const historyTree = () => fs.readdir(path.join(root, "data", "history"), { recursive: true }).catch((error) => `ERR:${error.code}`);

// Host capability probe: Windows without the symlink privilege cannot exercise the
// symlink branch, so the reason is detected here instead of assumed.
let symlinkSkipReason = false;
try {
  await fs.symlink(outsideFile, path.join(secondaryRoot, "link.md"), "file");
  await fs.symlink(root, path.join(secondaryRoot, "linkdir"), "dir");
} catch (error) {
  symlinkSkipReason = `host cannot create symlinks (${error.code}) — branch unverified`;
}

after(() => fs.rm(root, { recursive: true, force: true }));

// B7: contract §3.2 now has one ID rule — the canonical validator in
// `src/vault-runtime/descriptor.js`. The BASE literal at
// `app/src/app/vault-registry.js:17` is gone; the Web entry keeps only its historical
// `String(value || "").trim()` normalization and then calls `validateVaultId`. The
// double-run of one ID matrix through the Web create path and `isValidVaultId` lives in
// `test/web-vault-registry-canonical.test.js`.
const WEB_REGISTRY_RELATIVE = "src/app/vault-registry.js";

test("ID contract: the Web registry delegates to the canonical validator, no forked rule", async () => {
  const source = await fs.readFile(path.join(APP_DIR, WEB_REGISTRY_RELATIVE), "utf8");
  assert.equal(/const VAULT_ID = \//.test(source), false, "the Web registry must not declare its own ID pattern");
  assert.equal(((source.match(/id === "\." \|\| id === "\.\."/g)) || []).length, 0, "the reserved-id guard is canonical now");
  assert.match(source, /import \{ validateVaultId \} from "\.\.\/vault-runtime\/descriptor\.js";/);

  // Behavior through createWebVault (safeId): trims first, then the canonical rule.
  // A dedicated root keeps this test out of the shared fixture's inventory.
  const idRoot = path.join(root, "id-contract-vaults");
  await fs.mkdir(idRoot, { recursive: true });
  const configured = process.env.WEB_VAULTS_ROOT;
  process.env.WEB_VAULTS_ROOT = idRoot;
  let web;
  try {
    web = await import(`../src/app/vault-registry.js?w0fIdContract=${Date.now()}`);
  } finally {
    if (configured === undefined) delete process.env.WEB_VAULTS_ROOT;
    else process.env.WEB_VAULTS_ROOT = configured;
  }
  await web.listWebVaults();

  const created = [];
  const attempt = (name) => web.createWebVault(name).then((vault) => {
    created.push(vault.id);
    return `OK:${vault.id}`;
  }).catch((error) => `ERR:${error.message}`);
  assert.equal(await attempt("a..b"), "OK:a..b");
  assert.equal(await attempt("中文库"), "OK:中文库");
  assert.equal(await attempt("a".repeat(80)), `OK:${"a".repeat(80)}`);
  assert.equal(await attempt(" a"), "OK:a"); // trimmed by the Web entry, before the canonical test
  assert.equal(await attempt("Main"), "OK:Main");
  assert.equal(await attempt("."), "ERR:Invalid Vault name");
  assert.equal(await attempt(".."), "ERR:Invalid Vault name");
  assert.equal(await attempt(""), "ERR:Invalid Vault name");
  assert.equal(await attempt(".hidden"), "ERR:Invalid Vault name");
  assert.equal(await attempt("a/b"), "ERR:Invalid Vault name");
  assert.equal(await attempt("a\\b"), "ERR:Invalid Vault name");
  assert.equal(await attempt("a\u0000b"), "ERR:Invalid Vault name");
  assert.equal(await attempt("a".repeat(81)), "ERR:Invalid Vault name");
  assert.equal(await attempt("emoji\u{1F600}"), "ERR:Invalid Vault name");
  await assert.rejects(() => web.resolveWebVault("main"), (error) => error.code === "ENOENT");
  assert.deepEqual(created, ["a..b", "中文库", "a".repeat(80), "a", "Main"]);
  // current: ids are case-sensitive, trimmed and now validated by the canonical rule.
});

test("listWebVaults/resolveWebVault: frozen record shape and ordering (contract §1.2/§4)", async () => {
  const inventory = await registry.listWebVaults();
  assert.deepEqual(inventory.vaults.map((item) => item.id), ["dup", "alpha", "beta"]);
  assert.equal(inventory.canCreate, true);
  assert.deepEqual([...new Set(inventory.vaults.flatMap((item) => Object.keys(item)))].sort(), ["id", "name", "primary", "root", "writable"]);
  assert.deepEqual(inventory.vaults.map((item) => item.primary), [true, false, false]);
  assert.ok(!inventory.vaults.some((item) => item.id === ".hidden"), "dot-directories are skipped by the scan");

  assert.equal(registry.defaultWebVaultId(), "dup");
  assert.equal((await registry.resolveWebVault()).id, "dup");
  assert.deepEqual(await registry.resolveWebVault("beta").then((vault) => [vault.id, vault.primary, vault.root === secondaryRoot]), ["beta", false, true]);
  await assert.rejects(() => registry.resolveWebVault("missing-vault"), (error) => error.code === "ENOENT" && /Vault not found/.test(error.message));
  // B7/BASE: primary first, then the secondary ids. BASE used localeCompare here; the
  // canonical order is code-unit (identical for this fixture's ascii ids), and the
  // discriminating cases are frozen in test/web-vault-registry-canonical.test.js.
  // contract §3.1 adds canonicalRoot/capabilities/dataKey internally; the Web record
  // stays minimized, so none of them appears on this surface.
  assert.equal("canonicalRoot" in inventory.vaults[0], false);
  assert.equal("dataKey" in inventory.vaults[0], false);
});

test("fixture invariant: no two Web ids share a canonical root (B7/SEC-MV02)", async () => {
  const inventory = await registry.listWebVaults();
  const roots = await Promise.all(inventory.vaults.map((vault) => fs.realpath(vault.root)));
  assert.equal(new Set(roots).size, roots.length, "an authorization alias must fail closed (SEC-MV02)");
  // BASE registered `dup` and `alpha` on one canonical root (frozen here until B7);
  // the refusal is now asserted in test/web-vault-registry-canonical.test.js.
});

test("secondary root-scoped read/write round-trip and revision shape", async () => {
  const vault = await registry.resolveWebVault("beta");
  const written = await registry.writeWebNote(vault, "Notes/First", "# First\n");
  assert.deepEqual(Object.keys(written).sort(), ["created", "path", "revision", "size"]);
  assert.deepEqual(written, { path: "Notes/First.md", created: true, revision: written.revision, size: 8 });
  assert.match(written.revision, /^sha256:[0-9a-f]{64}$/);

  const read = await registry.readWebNote(vault, "Notes/First.md");
  assert.deepEqual(Object.keys(read).sort(), ["content", "path", "revision", "stat"]);
  assert.equal(read.content, "# First\n");
  assert.equal(read.revision, written.revision);
  assert.deepEqual(Object.keys(read.stat).sort(), ["created", "modified", "size"]);
  assert.equal("absolute" in read, false); // metadata minimization holds on the Web surface

  const updated = await registry.writeWebNote(vault, "Notes/First.md", "# Second\n", read.revision);
  assert.equal(updated.created, false);
  assert.notEqual(updated.revision, written.revision);
  assert.equal((await registry.statWebNote(vault, "Notes/First.md")).path, "Notes/First.md");
  await assert.rejects(
    () => registry.writeWebNote(vault, "Notes/First.md", "# Third\n", written.revision),
    /Revision conflict/,
  );
  await assert.rejects(() => registry.writeWebNote(vault, "Notes/Brand-new.md", "# x\n", "sha256:deadbeef"), /Revision conflict/);

  // Isolation: the bytes live under the secondary root only.
  assert.equal((await fs.readFile(path.join(secondaryRoot, "Notes", "First.md"), "utf8")), "# Second\n");
  await assert.rejects(() => fs.stat(path.join(primaryRoot, "Notes", "First.md")), (error) => error.code === "ENOENT");
  // contract §1.2 wants primary and secondary on the same mutation semantics; §10
  // root-aware LocalFs is the single engine (moved by B1).
});

test("containment: traversal, absolute input and symlink escapes", async () => {
  const vault = await registry.resolveWebVault("beta");
  await assert.rejects(() => registry.resolveWebVaultPath(vault, "../alpha/x.md"), /Invalid Vault path/);
  await assert.rejects(() => registry.resolveWebVaultPath(vault, "Notes/../../x.md"), /Invalid Vault path/);
  await assert.rejects(() => registry.readWebNote(vault, "../alpha/.obsidian"), /Invalid Vault path/);
  await assert.rejects(() => registry.writeWebNote(vault, "../outside.md", "# x\n"), /Invalid Vault path/);

  // A leading slash is stripped by normalizeVaultInput, so an "absolute" input stays
  // root-relative instead of reaching the host path. Frozen as-is.
  const escaped = await registry.writeWebNote(vault, "/tmp/x.md", "# x\n");
  assert.equal(escaped.path, "tmp/x.md");
  assert.equal((await fs.readFile(path.join(secondaryRoot, "tmp", "x.md"), "utf8")), "# x\n");
  await assert.rejects(() => fs.stat(path.join(root, "tmp", "x.md")), (error) => error.code === "ENOENT");
  await assert.rejects(() => registry.readWebNote(vault, "/etc/passwd"), (error) => error.code === "ENOENT");
  assert.equal(await fs.readFile(outsideFile, "utf8"), "# outside\n");
});

test("symlink escape is rejected when the host can create symlinks", { skip: symlinkSkipReason }, async () => {
  const vault = await registry.resolveWebVault("beta");
  await assert.rejects(() => registry.readWebNote(vault, "link.md"), /Symbolic link|escape|Invalid/i);
  await assert.rejects(() => registry.writeWebNote(vault, "link.md", "# via symlink\n"), /Symbolic link|escape|Invalid/i);
  await assert.rejects(() => registry.readWebNote(vault, "linkdir/outside.md"), /Symbolic link|escape|Invalid/i);
  assert.equal(await fs.readFile(outsideFile, "utf8"), "# outside\n");
  // contract §42 SEC-MV01 root containment; the canonical check must stay behind the
  // single root-aware service (moved by B1/B7).
});

test("primary and secondary Web writes share one public result shape but not one engine", async () => {
  const primary = await registry.resolveWebVault("dup");
  const secondary = await registry.resolveWebVault("beta");

  // current: the primary path is the MCP writer, so it demands an author context.
  await assert.rejects(
    () => registry.writeWebNote(primary, "P.md", "# one\n"),
    /MCP writes require _meta\["obsidian\/author"\]/,
  );
  const created = await withAuthor(() => registry.writeWebNote(primary, "P.md", "# one\n"));
  assert.deepEqual(Object.keys(created).sort(), ["created", "path", "revision", "size"]);
  assert.equal(await historyTree(), "ERR:ENOENT");
  await withAuthor(() => registry.writeWebNote(primary, "P.md", "# two\n", created.revision));
  const primaryHistory = await historyTree();

  const secondaryCreated = await registry.writeWebNote(secondary, "S.md", "# one\n");
  await registry.writeWebNote(secondary, "S.md", "# two\n", secondaryCreated.revision);
  const historyAfterSecondary = await historyTree();

  // current: only the primary write path snapshots versions (global HISTORY_PATH);
  // the secondary engine never writes history. contract §1.2/§10 want parity behind
  // one runtime (moved by B1; §5.2 puts secondary history under DATA_PATH/vaults/<dataKey>).
  assert.ok(primaryHistory.some((entry) => entry.includes("P.md")), `primary update must snapshot: ${JSON.stringify(primaryHistory)}`);
  assert.deepEqual(historyAfterSecondary, primaryHistory, "secondary update added no history entry");
  assert.ok(!historyAfterSecondary.some((entry) => entry.includes("S.md")));
});

test("Web surface has no history/trash/version/Git entry point (old-red 10 context)", async () => {
  const exports = Object.keys(registry).sort();
  assert.equal(exports.some((name) => /history|trash|version|git/i.test(name)), false, `unexpected export: ${exports.join(",")}`);
  assert.deepEqual(exports, [
    // W2 / #437: the admission + reconciliation seams. They are NOT history/trash/version/Git entry
    // points; they expose the gated inventory path (`loadVaultAdmissions` / `reconcileVaults` /
    // `vaultDiscoveryStatus`) and the protected-admin decisions W3 will call (`initializeVaultAdmissions`
    // / `approveVaultAdmission` / `revokeVaultAdmission` / `installVaultReconciliation`).
    // W4 / #437 adds the two long-lived automatic-trigger seams (`startVaultDiscovery` /
    // `stopVaultDiscovery`), called by the process entry and by its shutdown path — neither is a content
    // entry point.
    "approveVaultAdmission", "createWebVault", "defaultWebVaultId", "initializeVaultAdmissions",
    "installVaultReconciliation", "listWebNotes", "listWebVaults", "loadVaultAdmissions", "readWebNote",
    "reconcileVaults", "resolveCanonicalVault", "resolveWebNoteLink", "resolveWebVault", "resolveWebVaultPath",
    "revokeVaultAdmission", "startVaultDiscovery", "statWebNote", "stopVaultDiscovery", "vaultAdmissionAdmin",
    "vaultAdmissionsEnabled", "vaultDiscoveryStatus", "webNoteWriteLockKeyForTests", "webVaultRegistry",
    // A4b adds the `.base` increment write (same lock/CAS/atomic-write family as
    // `writeWebNote`, still not a history/trash/version/Git entry point).
    "writeWebBasePatch", "writeWebNote",
  ]);
  // W3's one additional Admin-only binding; keep the complete export and route whitelists exact.
  assert.equal(Object.isFrozen(registry.vaultAdmissionAdmin), true);
  assert.deepEqual(Object.keys(registry.vaultAdmissionAdmin).sort(), ["approve", "entries", "initialize", "reconcile", "revoke", "status"]);
  for (const [method, name] of [["approve", "approveVaultAdmission"], ["initialize", "initializeVaultAdmissions"],
    ["reconcile", "reconcileVaults"], ["revoke", "revokeVaultAdmission"], ["status", "vaultDiscoveryStatus"]]) {
    assert.equal(registry.vaultAdmissionAdmin[method], registry[name], "same existing controller seam");
  }

  const routeFiles = ["routes.js", "base-route.js", "base-patch-route.js", "base-page.js", "note-context.js", "tags-route.js",
    "web-catalog/tree-route.js", "web-catalog/search-route.js"];
  const paths = new Set();
  for (const file of routeFiles) {
    const text = await fs.readFile(path.join(APP_DIR, "src", "app", file), "utf8");
    for (const match of text.matchAll(/["'`](\/api\/web\/[A-Za-z0-9/_.:-]*)/g)) paths.add(match[1]);
  }
  const frozen = [...paths].sort();
  assert.deepEqual(frozen, [
    "/api/web/v1", "/api/web/v1/asset", "/api/web/v1/base", "/api/web/v1/base/raw", "/api/web/v1/events", "/api/web/v1/folder",
    "/api/web/v1/link/resolve", "/api/web/v1/note", "/api/web/v1/note-context/", "/api/web/v1/notes",
    "/api/web/v1/publish", "/api/web/v1/session", "/api/web/v1/tags", "/api/web/v1/theme-asset",
    "/api/web/v1/theme.css", "/api/web/v1/themes", "/api/web/v1/vault", "/api/web/v1/vault/select",
    "/api/web/v1/vaults", "/api/web/v2", "/api/web/v2/search", "/api/web/v2/tree",
  ]);
  assert.equal(frozen.some((entry) => /history|trash|version|git/i.test(entry)), false);
  // current: history/trash/version/Git are MCP-only (global singletons, contract
  // §1.1/§1.9); Web secondary has no such entry point at all, so there is nothing to
  // fall back to. contract §5.2/§12 require per-vault history/retrieval runtimes
  // (moved by B1/B2/B3/B4).
});

test("secondary semantic returns the literal primary-only limitation (old-red 10)", async () => {
  const vault = await registry.resolveWebVault("beta");
  const result = await registry.listWebNotes(vault, "home", { semantic: true });
  assert.deepEqual(
    { semanticRequested: result.semanticRequested, semanticUsed: result.semanticUsed, semanticError: result.semanticError, hybridUsed: result.hybridUsed },
    { semanticRequested: true, semanticUsed: false, semanticError: "Semantic search is available only for the primary Vault", hybridUsed: false },
  );
  // Exact-lexical results are still served; only the semantic/hybrid stage is refused.
  assert.ok(result.notes.some((note) => note.path === "Home.md" && note.score === 1));
  assert.equal(result.truncated, false);
  // contract §44 old-red 10 / §12: a disabled capability must become an explicit
  // unavailable state on the unified retrieval runtime, never a silent downgrade
  // (moved by B3).
});

test("Web catalog runtime is keyed by the raw vault id and per vault", async () => {
  process.env.WEB_CATALOG_ENABLED = "true";
  try {
    const secondary = await registry.resolveWebVault("beta");
    const primary = await registry.resolveWebVault("dup");
    const secondaryRuntime = catalog.getWebCatalogRuntime(secondary, { startReconcile: false });
    const primaryRuntime = catalog.getWebCatalogRuntime(primary, { startReconcile: false });
    for (const id of ["beta", "dup"]) {
      await fs.access(path.join(root, "catalog", `${id}.sqlite`));
    }
    assert.equal(secondaryRuntime.vaultId, "beta");
    assert.equal(primaryRuntime.vaultId, "dup");
    assert.equal(catalog.getWebCatalogRuntime(secondary, { startReconcile: false }), secondaryRuntime, "one runtime per vault id");
    assert.deepEqual(Object.keys(secondaryRuntime.status()).sort(), ["coverageEpoch", "covered", "generation", "reconciling", "stale", "vaultId"]);
    assert.deepEqual({ vaultId: secondaryRuntime.status().vaultId, covered: secondaryRuntime.status().covered }, { vaultId: "beta", covered: false });
    assert.equal(catalog.getWebCatalogRuntimeById("dup"), primaryRuntime);
    assert.equal(catalog.getWebCatalogRuntimeById("unknown-id"), null);
    // current: catalogFileFor() names the SQLite file with the raw user-controlled id;
    // contract §3.3 wants a stable sha256 dataKey for secondary DATA_PATH state, while
    // §5.2 explicitly defers the SQLite format/path migration (moved by A2/B7).
  } finally {
    catalog.__resetWebCatalogRuntimesForTests();
    process.env.WEB_CATALOG_ENABLED = "false";
  }
});

test("without WEB_VAULTS_ROOT the registry exposes a single primary and cannot create", async () => {
  const configured = process.env.WEB_VAULTS_ROOT;
  delete process.env.WEB_VAULTS_ROOT;
  try {
    const single = await import(`../src/app/vault-registry.js?w0fNoRoot=${Date.now()}`);
    assert.equal(single.defaultWebVaultId(), "default");
    const inventory = await single.listWebVaults();
    assert.equal(inventory.canCreate, false);
    assert.deepEqual(inventory.vaults.map((item) => [item.id, item.primary, item.root]), [["default", true, primaryRoot]]);
    await assert.rejects(() => single.createWebVault("anything"), /not configured/);
    // contract §1.2: the multi-vault registry is WEB_VAULTS_ROOT-gated; the canonical
    // registry must read the same configuration (moved by A2/B7).
  } finally {
    if (configured !== undefined) process.env.WEB_VAULTS_ROOT = configured;
  }
});
