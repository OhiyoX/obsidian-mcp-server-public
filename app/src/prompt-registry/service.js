// Admin-side prompt operations: preview, publish, rollback, repair.
//
// The store owns durability and the revision counter; this layer owns the rules an
// operator must satisfy (a reason, a truthful diff), the audit trail, and telling
// live MCP sessions that a new revision exists. A notification failure never rolls
// back a revision that is already durable, and never reports success for one that
// is not.

import { validatePromptPack, PROMPT_STORE_CODES } from "./store.js";
import { validateOverridePatch } from "./schema.js";
import { PromptRegistryError } from "./registry.js";

const REASON_LIMIT = 200;

function requireReason(reason) {
  if (typeof reason !== "string") throw new PromptRegistryError("REASON_REQUIRED", "a reason is required");
  const text = reason.trim();
  if (text === "") throw new PromptRegistryError("REASON_REQUIRED", "a reason is required");
  if (text.length > REASON_LIMIT) throw new PromptRegistryError("REASON_TOO_LONG", `at most ${REASON_LIMIT} characters`);
  return text;
}

function diffOf(baseValues, candidateValues) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const key of Object.keys(candidateValues)) {
    if (!Object.hasOwn(baseValues, key)) added.push(key);
    else if (baseValues[key] !== candidateValues[key]) changed.push(key);
  }
  for (const key of Object.keys(baseValues)) if (!Object.hasOwn(candidateValues, key)) removed.push(key);
  added.sort();
  changed.sort();
  removed.sort();
  return { added, changed, removed, changedKeys: [...added, ...changed, ...removed] };
}

export function createPromptAdminService({ store, bundledBase, audit = async () => {} } = {}) {
  if (store === null || typeof store?.commitBase !== "function") throw new TypeError("a store is required");
  if (bundledBase === null || typeof bundledBase?.values !== "object") throw new TypeError("bundledBase is required");

  const listeners = new Set();
  const notify = async (snapshot) => {
    const failures = [];
    for (const listener of listeners) {
      try {
        await listener(snapshot);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    // `notified` counts subscribers told (the fanout), not sessions: only the fanout
    // knows how many live connections exist.
    return { notified: listeners.size, failures };
  };

  async function record(entry) {
    try {
      await audit(entry);
    } catch {
      // Auditing must not turn a durable publish into a failure the caller sees as
      // "not published"; the store's history still holds the revision.
    }
  }

  return Object.freeze({
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async previewBase({ pack } = {}) {
      const checked = validatePromptPack(pack, bundledBase);
      if (!checked.ok) return Object.freeze({ valid: false, code: checked.code, detail: checked.detail });
      const snapshot = store.snapshot();
      const diff = diffOf(snapshot.values, checked.values);
      return Object.freeze({
        valid: true,
        candidateDigest: checked.digest,
        bytes: Buffer.byteLength(JSON.stringify(checked.values), "utf8"),
        diff,
        shadowedKeys: [...snapshot.shadowedKeys],
        currentRevision: snapshot.revision,
      });
    },

    /** Validate a sparse override patch without writing anything. */
    async previewOverride({ set = {}, removeKeys = [], tuning = {} } = {}) {
      const patch = validateOverridePatch({ patch: { set, removeKeys, tuning }, basePack: bundledBase });
      const snapshot = store.snapshot();
      const changed = [];
      for (const [key, value] of Object.entries(patch.set)) {
        if (snapshot.values[key] !== value) changed.push(key);
      }
      for (const key of patch.removeKeys) {
        if (snapshot.sources[key] === "override") changed.push(key);
      }
      return Object.freeze({
        valid: true,
        changedKeys: Object.freeze(changed),
        currentRevision: snapshot.revision,
        shadowedKeys: snapshot.shadowedKeys,
        overrideCount: snapshot.overrideCount,
      });
    },

    async publishOverride({ expectedRevision, set = {}, removeKeys = [], tuning = {}, reason } = {}) {
      const text = requireReason(reason);
      const patch = validateOverridePatch({ patch: { set, removeKeys, tuning }, basePack: bundledBase });
      const current = store.snapshot();
      const nextOverrides = { ...current.overrides };
      for (const [key, value] of Object.entries(patch.set)) nextOverrides[key] = value;
      for (const key of patch.removeKeys) delete nextOverrides[key];
      const nextTuning = { ...current.tuning, ...patch.tuning };

      const result = await store.commitOverrides({
        expectedRevision,
        nextOverrides,
        nextTuning,
        reason: text,
      });
      if (!result.ok) {
        await record({ action: "override.publish", outcome: "failed", code: result.code, expectedRevision });
        return result;
      }
      const delivery = await notify(store.snapshot());
      await record({
        action: "override.publish",
        outcome: "success",
        revision: result.revision,
        keys: patch.changedKeys,
        reason: text,
        notified: delivery.notified,
      });
      return {
        ...result,
        revision: result.revision,
        runtimeRevision: store.snapshot().runtimeRevision,
        overrideCount: result.overrideCount,
        shadowedKeys: result.shadowedKeys,
        notified: delivery.notified,
        notificationFailures: delivery.failures,
      };
    },

    async resetOverride({ expectedRevision, keys = [], tuning = {}, reason } = {}) {
      return this.publishOverride({ expectedRevision, set: {}, removeKeys: [...keys], tuning, reason });
    },

    async publishBase({ expectedRevision, pack, sourceCommit = null, reason, resetOverriddenKeys = [], expectedOverrideValues = {} } = {}) {
      const text = requireReason(reason);
      const checked = validatePromptPack(pack, bundledBase);
      if (!checked.ok) {
        await record({ action: "base.publish", outcome: "rejected", code: checked.code, expectedRevision });
        throw new PromptRegistryError(checked.code, checked.detail);
      }
      const result = await store.commitBase({
        expectedRevision,
        pack: checked,
        sourceCommit,
        reason: text,
        resetOverriddenKeys,
        expectedOverrideValues,
      });
      if (!result.ok) {
        await record({
          action: "base.publish",
          outcome: result.code === PROMPT_STORE_CODES.STALE_REVISION ? "stale" : "failed",
          code: result.code,
          expectedRevision,
          current: result.current,
          candidateDigest: checked.digest,
        });
        return result;
      }
      const snapshot = store.snapshot();
      const delivery = await notify(snapshot);
      await record({
        action: "base.publish",
        outcome: "success",
        revision: result.revision,
        digest: result.digest,
        sourceCommit,
        reason: text,
        resetOverriddenKeys,
        notified: delivery.notified,
        notificationFailures: delivery.failures.length,
      });
      return { ...result, notified: delivery.notified, notificationFailures: delivery.failures };
    },

    async rollback({ expectedRevision, targetRevision, reason } = {}) {
      const text = requireReason(reason);
      const result = await store.rollback({ expectedRevision, targetRevision, reason: text });
      if (!result.ok) {
        await record({ action: "base.rollback", outcome: "failed", code: result.code, targetRevision, expectedRevision });
        return result;
      }
      const delivery = await notify(store.snapshot());
      await record({
        action: "base.rollback",
        outcome: "success",
        revision: result.revision,
        targetRevision,
        digest: result.digest,
        reason: text,
        notified: delivery.notified,
      });
      return { ...result, notified: delivery.notified, notificationFailures: delivery.failures };
    },

    async adoptBundled({ expectedRevision, reason } = {}) {
      const text = requireReason(reason);
      const result = await store.commitBase({ expectedRevision, pack: bundledBase, sourceCommit: null, reason: text });
      if (!result.ok) {
        await record({ action: "base.adopt-bundled", outcome: "failed", code: result.code, expectedRevision });
        return result;
      }
      const delivery = await notify(store.snapshot());
      await record({ action: "base.adopt-bundled", outcome: "success", revision: result.revision, reason: text });
      return { ...result, notified: delivery.notified, notificationFailures: delivery.failures };
    },

    async repair({ expectedRevision, reason, recoveryPack = bundledBase } = {}) {
      const text = requireReason(reason);
      const result = await store.repair({ expectedRevision, recoveryPack, reason: text });
      if (!result.ok) {
        await record({ action: "base.repair", outcome: "failed", code: result.code, expectedRevision });
        return result;
      }
      const delivery = await notify(store.snapshot());
      await record({ action: "base.repair", outcome: "success", revision: result.revision, reason: text });
      return { ...result, notified: delivery.notified, notificationFailures: delivery.failures };
    },
  });
}
