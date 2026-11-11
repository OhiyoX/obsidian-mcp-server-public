// `src/publish/service.js` — the Publish registry (issues #277/#278, Wave B / B1).
//
// PublishService is the *final* authority for the Publish contract (dev doc §6):
//   * #278 Markdown-only: every document publish target is canonicalized and gated through
//     `publish/target.js` (A1), and a `kind: "folder"` target is gated there as a directory.
//     No other module keeps a second allowlist.
//   * #277 lifecycle: record state is decided by `publish/lifecycle.js` (A2); the
//     resulting transition is applied and persisted inside one `mutationQueue`
//     (§8.2). An observed missing/non-Markdown target retires the record
//     (orphaned/invalid) and the old opaque id never revives; recovery is always
//     revoke + explicit publish → new id (§5.1).
//   * `resolve` may persist the observation (§5.2) but fails closed on IO errors and
//     never serves a cached body (§15 S08).
//
// Surfaces (Web routes / MCP tools) own HTTP/JSON-RPC error mapping; this module
// only throws/returns the domain codes frozen in §7 (A1 `PublishTargetError` +
// A2 `PUBLISH_ERROR_CODES`).
//
// State file: `{ version: 3, records: [...] }`, one record per `vaultId + NUL + path + kind`,
// each record carrying a `kind` (`document` / `folder`).
// A v1/v2 file is migrated in memory on load (`migratePublishState`), fail-closed per
// record; only a structurally broken file refuses to load (§8.1).

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_PATH } from "../config.js";
import { observePublicationRead, publicationAuthorizationRequest, PUBLISH_LEGACY_VERDICTS, withPublicationRecord } from "../authorization/adapters/publish.js";
// Wave F / F1 (§14): the Vault dependency is the canonical A2 registry's own resolver
// (`resolveCanonicalVault`), injected under this module's historical local name. Publish no longer
// goes through the Web-shaped `resolveWebVault` projection; one registry, one lookup (§31/D1).
import { defaultWebVaultId, readWebNote, resolveCanonicalVault as resolveWebVault, resolveWebVaultPath, statWebNote } from "../app/vault-registry.js";
import { assertWithinCaps } from "./folder-listing.js";
import {
  UNSUPPORTED_PUBLISH_TARGET,
  PUBLISH_TARGET_KIND_DOCUMENT,
  PUBLISH_TARGET_KIND_FOLDER,
  PublishTargetError,
  assertPublishableTarget,
  isMarkdownTargetPath,
  normalizePublishTarget,
} from "./target.js";
import {
  PUBLISH_ACTIONS,
  PUBLISH_ERROR_CODES,
  PUBLISH_ID_POLICY,
  PUBLISH_LIFECYCLE,
  PUBLISH_RECORD_KINDS,
  STATE_VERSION_TARGET,
  isPublishedCandidate,
  migratePublishState,
  planPublish,
  planResolve,
  planRevoke,
  publishRecordKey,
  readLifecycle,
} from "./lifecycle.js";

export const STATE_VERSION = 3;
const LOADABLE_STATE_VERSIONS = new Set([1, 2, STATE_VERSION]);
const DEFAULT_FILE = path.join(DATA_PATH, "publish", "state.json");

// A1 and A2 both name the frozen cross-surface code; wiring two owners without this
// ratchet is a silent drift risk (§16).
if (PUBLISH_ERROR_CODES.UNSUPPORTED_PUBLISH_TARGET !== UNSUPPORTED_PUBLISH_TARGET) {
  throw new Error("publish error-code drift between target.js and lifecycle.js");
}

// Same ratchet for the two record kinds: target.js states them itself (its boundary ratchet
// forbids the import), so the second owner must refuse to start when they differ (§16).
if (PUBLISH_RECORD_KINDS.FOLDER !== PUBLISH_TARGET_KIND_FOLDER
  || PUBLISH_RECORD_KINDS.DOCUMENT !== PUBLISH_TARGET_KIND_DOCUMENT) {
  throw new Error("publish record-kind drift between target.js and lifecycle.js");
}

// The loader writes `STATE_VERSION`, the migration targets `STATE_VERSION_TARGET`. One
// owner bumping alone would make the migrated file unloadable, so refuse to start.
if (STATE_VERSION !== STATE_VERSION_TARGET) {
  throw new Error(`publish state-version drift: service writes ${STATE_VERSION}, lifecycle targets ${STATE_VERSION_TARGET}`);
}

function now() {
  return new Date().toISOString();
}

function clean(value, max = 240) {
  return String(value ?? "").replace(/[\r\n\0]/g, " ").trim().slice(0, max);
}

// `lifecycle` is part of the public record now (Admin/published: read it; §9).
function publicRecord(record) {
  return {
    id: record.id,
    kind: record.kind === PUBLISH_RECORD_KINDS.FOLDER ? PUBLISH_RECORD_KINDS.FOLDER : PUBLISH_RECORD_KINDS.DOCUMENT,
    vaultId: record.vaultId,
    path: record.path,
    lifecycle: readLifecycle(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy || null,
  };
}

// Records are Vault-relative canonical paths. A hand-written/legacy state file must
// not smuggle an absolute or traversing path into `list()` (§15 S02/S03), so unsafe
// entries are dropped at load instead of becoming an Admin row.
function isSafeRecordPath(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

// §12.2 existence/size half of the gate, adapted to A1's injected stat probe.
async function statPublishCandidate({ absolute }) {
  try {
    const stat = await fs.stat(absolute);
    return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Lifecycle observation for an existing record. `{}` (all fields undefined) means the
// probe itself failed → `unverifiable`, the fail-closed branch of `classifyObservation`.
// A folder record's target is a directory, so it answers `isDirectory` instead of
// `isMarkdown`; a document record keeps the Markdown answer bit for bit.
async function probeRecordTarget(vault, canonicalPath, kind) {
  let absolute;
  try {
    absolute = (await resolveWebVaultPath(vault, canonicalPath, { allowMissing: true })).absolute;
  } catch {
    return {};
  }
  try {
    const stat = await fs.stat(absolute);
    if (kind === PUBLISH_RECORD_KINDS.FOLDER) {
      return { exists: true, isMarkdown: false, isDirectory: stat.isDirectory() };
    }
    if (!stat.isFile()) return { exists: true, isMarkdown: false };
    return { exists: true, isMarkdown: isMarkdownTargetPath(canonicalPath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, isMarkdown: false };
    return {};
  }
}

// `status()` reports the target it was asked about. `statWebNote` answers only a `.md` file
// within the read limit and refuses every other path, so a folder target is probed as the
// directory it is; a path that is neither keeps the note reader's own answer.
async function statStatusTarget(vault, userPath) {
  try {
    return { note: await statWebNote(vault, userPath), kind: PUBLISH_RECORD_KINDS.DOCUMENT };
  } catch (error) {
    // Only a refusal that says "no such note" may become a folder answer; a coded refusal
    // (traversal, permission) keeps its own answer.
    if (error?.code && error.code !== "ENOENT") throw error;
    const note = await statFolderNote(vault, userPath);
    if (!note) throw error;
    return { note, kind: PUBLISH_RECORD_KINDS.FOLDER };
  }
}

// `null` when the path is not a directory, so the caller keeps the note reader's refusal.
async function statFolderNote(vault, userPath) {
  const target = await normalizePublishTarget(userPath, {
    // `allowMissing` keeps a path that is neither a note nor a directory an ENOENT for the
    // callers, exactly like the note probe (routes map that to one 404 body).
    resolvePath: (requested, options) => resolveWebVaultPath(vault, requested, { ...options, allowMissing: true }),
    kind: PUBLISH_RECORD_KINDS.FOLDER,
  });
  const stat = await fs.stat(target.absolute);
  if (!stat.isDirectory()) return null;
  return { path: target.path, stat: { size: stat.size, modified: stat.mtime.toISOString(), created: stat.birthtime.toISOString() } };
}

// The one public address of a record, so no surface builds a second spelling. The two shapes
// are the route table's: a folder listens on `/publish/d/:id`, a document on `/publish/:id`.
export function publicPathOf(record) {
  return record?.kind === PUBLISH_RECORD_KINDS.FOLDER ? `/publish/d/${record.id}` : `/publish/${record?.id}`;
}

export function encodeDocumentRoute(vaultId, notePath) {
  const payload = JSON.stringify({ v: 1, vaultId: clean(vaultId, 80), path: clean(notePath, 4096) });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeDocumentRoute(value) {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9_-]{8,8192}$/.test(encoded)) throw new Error("Invalid document route");
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid document route");
  }
  const vaultId = clean(parsed?.vaultId, 80);
  const notePath = clean(parsed?.path, 4096);
  if (parsed?.v !== 1 || !vaultId || !notePath) throw new Error("Invalid document route");
  return { vaultId, path: notePath };
}

export class PublishService {
  constructor({ file = DEFAULT_FILE } = {}) {
    this.file = file;
    this.data = { version: STATE_VERSION, records: [] };
    this.saveQueue = Promise.resolve();
    this.mutationQueue = Promise.resolve();
    this.migrationIssues = [];
    this.ready = this.load();
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new Error(`Cannot load publish state: ${error.message}`);
    }
    // §8.1: a structurally broken file is fatal; one bad record is not.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.records)) {
      throw new Error("Cannot load publish state: malformed state file");
    }
    if (!LOADABLE_STATE_VERSIONS.has(parsed.version)) {
      throw new Error(`Cannot load publish state: unsupported state version ${String(parsed.version)}`);
    }
    const migrated = migratePublishState(parsed);
    const records = [];
    const issues = [...migrated.issues];
    for (const record of migrated.records) {
      if (!isSafeRecordPath(record.path)) {
        issues.push(`record ${record.id}: unsafe_record_path`);
        continue;
      }
      records.push({ ...record });
    }
    this.migrationIssues = issues;
    this.data = { version: STATE_VERSION, records };
  }

  async save() {
    const snapshot = JSON.stringify(this.data, null, 2) + "\n";
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, this.file);
        await fs.chmod(this.file, 0o600).catch(() => {});
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
    return this.saveQueue;
  }

  // Single mutation lane for publish/revoke/resolve-observation/list-observation (§8.2).
  #enqueue(task) {
    const run = this.mutationQueue.then(task);
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  #recordIndex(vaultId, canonicalPath, kind) {
    const key = publishRecordKey({ vaultId, path: canonicalPath, kind });
    return this.data.records.findIndex((item) => publishRecordKey(item) === key);
  }

  #applyTransition(index, transition) {
    const record = this.data.records[index];
    this.data.records[index] = { ...record, lifecycle: transition.to, updatedAt: now() };
  }

  // Observe one record and persist the lifecycle decision. Caller holds the queue.
  async #observeRecord(vault, index) {
    const record = this.data.records[index];
    const observation = await probeRecordTarget(vault, record.path, record.kind);
    const plan = planResolve({ record, observation });
    if (plan.changed && plan.transition) this.#applyTransition(index, plan.transition);
    return { observation, plan };
  }

  async status(vaultId, notePath) {
    await this.ready;
    const vault = await resolveWebVault(vaultId || defaultWebVaultId());
    const { note, kind } = await statStatusTarget(vault, notePath);
    return this.#enqueue(async () => {
      const index = this.#recordIndex(vault.id, note.path, kind);
      if (index < 0) return { vault, note, record: null };
      const { plan } = await this.#observeRecord(vault, index);
      if (plan.changed && plan.transition) await this.save();
      return { vault, note, record: publicRecord(this.data.records[index]) };
    });
  }

  async publish(vaultId, notePath, { actor, kind } = {}) {
    return this.#enqueue(async () => {
      await this.ready;
      const vault = await resolveWebVault(vaultId || defaultWebVaultId());
      const resolvePath = (requested, options) => resolveWebVaultPath(vault, requested, options);
      // An unknown `kind` is a document, the same default the record normalizer applies.
      const recordKind = kind === PUBLISH_RECORD_KINDS.FOLDER ? PUBLISH_RECORD_KINDS.FOLDER : PUBLISH_RECORD_KINDS.DOCUMENT;
      const target = await assertPublishableTarget(notePath, { resolvePath, stat: statPublishCandidate, kind: recordKind });
      // The folder caps refuse before the registry is touched, so a refusal leaves the state file
      // byte-identical (design 2026-11-08, "Caps and refusal codes").
      if (recordKind === PUBLISH_RECORD_KINDS.FOLDER) {
        await assertWithinCaps({ vault, folderPath: target.path });
      }
      const index = this.#recordIndex(vault.id, target.path, recordKind);
      const plan = planPublish({
        record: index < 0 ? null : this.data.records[index],
        observation: recordKind === PUBLISH_RECORD_KINDS.FOLDER
          ? { exists: true, isDirectory: true }
          : { exists: true, isMarkdown: true },
      });
      if (!plan.ok) throw new PublishTargetError(plan.errorCode, `Publish denied: ${plan.reason}`, { path: target.path });

      const timestamp = now();
      let next;
      if (plan.idPolicy === PUBLISH_ID_POLICY.NEW) {
        // #277 §5.1: an orphaned/invalid record is replaced, never revived; the
        // replacement always carries a fresh opaque id (§15 S04).
        if (plan.removeRecord && index >= 0) this.data.records.splice(index, 1);
        next = {
          id: randomBytes(32).toString("base64url"),
          kind: recordKind,
          vaultId: vault.id,
          path: target.path,
          lifecycle: plan.lifecycle,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: clean(actor, 160) || null,
        };
        this.data.records.push(next);
      } else {
        const current = this.data.records[index];
        next = { ...current, lifecycle: plan.lifecycle, updatedAt: plan.changed ? timestamp : current.updatedAt };
        this.data.records[index] = next;
      }
      await this.save();
      return { ...publicRecord(next), created: plan.idPolicy === PUBLISH_ID_POLICY.NEW };
    });
  }

  async revoke(vaultId, notePath, { kind } = {}) {
    return this.#enqueue(async () => {
      await this.ready;
      const vault = await resolveWebVault(vaultId || defaultWebVaultId());
      // #277 root cause: revoke must not depend on the current file, so it canonicalizes
      // with `allowMissing` instead of stat-ing the target. Container containment stays
      // enforced (A1 rejects absolute/UNC input; §15 S02). A path names a document
      // (`X.md`) or a folder (`X`); a caller that read the record knows which, so its kind
      // is tried alone. Without a kind, the old document-then-folder fallback answers:
      // guessing would let a folder revoke retire the document record `X.md`.
      const resolvePath = (requested, options) => resolveWebVaultPath(vault, requested, { ...options, allowMissing: true });
      const kinds = kind === PUBLISH_RECORD_KINDS.FOLDER || kind === PUBLISH_RECORD_KINDS.DOCUMENT
        ? [kind]
        : [PUBLISH_RECORD_KINDS.DOCUMENT, PUBLISH_RECORD_KINDS.FOLDER];
      let normalized = null;
      let index = -1;
      for (const candidate of kinds) {
        const target = await normalizePublishTarget(notePath, { resolvePath, kind: candidate });
        const found = this.#recordIndex(vault.id, target.path, candidate);
        if (found >= 0) {
          normalized = target;
          index = found;
          break;
        }
        normalized ??= target;
      }
      if (index < 0) return { revoked: false, vaultId: vault.id, path: normalized.path };
      const plan = planRevoke({ record: this.data.records[index] });
      if (!plan.removeRecord) return { revoked: false, vaultId: vault.id, path: normalized.path };
      const [removed] = this.data.records.splice(index, 1);
      await this.save();
      return { revoked: true, ...publicRecord(removed) };
    });
  }

  // A server-side rename moves the record, so the published address follows the file (Task 7).
  // A folder takes its whole subtree with it: the folder record and every record under
  // `fromPath`, because a `publish: true` note is visible anywhere and must keep its address
  // when its parent folder is renamed. A note rename matches its one exact path.
  // `false` when no record matches either rule: a note that was never published has no address
  // to keep. One mutation, one save — never a second list of records.
  moveRecord(vaultId, fromPath, toPath) {
    return this.#enqueue(async () => {
      await this.ready;
      const vault = String(vaultId ?? "");
      const from = clean(fromPath, 4096);
      const to = clean(toPath, 4096);
      if (!vault || !from || !to || from === to) return false;
      const descendantPrefix = `${from}/`;
      const arrivalOf = (record) => to + record.path.slice(from.length);
      const moved = this.data.records.filter((record) => record.vaultId === vault
        && (record.path === from || record.path.startsWith(descendantPrefix)));
      if (moved.length === 0) return false;
      // Two records must never share one key: `load` keeps the first and drops the rest. So a
      // dead record that already sits at an arrived key makes room for the record moving in.
      // Every moved record travels, dead or not: a tombstone is still Admin's to clean up.
      const arriving = new Set(moved.map((record) => publishRecordKey({ ...record, path: arrivalOf(record) })));
      const moving = new Set(moved);
      this.data.records = this.data.records.filter((record) => moving.has(record)
        || !(record.vaultId === vault
          && arriving.has(publishRecordKey(record))
          && readLifecycle(record) !== PUBLISH_LIFECYCLE.ACTIVE));
      const timestamp = now();
      for (const record of moved) {
        record.path = arrivalOf(record);
        record.updatedAt = timestamp;
      }
      await this.save();
      return true;
    });
  }

  async revokeById(id) {
    return this.#enqueue(async () => {
      await this.ready;
      const index = this.data.records.findIndex((item) => item.id === String(id || ""));
      if (index < 0) return null;
      const [removed] = this.data.records.splice(index, 1);
      await this.save();
      return publicRecord(removed);
    });
  }

  /**
   * @param {{ shadow?: object|null, authorize?: Function|null, boundary?: string }} [options]
   * P2 shadow seam plus the boundary the request is made on. When present, the exact
   * record is authorized between the lifecycle check and the body read, so a denial can
   * never be recorded after content was read and the row always names this document.
   * `boundary` defaults to the document read, so the folder routes name their own.
   */
  async resolve(id, { shadow = null, authorize = null, boundary } = {}) {
    return this.#enqueue(async () => {
      await this.ready;
      const index = this.data.records.findIndex((item) => item.id === String(id || ""));
      if (index < 0) return null;
      // A retired record is never re-observed: the old opaque id must not revive even if
      // the same path reappears (§5.1).
      const lifecycle = readLifecycle(this.data.records[index]);
      if (lifecycle !== PUBLISH_LIFECYCLE.ACTIVE && lifecycle !== PUBLISH_LIFECYCLE.UNKNOWN) return null;
      const vault = await resolveWebVault(this.data.records[index].vaultId);
      if (vault.id !== this.data.records[index].vaultId) return null;

      const { observation, plan } = await this.#observeRecord(vault, index);
      if (plan.changed && plan.transition) await this.save();
      if (!plan.ok || plan.action !== PUBLISH_ACTIONS.RESOLVE_SERVE) return null;

      // P3: the servable record is decided by the runtime, with the record itself as the
      // proof — never the publisher and never another file. Denied or unreadable = not found,
      // so the lifecycle answer and the authorization answer keep one family.
      const activeRecord = { ...this.data.records[index], active: true };
      if (typeof authorize === "function") {
        const request = publicationAuthorizationRequest({ id: activeRecord.id, boundary });
        const decision = request === null
          ? PUBLISH_LEGACY_VERDICTS.notFound
          : withPublicationRecord(activeRecord, () => authorize(request));
        observePublicationRead({ shadow, record: activeRecord, legacyDecision: decision, boundary });
        if (decision?.allowed !== true) return null;
      } else {
        // No decision authority injected (a direct in-process caller): the old answer is an
        // allow and nothing else decides.
        observePublicationRead({ shadow, record: activeRecord, legacyDecision: PUBLISH_LEGACY_VERDICTS.allowed, boundary });
      }

      // A folder record has no single note body: its index and its notes are served by the
      // folder routes, which walk the record's directory themselves (§5.2 already passed).
      if (this.data.records[index].kind === PUBLISH_RECORD_KINDS.FOLDER) {
        return { record: publicRecord(this.data.records[index]), note: null };
      }

      let note;
      try {
        note = await readWebNote(vault, this.data.records[index].path);
      } catch (error) {
        // The target vanished (or became unreadable) between observation and read: never
        // serve a stale body, fail closed and retire the record (§15 S08).
        if (error?.code === "ENOENT") {
          const fallback = planResolve({ record: this.data.records[index], observation: { exists: false, isMarkdown: false } });
          if (fallback.changed && fallback.transition) {
            this.#applyTransition(index, fallback.transition);
            await this.save();
          }
        }
        return null;
      }
      return { record: publicRecord(this.data.records[index]), note };
    });
  }

  // Admin view (`includeInactive: true`) keeps retired records visible so they can be
  // cleaned up (§9); the default is the active-only published candidate set.
  async list({ vaultIds, includeInactive = false } = {}) {
    return this.#enqueue(async () => {
      await this.ready;
      const allowed = vaultIds ? new Set(vaultIds.map(String)) : null;
      let changed = false;
      const out = [];
      for (let index = 0; index < this.data.records.length; index += 1) {
        const record = this.data.records[index];
        if (allowed && !allowed.has(record.vaultId)) continue;
        // An unresolvable Vault must not break the Admin listing (the record stays visible so
        // it can be cleaned up); it simply cannot be re-observed.
        let plan = null;
        try {
          const vault = await resolveWebVault(record.vaultId);
          if (vault.id === record.vaultId) ({ plan } = await this.#observeRecord(vault, index));
        } catch {
          plan = null;
        }
        if (plan?.changed && plan.transition) changed = true;
        const current = this.data.records[index];
        if (includeInactive || isPublishedCandidate(current)) out.push(publicRecord(current));
      }
      if (changed) await this.save();
      return out.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    });
  }

  listActive(options) {
    return this.list({ ...options, includeInactive: false });
  }
}

export const publishService = new PublishService();
