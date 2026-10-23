import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "../frontmatter.js";
import { MAX_READ_BYTES, READ_ONLY, VAULT, VAULT_ADMISSIONS_PATH, VAULT_ADMISSION_ENROLLMENT_PATH, VAULT_DISCOVERY_DEBOUNCE_MS, VAULT_DISCOVERY_ENABLED, VAULT_DISCOVERY_MAX_COALESCE_MS, VAULT_DISCOVERY_PERIODIC_MAX_SECONDS, VAULT_DISCOVERY_PERIODIC_SECONDS, configuredWebDefaultVault, configuredWebVaultsRoot } from "../config.js";
import { allTagsForNote } from "../obsidian.js";
import { evaluateObsidianQuery } from "../search/evaluator.js";
import { hybridSearch } from "../search/hybrid-search.js";
import { parseObsidianQuery } from "../search/obsidian-query.js";
import { createLinkResolver } from "../vault-index.js";
import { validateVaultId } from "../vault-runtime/descriptor.js";
import { createVaultAdmissionController } from "./vault-admission.js";
import { createVaultAdmissionAdminBinding } from "./vault-admission-admin-binding.js";
import { createVaultServingGate, servingRefusalError } from "../vault-runtime/serving-gate.js";
import { wiredCapabilities } from "../vault-runtime/capabilities.js";
import { createVaultRegistry } from "../vault-runtime/registry.js";
import { getWebCatalogRuntime } from "./web-catalog/runtime.js";
import { assertCanonicalInsideRoot, assertWritable, atomicWriteFile, exists, normalizeVaultInput, resolveVaultPath } from "../vault.js";
import { assertMutationBudget } from "../base-patch-budget.js";
import { patchBaseDocument } from "../base-patch.js";
import { readBaseInRoot } from "./base-reader.js";

const webVaultsRoot = configuredWebVaultsRoot();
const VAULTS_ROOT = webVaultsRoot ? path.resolve(webVaultsRoot) : null;
const DEFAULT_ID = String(configuredWebDefaultVault() || path.basename(VAULT) || "vault").trim();
const MAX_WEB_NOTES = 10_000;

// W2 fix (#437 RETURN): the serving gate exists whenever multi-Vault management is configured. It
// starts DISARMED and is armed by the controller once admission enforcement is on.
const vaultServingGate = VAULTS_ROOT !== null ? createVaultServingGate() : null;

// B7: `src/vault-runtime/registry.js` (A2) is the inventory/root authority — discovery,
// ID validation, canonical roots, duplicate-root refusal — with §4.2 snapshot semantics:
// one startup refresh (first call) plus an explicit refresh after `createWebVault`;
// never a rescan per request, a timer or a directory watcher.
//
// F1 §31/D1: this is the process's ONE canonical instance. It is exported so the composition
// root injects exactly this object wherever Vault inventory is consumed (the Wave E Admin
// assembly, the Wave D runtime map) instead of constructing a second A2 registry whose snapshot
// and refresh counter could drift from the Web face. Its descriptors carry the Wave D capability
// graph (`wiredCapabilities`), which is the per-Vault runtime fact §3.4 requires server_info and
// Admin to report.
const registry = createVaultRegistry({
  primaryRoot: VAULT,
  primaryId: VAULTS_ROOT ? DEFAULT_ID : "default",
  vaultsRoot: VAULTS_ROOT,
  writable: !READ_ONLY,
  capabilitiesFor: wiredCapabilities,
  // W2 (#437) §2.1/§2.2: a PERSISTENT admission gate. Inert until the admission controller exists;
  // afterwards EVERY refresh (including the Admin inventory route, which this wave does not own) is
  // gated, so an ungated publish is impossible. See `vault-admission.js`.
  gate: (descriptor) => admissionGate(descriptor),
  // W2 fix (#437 RETURN, item 1): the ONE serving authority. A structural primary descriptor may
  // stay in the snapshot while its service right is refused; `get`/`list` and the runtime map obey it.
  servingGate: vaultServingGate,
});

/** The canonical A2 VaultRegistry instance (§31 single point; never construct a second one). */
export const webVaultRegistry = registry;
let inventoryReady = null;

// ---------------------------------------------------------------------------
// W2 (#437) — admission + unified reconciliation. The controller is built whenever multi-Vault
// management is configured; `VAULT_DISCOVERY_ENABLED` only controls the AUTOMATIC discovery trigger
// (item 2). Enforcement is on when that switch is set OR `vault-admissions.json` already exists, so
// a previously admitted instance stays managed after the switch is turned off: a missing file admits
// nothing (§2.3) and a corrupt/unreadable file refuses startup (§2.2).
// ---------------------------------------------------------------------------
export const vaultAdmissionsEnabled = VAULTS_ROOT !== null;

const admissionController = VAULTS_ROOT !== null
  ? createVaultAdmissionController({
      registry,
      file: VAULT_ADMISSIONS_PATH, enrollmentFile: VAULT_ADMISSION_ENROLLMENT_PATH,
      automaticDiscovery: VAULT_DISCOVERY_ENABLED,
      // W4 (#437): the frozen scheduling parameters, read in the app seam (never inside
      // `vault-runtime/*`, which must not import global path/env constants).
      discovery: {
        debounceMs: VAULT_DISCOVERY_DEBOUNCE_MS,
        maxCoalesceMs: VAULT_DISCOVERY_MAX_COALESCE_MS,
        periodicMs: VAULT_DISCOVERY_PERIODIC_SECONDS * 1000,
        maxBackoffMs: VAULT_DISCOVERY_PERIODIC_MAX_SECONDS * 1000,
      },
      configDigest: createHash("sha256").update(JSON.stringify([VAULTS_ROOT, DEFAULT_ID, VAULT])).digest("hex"),
    })
  : null;

async function admissionGate(descriptor) {
  if (admissionController !== null) return admissionController.gate(descriptor);
  return { admitted: true, admission: null, status: "ready", reason: null, identity: null };
}

/** Structured refusal (503/403) for one Vault id, or `null` when it may serve content. */
const vaultRefusal = (id) => (admissionController === null || !admissionController.enforced() ? null : registry.refusal(id));
// item 1: a refused Vault answers a structured refusal (503/403); never an ENOENT fallback to primary.
function requireServable(id) {
  const requested = String(id || defaultWebVaultId());
  const vault = registry.get(requested);
  if (vault) return vault;
  const refusal = vaultRefusal(requested);
  if (refusal !== null) throw servingRefusalError(requested, refusal);
  throw Object.assign(new Error("Vault not found"), { code: "ENOENT" });
}

/** Fail-closed load; the composition root MUST await this before listening (corruption ⇒ throw). */
export const loadVaultAdmissions = () =>
  admissionController === null ? Promise.resolve({ enabled: false, initialized: false, revision: 0 }) : admissionController.load();

/** Bind the reconciliation service to the D0 runtime map (once) and reset the memoized startup. */
export function installVaultReconciliation(options = {}) {
  if (admissionController === null || !admissionController.enforced()) return null;
  const installed = admissionController.install(options);
  inventoryReady = null;
  return installed;
}

/**
 * W4 (#437): start the automatic triggers (directory watcher + bounded periodic fallback). Called
 * only after the STARTUP round published, and only with `VAULT_DISCOVERY_ENABLED` on; otherwise it
 * returns `null` and nothing automatic runs (contract §10).
 */
export const startVaultDiscovery = () => (admissionController === null ? null : admissionController.startDiscovery());

/** W4: release the watch handles and timers (graceful shutdown). */
export const stopVaultDiscovery = () => (admissionController === null ? null : admissionController.stopDiscovery());

// Admin-only injected seam; content callers continue to use servable registry views.
export const vaultAdmissionAdmin = createVaultAdmissionAdminBinding(admissionController);
// Preserve the public W2 seams: manual trigger, read-only status and protected decisions.
export const { reconcile: reconcileVaults, status: vaultDiscoveryStatus,
  initialize: initializeVaultAdmissions, approve: approveVaultAdmission,
  revoke: revokeVaultAdmission } = vaultAdmissionAdmin;

// Startup refresh memoized until it succeeds (it replaces the old lazy mkdir); a later call
// may retry after a failure, but nothing polls (§4.2). With admission enforced this is the STARTUP
// trigger of the unified reconciliation service — a gated inventory read can never fall back to an
// ungated `registry.refresh()` (the §4.2 no-watcher rule still holds: nothing polls). The record is
// ALWAYS loaded first, so turning the discovery switch off cannot bypass an existing decision (item 2).
const ensureInventory = () => (inventoryReady ??= Promise.resolve()
  .then(() => (VAULTS_ROOT ? fs.mkdir(VAULTS_ROOT, { recursive: true }) : undefined))
  .then(async () => {
    if (admissionController === null) return registry.refresh();
    // A composition root that did not load/bind yet (e.g. OAuth disabled) still gets the gated
    // startup path: load the record (fail-closed) and self-install the service WITHOUT a runtime map.
    if (!admissionController.loaded()) await admissionController.load();
    if (!admissionController.enforced()) return registry.refresh();
    if (!admissionController.installed()) admissionController.install({});
    return admissionController.reconcile("startup");
  })
  .catch((error) => { inventoryReady = null; throw error; }));

// Minimized Web record: canonicalRoot/dataKey/capabilities stay internal to the registry.
const asWebRecord = ({ id, name, root, primary, writable }) => ({ id, name, root, primary, writable });

// Web keeps its `String(...).trim()` normalization; the canonical validator rules on the result.
const safeId = (value) => { try { return validateVaultId(String(value || "").trim()); } catch { throw new Error("Invalid Vault name"); } };

function relative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

export function defaultWebVaultId() {
  return VAULTS_ROOT ? DEFAULT_ID : "default";
}

export async function listWebVaults() {
  await ensureInventory();
  return { vaults: registry.list().map(asWebRecord), canCreate: Boolean(VAULTS_ROOT) && !READ_ONLY };
}

export async function resolveWebVault(id) {
  await ensureInventory();
  // item 1: a refused Vault answers a STRUCTURED refusal (503/403); there is no ENOENT fallback to
  // the primary and no inventory detail leak.
  return asWebRecord(requireServable(String(id || defaultWebVaultId())));
}

/**
 * Contract §14 — the canonical Vault dependency Publish injects (`src/publish/service.js`).
 *
 * Same single A2 instance and same memoized inventory refresh as `resolveWebVault`, but it returns
 * the *canonical descriptor* (`canonicalRoot`/`dataKey`/`capabilities` included) instead of the
 * minimized Web record: a consumer that only needs `id`/`root`/`primary` no longer has to go
 * through a Web-shaped projection, and there is still exactly one registry (Wave F §31/D1). The
 * failure code stays the frozen `ENOENT` "Vault not found" (SEC-MV03: no inventory detail leaks).
 */
export async function resolveCanonicalVault(id) {
  await ensureInventory();
  const requested = String(id || defaultWebVaultId());
  return requireServable(requested);
}

export async function createWebVault(name) {
  assertWritable();
  if (!VAULTS_ROOT) throw new Error("Multi-Vault management is not configured");
  const id = safeId(name);
  const root = path.join(VAULTS_ROOT, id);
  if (await exists(root)) throw new Error("Vault already exists");
  await assertCanonicalInsideRoot(VAULTS_ROOT, root, { allowMissing: true });
  await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
  if (admissionController !== null && admissionController.enforced()) {
    // W2 (#437): an explicitly created directory is still a *discovery*, not an approval. It stays
    // `pending` until a trusted Admin decision (W3 wires the operator identity). The returned record
    // carries the admission state so a caller can never mistake a pending Vault for a usable one.
    await ensureInventory(); await reconcileVaults("manual", { actor: "web-vault-create" });
    const entry = admissionController.store.entryFor(id);
    return { ...asWebRecord(registry.get(id) ?? { id, name: id, root, primary: id === DEFAULT_ID, writable: !READ_ONLY }), admission: entry?.admission ?? "pending" };
  }
  await ensureInventory(); await registry.refresh(); // §4.2: explicit refresh, never a watcher
  // Canonical record when the registry publishes this id; the on-disk record otherwise.
  return asWebRecord(registry.get(id) ?? { id, name: id, root, primary: id === DEFAULT_ID, writable: !READ_ONLY });
}

export async function resolveWebVaultPath(vault, userPath, options = {}) {
  let normalized = normalizeVaultInput(userPath);
  if (options.assumeMarkdown && normalized && !path.posix.extname(normalized)) normalized += ".md";
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) throw new Error("Invalid Vault path");
  const absolute = path.resolve(vault.root, ...normalized.split("/"));
  await assertCanonicalInsideRoot(vault.root, absolute, { allowMissing: options.allowMissing });
  return { absolute, path: relative(vault.root, absolute) };
}

async function markdownFiles(vault) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (files.length >= MAX_WEB_NOTES || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") files.push(absolute);
    }
  }
  await visit(vault.root);
  return files;
}

async function webLinkRecords(vault) {
  const records = [];
  for (const absolute of await markdownFiles(vault)) {
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_READ_BYTES) continue;
    const notePath = relative(vault.root, absolute);
    let aliases = [];
    try {
      const parsed = parseFrontmatter(await fs.readFile(absolute, "utf8"));
      const value = parsed.data.aliases ?? parsed.data.alias ?? [];
      aliases = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
    } catch {
      // One malformed note must not make navigation for the rest of the Vault fail.
    }
    records.push({
      path: notePath,
      basename: path.basename(notePath, ".md"),
      aliases,
    });
  }
  return records;
}

export async function resolveWebNoteLink(vault, sourcePath, target) {
  const source = await resolveWebVaultPath(vault, sourcePath, { assumeMarkdown: true });
  const rawTarget = String(target || "").trim();
  if (!rawTarget) {
    return { status: "resolved", target: rawTarget, path: source.path, candidates: [source.path] };
  }
  const resolve = createLinkResolver(await webLinkRecords(vault));
  return resolve({ target: rawTarget, type: "wiki" }, source.path);
}

async function listWebTreeNotes(vault, { pathFilter } = {}) {
  const collected = [];
  const maxCollected = typeof pathFilter === "function" ? MAX_WEB_NOTES : 301;
  let visitedMarkdown = 0;

  async function visit(directory) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (collected.length >= maxCollected || visitedMarkdown >= MAX_WEB_NOTES) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        if (collected.length >= maxCollected) return;
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      visitedMarkdown += 1;
      const stat = await fs.stat(absolute);
      if (stat.size > MAX_READ_BYTES) continue;
      const notePath = relative(vault.root, absolute);
      const item = {
        path: notePath,
        title: path.basename(notePath, ".md"),
        modified: stat.mtime.toISOString(),
        tags: [],
        score: 0,
        matchCount: 0,
        snippets: [],
      };
      if (!pathFilter || pathFilter(item)) collected.push(item);
    }
  }

  await visit(vault.root);
  return {
    notes: collected.slice(0, 300),
    truncated: collected.length > 300,
  };
}

export async function listWebNotes(vault, query = "", options = {}) {
  const wanted = String(query || "").trim().slice(0, 1000);
  if (!wanted && !options.semantic) {
    const tree = await listWebTreeNotes(vault, { pathFilter: options.pathFilter });
    return {
      notes: tree.notes,
      query: wanted,
      truncated: tree.truncated,
      semanticRequested: false,
      semanticUsed: false,
      semanticError: null,
      hybridUsed: false,
    };
  }

  const parsedQuery = parseObsidianQuery(wanted);
  const records = [];
  for (const absolute of await markdownFiles(vault)) {
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_READ_BYTES) continue;
    const raw = await fs.readFile(absolute, "utf8");
    let parsed;
    try {
      parsed = parseFrontmatter(raw);
    } catch {
      // Search must remain available when one note has malformed YAML frontmatter.
      // Treat that note as plain Markdown text with no frontmatter metadata.
      parsed = { content: raw, data: {} };
    }
    const notePath = relative(vault.root, absolute);
    const note = { path: notePath, raw, content: parsed.content, frontmatter: parsed.data };
    records.push({
      ...note,
      name: path.basename(notePath),
      basename: path.basename(notePath, ".md"),
      aliases: (Array.isArray(parsed.data.aliases ?? parsed.data.alias) ? parsed.data.aliases ?? parsed.data.alias : [parsed.data.aliases ?? parsed.data.alias]).map(String).filter(Boolean),
      tags: allTagsForNote(note),
      revision: revision(Buffer.from(raw, "utf8")),
      stat: { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() },
    });
  }
  let search;
  if (options.semantic && !vault.primary) {
    const results = records.flatMap((record) => {
      const exact = evaluateObsidianQuery(record, parsedQuery, { caseSensitive: options.caseSensitive });
      return exact.matched ? [{ path: record.path, matchCount: exact.matchCount, snippets: exact.snippets, score: 1 }] : [];
    });
    search = { results, semanticUsed: false, semanticError: "Semantic search is available only for the primary Vault", hybridUsed: false };
  } else {
    search = await hybridSearch(records, parsedQuery, { semantic: options.semantic, caseSensitive: options.caseSensitive, limit: 300, contextLength: 80, maxMatchesPerNote: 2 });
  }
  const byPath = new Map(records.map((record) => [record.path, record]));
  const notes = search.results.map((result) => {
    const record = byPath.get(result.path);
    return {
      path: result.path,
      title: record.basename,
      modified: record.stat.modified,
      tags: record.tags,
      score: result.score,
      matchCount: result.matchCount,
      snippets: result.snippets,
    };
  }).sort((left, right) => wanted ? (right.score || 0) - (left.score || 0) || left.path.localeCompare(right.path) : left.path.localeCompare(right.path));
  const filteredNotes = typeof options.pathFilter === "function" ? notes.filter(options.pathFilter) : notes;
  return {
    notes: filteredNotes.slice(0, 300),
    query: wanted,
    truncated: filteredNotes.length > 300,
    semanticRequested: Boolean(options.semantic),
    semanticUsed: search.semanticUsed,
    semanticError: search.semanticError,
    hybridUsed: search.hybridUsed,
  };
}

function revision(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

/**
 * Process-local write serialization keyed by canonical vault root + note path.
 *
 * Covers the revision existence check through the final atomic rename for every
 * Web `writeWebNote` path (primary and secondary). Primary still uses
 * `atomicWriteFile` (history / author / vault helpers) inside this same gate so
 * Web/Web concurrent creates and CAS updates serialize. `writeWebBasePatch`
 * (A4b) takes the same gate: a `.base` path is never written concurrently with
 * another Web request for the same path.
 *
 * Lock keys use realpath (and case-folding on Windows) so symlink aliases and
 * alternate drive/case spellings of the same vault root share one lock.
 *
 * IMPORTANT: This is NOT cross-process compare-and-swap. MCP tools, other Node
 * processes, Syncthing, Git, or the Obsidian desktop app are not coordinated
 * by this lock. Rely on version history / recovery rather than true multi-process CAS.
 */
const webNoteWriteLocks = new Map();

async function webNoteWriteLockKey(vaultRoot, notePath) {
  let canonicalRoot = path.resolve(vaultRoot);
  try {
    canonicalRoot = await fs.realpath(vaultRoot);
  } catch {
    /* root may be missing mid-create; resolved path is still stable enough */
  }
  const normalizedPath = String(notePath || "").split(path.sep).join("/");
  if (process.platform === "win32") {
    return `${canonicalRoot.toLowerCase()}\0${normalizedPath.toLowerCase()}`;
  }
  return `${canonicalRoot}\0${normalizedPath}`;
}

async function withWebNoteWriteLock(vaultRoot, notePath, task) {
  const key = await webNoteWriteLockKey(vaultRoot, notePath);
  const previous = webNoteWriteLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => {}).then(() => gate);
  webNoteWriteLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (webNoteWriteLocks.get(key) === current) webNoteWriteLocks.delete(key);
  }
}

async function resolveWebNoteFile(vault, userPath) {
  const resolved = await resolveWebVaultPath(vault, userPath, { assumeMarkdown: true });
  const stat = await fs.stat(resolved.absolute);
  if (!stat.isFile() || stat.size > MAX_READ_BYTES) throw new Error("Note exceeds the Web editor limit");
  return {
    ...resolved,
    stat: { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() },
  };
}

export async function statWebNote(vault, userPath) {
  const note = await resolveWebNoteFile(vault, userPath);
  return { path: note.path, stat: note.stat };
}

export async function readWebNote(vault, userPath) {
  const note = await resolveWebNoteFile(vault, userPath);
  const content = await fs.readFile(note.absolute);
  return { path: note.path, content: content.toString("utf8"), revision: revision(content), stat: note.stat };
}

export async function writeWebNote(vault, userPath, content, ifMatch) {
  assertWritable();
  const resolved = await resolveWebVaultPath(vault, userPath, { assumeMarkdown: true, allowMissing: true });
  const result = await withWebNoteWriteLock(vault.root, resolved.path, async () => {
    const alreadyExists = await exists(resolved.absolute);
    if (alreadyExists) {
      const current = await fs.readFile(resolved.absolute);
      const currentRevision = revision(current);
      if (!ifMatch) {
        // #624: *missing* precondition carries its own code so the HTTP face answers
        // 428 `precondition-required` (the same body as `PATCH /api/web/v1/base`)
        // instead of the shared classifier's 409. The message is unchanged for
        // registry-level callers; the revision travels so the face can state it.
        const required = new Error("Existing notes require a revision");
        required.code = "WEB_NOTE_PRECONDITION_REQUIRED";
        required.currentRevision = currentRevision;
        throw required;
      }
      if (ifMatch !== currentRevision) {
        // *Stale*, not missing: still a 409, now with the revision that is on disk.
        const conflict = new Error(`Revision conflict: expected ${ifMatch}, current ${currentRevision}`);
        conflict.code = "WEB_NOTE_REVISION_CONFLICT";
        conflict.expectedRevision = ifMatch;
        conflict.currentRevision = currentRevision;
        throw conflict;
      }
    } else if (ifMatch) {
      const missing = new Error(`Revision conflict: expected ${ifMatch}, but the file does not exist`);
      missing.code = "WEB_NOTE_REVISION_CONFLICT";
      missing.expectedRevision = ifMatch;
      missing.currentRevision = null;
      throw missing;
    }

    if (vault.primary) {
      const primaryPath = resolveVaultPath(resolved.path, { assumeMarkdown: true });
      const written = await atomicWriteFile(primaryPath, content, { encoding: "utf8", ifMatch });
      return { path: resolved.path, created: !alreadyExists, revision: written.revision, size: written.stat.size };
    }

    await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
    await assertCanonicalInsideRoot(vault.root, path.dirname(resolved.absolute));
    const temporary = path.join(path.dirname(resolved.absolute), `.${path.basename(resolved.absolute)}.web-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, "utf8");
      await fs.rename(temporary, resolved.absolute);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    const stat = await fs.stat(resolved.absolute);
    return { path: resolved.path, created: !alreadyExists, revision: revision(Buffer.from(content, "utf8")), size: stat.size };
  });
  // Phase 1B read-your-writes: the file is already committed, so update the catalog
  // in the same request flow (best-effort; the watcher is the backstop).
  const catalog = getWebCatalogRuntime(vault);
  if (catalog) await catalog.indexFile(resolved.absolute, resolved.path);
  return result;
}

/**
 * A4b: the Web `.base` increment write (`WRITE-SURFACE-DESIGN.md` §2.2/§4/§5).
 *
 * Same structure as `writeWebNote` — shared per-path lock, CAS against the
 * revision read *inside* the lock, atomic tmp+rename — but the payload is an A4a
 * increment instead of a whole document, so comments, key order and unknown keys
 * survive by construction.
 *
 * The path gate is `readBaseInRoot` (vault-relative + containment + per-segment
 * symlink refusal + the shared MAX_READ_BYTES budget): the read face's own gate,
 * not a second rule set (§5.2). A missing/escaping/non-`.base` path therefore
 * fails with the reader's `BASE_*` code before anything can be written.
 *
 * Failures: `BasePatchError` (`base-not-patchable` / `base-unknown-key`),
 * `BaseQueryError` (`invalid-schema` / `invalid-yaml`), `BaseReaderError`
 * (`BASE_*`), and the CAS conflict below — never a half-written document, because
 * `patchBaseDocument` either returns the full new text or throws.
 *
 * The CAS conflict is a plain Error (not a Web/HTTP type) carrying the facts the
 * 409 body needs: `code = "BASE_REVISION_CONFLICT"`, `currentRevision`, `stat`.
 *
 * @param {object} vault resolved Web vault record (`{ id, root, primary }`)
 * @param {string} userPath vault-relative `.base` path
 * @param {Array<object>} mutations A4a increments
 * @param {string} ifMatch `"<revision>"` or `"*"` (must exist, no revision compare)
 * @returns {Promise<{path: string, changed: boolean, revision: string, size: number,
 *   previousRevision: string}>}
 */
export async function writeWebBasePatch(vault, userPath, mutations, ifMatch) {
  assertWritable();
  // §4.4 amplification budget, before the read and the YAML parse: the route checks it
  // even earlier (before this function is entered), this is the domain's own floor for
  // any non-HTTP caller.
  assertMutationBudget(mutations);
  const base = await readBaseInRoot(vault, userPath);
  const absolute = path.resolve(vault.root, ...base.path.split("/"));
  const result = await withWebNoteWriteLock(vault.root, base.path, async () => {
    // Re-read inside the lock: the CAS token must describe the bytes we patch.
    const current = await readBaseInRoot(vault, base.path);
    if (ifMatch !== "*" && ifMatch !== current.revision) {
      const conflict = new Error(`Revision conflict: expected ${ifMatch}, current ${current.revision}`);
      conflict.code = "BASE_REVISION_CONFLICT";
      conflict.path = current.path;
      conflict.expectedRevision = ifMatch;
      conflict.currentRevision = current.revision;
      conflict.stat = { size: current.stat.size, mtimeMs: Date.parse(current.stat.modified), modified: current.stat.modified };
      throw conflict;
    }
    const next = patchBaseDocument(current.raw, mutations);
    // A4a's idempotence: the document already holds the requested values. Nothing is
    // written, so the revision cannot change and the caller gets the current one back.
    if (next === current.raw) {
      return { path: current.path, changed: false, revision: current.revision, size: current.stat.size, previousRevision: current.revision };
    }
    if (Buffer.byteLength(next, "utf8") > MAX_READ_BYTES) {
      const tooLarge = new Error("Base exceeds the read limit after patching");
      tooLarge.code = "BASE_TOO_LARGE";
      throw tooLarge;
    }
    if (vault.primary) {
      // Primary keeps history / author / vault semantics (`atomicWriteFile` re-asserts
      // `ifMatch` itself, which cannot fail twice inside one lock).
      const written = await atomicWriteFile(resolveVaultPath(current.path), next, { encoding: "utf8", ifMatch: current.revision });
      return { path: current.path, changed: true, revision: written.revision, size: written.stat.size, previousRevision: current.revision };
    }
    await assertCanonicalInsideRoot(vault.root, path.dirname(absolute));
    const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.web-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, next, "utf8");
      await fs.rename(temporary, absolute);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    const stat = await fs.stat(absolute);
    return { path: current.path, changed: true, revision: revision(Buffer.from(next, "utf8")), size: stat.size, previousRevision: current.revision };
  });
  // Read-your-writes (same best-effort catalog update as `writeWebNote`).
  if (result.changed) {
    const catalog = getWebCatalogRuntime(vault);
    if (catalog) await catalog.indexFile(absolute, result.path);
  }
  return result;
}

/** Test helper: expose canonical lock key derivation (no secrets). */
export async function webNoteWriteLockKeyForTests(vaultRoot, notePath) {
  return webNoteWriteLockKey(vaultRoot, notePath);
}
