// Task 4 — the constraint admin service (design §6.5, §6.8, §6.9).
//
// One writer over the durable document. Every write reads the committed snapshot,
// refuses when it is not ready, builds `revision + 1` and hands the candidate to the
// store's CAS: a stale revision is refused as a retry, never merged, never
// last-write-wins (§6.5). `subjects` are not this service's to own (§6.8) — it copies
// the committed ones through untouched, so no constraint write can move a ceiling.
// Audit follows a successful replace and is swallowed there: a broken sink must not
// fail a write that already reached the disk (§6.9).
//
// One store per file per process. The never-last-write-wins guarantee is the store's
// single in-memory queue, and `snapshot()` is read outside that queue: a second store
// instance over the same file would accept the same revision twice. So this service must
// be built on the store the server itself exposes (`authorizationDocument.store`), never
// on an instance of its own.
//
// The document is validated once here and once in the store. The copy here is what
// still carries the schema's `path`, which is what an editor needs to mark the field.

import { randomUUID } from "node:crypto";

import { AUTHORIZATION_CODES, validateAuthorizationDocument } from "./schema.js";
import { AUTHORIZATION_STORE_CODES } from "./store.js";

const { INVALID_DOCUMENT, STATE_UNAVAILABLE } = AUTHORIZATION_CODES;
const { STALE_REVISION } = AUTHORIZATION_STORE_CODES;

/** The codes the schema and the store do not own: both come from the plan's Task 4. */
export const CONSTRAINT_ADMIN_CODES = Object.freeze({
  UNKNOWN_VAULT: "unknown_vault",
  CONSTRAINT_NOT_FOUND: "constraint_not_found",
});

const { UNKNOWN_VAULT, CONSTRAINT_NOT_FOUND } = CONSTRAINT_ADMIN_CODES;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refuse(code, path) {
  return Object.assign(new Error(`${code} at ${path || "document"}`), { code, path });
}

/** Admitted Vault ids as a set; a registry callback is re-read on every write. */
function admittedVaults(source) {
  return new Set((typeof source === "function" ? source() : source) ?? []);
}

/** The window half of a constraint: the only part of it an audit record carries. */
function windowOf(constraint) {
  return constraint === null ? null : { label: constraint.label, enabled: constraint.enabled, schedule: constraint.schedule };
}

/**
 * `constraintFromDraft(draft, {id, now, vaultIds, enabled, createdAt})` → one constraint.
 *
 * `vaultIds: null` is every Vault and becomes `targets: null`; an array becomes one
 * `vault` target each, and a Vault that is not admitted is refused here rather than
 * stored as a constraint that can never match (design §6.3, plan case 3).
 */
export function constraintFromDraft(draft, { id, now, vaultIds = [], enabled, createdAt } = {}) {
  if (!isRecord(draft)) throw refuse(INVALID_DOCUMENT, "");
  const scope = draft.vaultIds;
  if (scope !== null && !Array.isArray(scope)) throw refuse(INVALID_DOCUMENT, "vaultIds");
  if (scope !== null) {
    const admitted = admittedVaults(vaultIds);
    scope.forEach((vaultId, index) => {
      if (!admitted.has(vaultId)) throw refuse(UNKNOWN_VAULT, `vaultIds[${index}]`);
    });
  }
  const stamp = typeof now === "function" ? now() : now;
  return {
    id,
    label: draft.label,
    enabled: enabled ?? true,
    subjects: draft.subjects,
    mode: draft.mode,
    selector: {
      anyOf: [{
        surfaces: draft.surfaces ?? null,
        capabilities: draft.capabilities ?? null,
        targets: scope === null ? null : scope.map((vaultId) => ({ kind: "vault", vaultId })),
      }],
    },
    schedule: draft.schedule,
    createdAt: createdAt ?? stamp,
    updatedAt: stamp,
  };
}

/**
 * `createConstraintAdmin({store, audit, now, newId, vaultIds})` → `{list, create, update,
 * toggle, remove, setTemporalPlane}`. Refusals are `{ok:false, code, path}`; the store's
 * own codes pass through unchanged. `audit(record)` receives one record per successful
 * write: `{action, constraintId, before, after, revision}`, windows only, plus
 * `durabilityUncertain: true` when the write's directory flush failed. A sink may return a
 * promise; a rejection is swallowed like a throw.
 *
 * `vaultIds` is either an array, captured at construction, or a function, re-read on every
 * write — pass the live Vault registry as a function. An existing constraint whose Vault is
 * no longer admitted cannot be updated, only deleted (design §6.3), so a page must offer
 * delete for it.
 */
export function createConstraintAdmin({
  store,
  audit = null,
  now = () => new Date().toISOString(),
  newId = () => randomUUID(),
  vaultIds = [],
} = {}) {
  if (!store || typeof store.snapshot !== "function" || typeof store.replace !== "function") {
    throw new TypeError("the constraint admin needs a store with snapshot() and replace()");
  }

  async function auditAfter(event, revision) {
    if (audit === null) return;
    try {
      await audit({ ...event, revision });
    } catch {
      // Design §6.9: a sink failure is counted by the sink, never by the writer.
    }
  }

  async function commit(expectedRevision, build) {
    const snapshot = store.snapshot();
    if (snapshot.status !== "ready") return { ok: false, code: STATE_UNAVAILABLE, path: null };
    if (!Number.isInteger(expectedRevision) || expectedRevision !== snapshot.revision) {
      return { ok: false, code: STALE_REVISION, path: null };
    }
    let built;
    try {
      built = build(snapshot.document);
      built.document = validateAuthorizationDocument({ ...built.document, revision: snapshot.revision + 1 });
      // The audit records the window the schema saved, not the draft it was built from.
      if (built.event.constraintId !== null && built.event.after !== null) {
        const saved = built.document.constraints.find((constraint) => constraint.id === built.event.constraintId);
        if (saved !== undefined) built.event = { ...built.event, after: windowOf(saved) };
      }
    } catch (error) {
      // A coded refusal is the caller's; anything else is a bug and must stay loud.
      if (typeof error?.code !== "string") throw error;
      return { ok: false, code: error.code, path: error.path ?? null };
    }
    const written = await store.replace(expectedRevision, built.document);
    if (!written.ok) return { ok: false, code: written.code, path: null };
    // A rename whose directory flush failed may be lost by a crash. The disk is ahead of
    // memory, so the write stands; the caller and the audit record must still see the doubt.
    const uncertain = written.durabilityUncertain === true;
    await auditAfter(uncertain ? { ...built.event, durabilityUncertain: true } : built.event, written.revision);
    return uncertain
      ? { ok: true, revision: written.revision, durabilityUncertain: true }
      : { ok: true, revision: written.revision };
  }

  function list() {
    const snapshot = store.snapshot();
    if (snapshot.status !== "ready") {
      return { revision: null, code: snapshot.code ?? null, timeConstraintsEnabled: null, constraints: [] };
    }
    return {
      revision: snapshot.revision,
      timeConstraintsEnabled: snapshot.document.timeConstraintsEnabled,
      constraints: snapshot.document.constraints,
    };
  }

  async function create({ expectedRevision, draft } = {}) {
    const id = newId();
    const result = await commit(expectedRevision, (document) => {
      const constraint = constraintFromDraft(draft, { id, now, vaultIds });
      return {
        document: { ...document, constraints: [...document.constraints, constraint] },
        event: { action: "created", constraintId: id, before: null, after: windowOf(constraint) },
      };
    });
    return result.ok ? { ...result, id } : result;
  }

  async function update({ expectedRevision, id, draft } = {}) {
    return commit(expectedRevision, (document) => {
      const before = document.constraints.find((constraint) => constraint.id === id) ?? null;
      if (before === null) throw refuse(CONSTRAINT_NOT_FOUND, "id");
      const constraint = constraintFromDraft(draft, {
        id, now, vaultIds, enabled: before.enabled, createdAt: before.createdAt,
      });
      return {
        document: {
          ...document,
          constraints: document.constraints.map((item) => (item.id === id ? constraint : item)),
        },
        event: { action: "updated", constraintId: id, before: windowOf(before), after: windowOf(constraint) },
      };
    });
  }

  async function toggle({ expectedRevision, id, enabled } = {}) {
    return commit(expectedRevision, (document) => {
      const before = document.constraints.find((constraint) => constraint.id === id) ?? null;
      if (before === null) throw refuse(CONSTRAINT_NOT_FOUND, "id");
      const after = { ...before, enabled, updatedAt: now() };
      return {
        document: {
          ...document,
          constraints: document.constraints.map((item) => (item.id === id ? after : item)),
        },
        event: { action: "toggled", constraintId: id, before: windowOf(before), after: windowOf(after) },
      };
    });
  }

  async function remove({ expectedRevision, id } = {}) {
    return commit(expectedRevision, (document) => {
      const before = document.constraints.find((constraint) => constraint.id === id) ?? null;
      if (before === null) throw refuse(CONSTRAINT_NOT_FOUND, "id");
      return {
        document: { ...document, constraints: document.constraints.filter((item) => item.id !== id) },
        event: { action: "deleted", constraintId: id, before: windowOf(before), after: null },
      };
    });
  }

  async function setTemporalPlane({ expectedRevision, enabled } = {}) {
    return commit(expectedRevision, (document) => ({
      document: { ...document, timeConstraintsEnabled: enabled },
      event: {
        action: "plane_changed",
        constraintId: null,
        before: { timeConstraintsEnabled: document.timeConstraintsEnabled },
        after: { timeConstraintsEnabled: enabled },
      },
    }));
  }

  return Object.freeze({ list, create, update, toggle, remove, setTemporalPlane });
}
