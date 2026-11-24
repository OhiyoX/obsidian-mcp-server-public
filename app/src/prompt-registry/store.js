// Durable, content-addressed Base packs plus one atomically switched active head.
//
// Layout under `packsDir` / beside `headFile`:
//   packs/<digest-hex>.json   immutable published pack {digest, values, sourceCommit, reason, at}
//   agent-prompts.json        active head: revision, base pointer, sparse overrides, history
//
// Rules this module owns:
//  * a candidate becomes visible only after its pack and head are both durable;
//  * a failed write leaves the previous head and the previous snapshot untouched;
//  * a corrupt head or missing pack never crashes startup: the server serves the
//    bundled Base and reports `degraded` with a reason code, and keeps the broken
//    file for repair instead of overwriting it.

import fs from "node:fs/promises";
import path from "node:path";
import { promptBaseDigest, validateBaseValues } from "./schema.js";
import { resolveEffective } from "./registry.js";

export const PROMPT_STORE_SCHEMA_VERSION = 1;
export const PROMPT_STORE_CODES = Object.freeze({
  STALE_REVISION: "PROMPT_STALE_REVISION",
  INVALID_PACK: "PROMPT_INVALID_PACK",
  UNKNOWN_REVISION: "PROMPT_UNKNOWN_REVISION",
  STALE_OVERRIDE: "PROMPT_STALE_OVERRIDE",
  OVERRIDE_MISMATCH: "PROMPT_OVERRIDE_MISMATCH",
  STORE_IO: "PROMPT_STORE_IO",
  ALREADY_CURRENT: "PROMPT_ALREADY_CURRENT",
});
const MAX_HISTORY = 32;
const HEAD_FILE_LIMIT = 256 * 1024;
// One ceiling for writing and reading a pack file: a publish the server reports as
// successful must still be readable after a restart. Text itself is capped at 1 MiB
// by the schema; the headroom is JSON keys and escaping.
export const PACK_FILE_LIMIT = 3 * 1024 * 1024;

const hexOf = (digest) => String(digest).replace(/^sha256:/, "");

/** A validated pack as the store accepts it: values plus their digest. */
export function validatePromptPack(pack, bundledBase) {
  if (pack === null || typeof pack !== "object" || typeof pack.values !== "object") {
    return { ok: false, code: PROMPT_STORE_CODES.INVALID_PACK, detail: "pack.values is required" };
  }
  const values = pack.values;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.trim() === "") {
      return { ok: false, code: PROMPT_STORE_CODES.INVALID_PACK, detail: `${key} is not text` };
    }
  }
  for (const key of Object.keys(bundledBase.values)) {
    if (!Object.hasOwn(values, key)) {
      return { ok: false, code: PROMPT_STORE_CODES.INVALID_PACK, detail: `pack is missing ${key}` };
    }
  }
  // A key this image does not have would never be rendered, and an override on it
  // would have no Base text to sit on: reject the pack instead of storing dead copy.
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(bundledBase.values, key)) {
      return { ok: false, code: PROMPT_STORE_CODES.INVALID_PACK, detail: `pack has unknown key ${key}` };
    }
  }
  const digest = promptBaseDigest(values);
  if (pack.digest !== undefined && pack.digest !== digest) {
    return { ok: false, code: PROMPT_STORE_CODES.INVALID_PACK, detail: "pack digest does not match its values" };
  }
  // The full text rules run here too, not only in the Admin route: a template with an
  // undeclared placeholder or an oversized value must never become the active Base,
  // whichever caller reaches this module.
  try {
    validateBaseValues({ manifest: bundledBase.manifest, values });
  } catch (error) {
    return { ok: false, code: PROMPT_STORE_CODES.INVALID_PACK, detail: String(error?.detail ?? error?.message ?? error) };
  }
  return { ok: true, values, digest };
}

export function createPromptRegistryStore({ headFile, packsDir, bundledBase, io = fs, clock = () => new Date().toISOString() } = {}) {
  if (typeof headFile !== "string" || typeof packsDir !== "string") throw new TypeError("headFile and packsDir are required");
  if (bundledBase === null || typeof bundledBase?.values !== "object") throw new TypeError("bundledBase is required");

  let status = "bootstrap";
  let reasonCode = undefined;
  let revision = 0;
  let baseRevision = 0;
  let runtimeRevision = 0;
  let baseDigest = bundledBase.digest;
  let values = bundledBase.values;
  let overrides = {};
  let tuning = {};
  let history = [];
  let sourceCommit;
  let tail = Promise.resolve();

  const packPath = (digest) => path.join(packsDir, `${hexOf(digest)}.json`);

  function snapshot() {
    // A read path must not repair what it reads: an override the Base cannot host is
    // simply left out of this answer (resolveEffective lists it as ignored).
    const typed = {};
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string" && value.trim() !== "") typed[key] = value;
    }
    return resolveEffective({
      basePack: { digest: baseDigest, values },
      overrides: typed,
      tuning,
      revision,
      baseRevision,
      runtimeRevision,
      status: status === "bootstrap" ? "ready" : status,
    });
  }

  function currentStatus() {
    const effective = snapshot();
    return Object.freeze({
      status,
      reasonCode,
      revision,
      baseRevision,
      runtimeRevision,
      baseDigest,
      bundledBaseDigest: bundledBase.digest,
      effectiveDigest: effective.effectiveDigest,
      // Count what is actually in force, not what is on disk: an override the Base
      // cannot host is reported in `ignoredOverrideKeys` instead of inflating this.
      overrideCount: effective.overrideCount,
      ignoredOverrideCount: effective.ignoredOverrideKeys.length,
      drift: status === "ready" && baseDigest !== bundledBase.digest,
      historyLength: history.length,
      sourceCommit,
    });
  }

  function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function atomicWrite(file, text, ioImpl = io) {
    await ioImpl.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await ioImpl.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await ioImpl.rename(temporary, file);
    // Directory fsync is best effort: some platforms refuse it, and the rename is
    // already atomic there. A failure must not turn a good publish into an error.
    try {
      const directory = await ioImpl.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // ignored on purpose
    }
  }

  async function load() {
    let raw;
    try {
      const stats = await io.stat(headFile);
      if (stats.size > HEAD_FILE_LIMIT) {
        status = "degraded";
        reasonCode = "head-oversize";
        return;
      }
      raw = await io.readFile(headFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        status = "bootstrap";
        return;
      }
      status = "degraded";
      reasonCode = "head-unreadable";
      return;
    }

    let head;
    try {
      head = JSON.parse(raw);
    } catch {
      status = "degraded";
      reasonCode = "head-invalid-json";
      return;
    }
    if (head === null || typeof head !== "object" || head.schemaVersion !== PROMPT_STORE_SCHEMA_VERSION) {
      status = "degraded";
      reasonCode = "head-unsupported";
      return;
    }
    revision = Number.isInteger(head.revision) ? head.revision : 0;
    baseRevision = Number.isInteger(head.base?.revision) ? head.base.revision : 0;
    runtimeRevision = Number.isInteger(head.runtime?.revision) ? head.runtime.revision : 0;
    overrides = head.runtime?.overrides && typeof head.runtime.overrides === "object" ? { ...head.runtime.overrides } : {};
    tuning = head.runtime?.tuning && typeof head.runtime.tuning === "object" ? { ...head.runtime.tuning } : {};
    history = Array.isArray(head.history) ? head.history.slice(-MAX_HISTORY) : [];
    sourceCommit = head.base?.sourceCommit;

    const digest = head.base?.packDigest;
    if (typeof digest !== "string") {
      status = "degraded";
      reasonCode = "head-without-pack";
      return;
    }
    let packRaw;
    try {
      const stats = await io.stat(packPath(digest));
      if (stats.size > PACK_FILE_LIMIT) {
        status = "degraded";
        reasonCode = "pack-oversize";
        baseDigest = bundledBase.digest;
        return;
      }
      packRaw = await io.readFile(packPath(digest), "utf8");
    } catch {
      status = "degraded";
      reasonCode = "pack-missing";
      baseDigest = bundledBase.digest;
      return;
    }
    let stored;
    try {
      stored = JSON.parse(packRaw);
    } catch {
      status = "degraded";
      reasonCode = "pack-invalid-json";
      baseDigest = bundledBase.digest;
      return;
    }
    const checked = validatePromptPack({ values: stored?.values, digest }, bundledBase);
    if (!checked.ok) {
      status = "degraded";
      reasonCode = checked.detail === "pack digest does not match its values" ? "pack-digest-mismatch" : "pack-incomplete";
      baseDigest = bundledBase.digest;
      return;
    }
    values = Object.freeze({ ...checked.values });
    baseDigest = digest;
    status = "ready";
    reasonCode = undefined;
  }

  function headDocument(next) {
    return `${JSON.stringify(
      {
        schemaVersion: PROMPT_STORE_SCHEMA_VERSION,
        revision: next.revision,
        base: { revision: next.baseRevision, packDigest: next.baseDigest, sourceCommit: next.sourceCommit },
        runtime: { revision: next.runtimeRevision, overrides: next.overrides, tuning: next.tuning },
        history: next.history,
      },
      null,
      2,
    )}\n`;
  }

  function appendHistory(entry) {
    return [...history, entry].slice(-MAX_HISTORY);
  }

  const ready = enqueue(load);

  async function commit({
    expectedRevision,
    pack,
    sourceCommit: commitRef,
    reason,
    kind = "base",
    resetOverriddenKeys = [],
    expectedOverrideValues = {},
    nextOverrides: suppliedOverrides = null,
    nextTuning: suppliedTuning = null,
    bumpRuntime = false,
  }) {
    if (!Number.isInteger(expectedRevision)) {
      return { ok: false, code: PROMPT_STORE_CODES.STALE_REVISION, current: revision };
    }
    if (expectedRevision !== revision) {
      return { ok: false, code: PROMPT_STORE_CODES.STALE_REVISION, current: revision };
    }
    const checked = validatePromptPack(pack, bundledBase);
    if (!checked.ok) return { ok: false, code: checked.code, detail: checked.detail, current: revision };

    // Resetting an override is only safe when the value being promoted is still the
    // value another admin sees: a concurrent change must lose, not be deleted.
    for (const [key, expected] of Object.entries(expectedOverrideValues)) {
      if (overrides[key] !== expected) {
        return { ok: false, code: PROMPT_STORE_CODES.STALE_OVERRIDE, current: revision, key };
      }
    }
    // A promoted override may only be dropped when the new Base already carries that
    // exact text: otherwise the reset would silently swap verified copy for unreviewed
    // text, which is the one outcome a promote flow must never produce.
    for (const key of resetOverriddenKeys) {
      // No override in force: nothing to drop, nothing to check.
      if (typeof overrides[key] !== "string") continue;
      if (checked.values[key] !== overrides[key]) {
        return { ok: false, code: PROMPT_STORE_CODES.OVERRIDE_MISMATCH, current: revision, key };
      }
    }
    const nextOverrides = suppliedOverrides === null ? { ...overrides } : { ...suppliedOverrides };
    for (const key of resetOverriddenKeys) delete nextOverrides[key];
    const nextTuning = suppliedTuning === null ? { ...tuning } : { ...suppliedTuning };
    const nextRevision = revision + 1;
    const entry = {
      revision: nextRevision,
      kind,
      packDigest: checked.digest,
      at: clock(),
      reason: reason ?? null,
      sourceCommit: commitRef ?? null,
      resetOverriddenKeys: [...resetOverriddenKeys],
      overrides: { ...nextOverrides },
      tuning: { ...nextTuning },
    };
    const nextHead = {
      revision: nextRevision,
      baseRevision: kind === "base" || kind === "rollback" || kind === "repair" ? nextRevision : baseRevision,
      runtimeRevision: bumpRuntime ? runtimeRevision + 1 : runtimeRevision,
      baseDigest: checked.digest,
      sourceCommit: commitRef ?? null,
      overrides: nextOverrides,
      tuning: nextTuning,
      history: appendHistory(entry),
    };

    const packDocument = `${JSON.stringify({ digest: checked.digest, values: checked.values, sourceCommit: commitRef ?? null, reason: reason ?? null, at: entry.at }, null, 2)}\n`;
    if (Buffer.byteLength(packDocument, "utf8") > PACK_FILE_LIMIT) {
      return { ok: false, code: PROMPT_STORE_CODES.INVALID_PACK, detail: "pack file over limit", current: revision };
    }

    try {
      await atomicWrite(packPath(checked.digest), packDocument);
      await atomicWrite(headFile, headDocument(nextHead));
    } catch {
      // Nothing visible changes: the old head and the old snapshot stay in force.
      return { ok: false, code: PROMPT_STORE_CODES.STORE_IO, current: revision };
    }

    values = Object.freeze({ ...checked.values });
    baseDigest = checked.digest;
    revision = nextRevision;
    baseRevision = nextHead.baseRevision;
    runtimeRevision = nextHead.runtimeRevision;
    overrides = nextOverrides;
    tuning = nextTuning;
    history = nextHead.history;
    sourceCommit = commitRef ?? undefined;
    status = "ready";
    reasonCode = undefined;
    return {
      ok: true,
      revision,
      baseDigest,
      digest: checked.digest,
      overriddenKeys: Object.keys(overrides),
      overrideCount: Object.keys(overrides).length,
      shadowedKeys: Object.keys(overrides),
    };
  }

  return Object.freeze({
    get ready() {
      return ready;
    },
    snapshot,
    status: currentStatus,
    history: () => Object.freeze(history.map((entry) => Object.freeze({ ...entry }))),
    drain: () => tail,
    commitBase: (input) => enqueue(() => commit({ ...input, kind: "base" })),
    /** Change only the sparse override map (and tunings); the Base pack stays. */
    commitOverrides: (input) =>
      enqueue(() =>
        commit({
          ...input,
          kind: "override",
          pack: { values, digest: baseDigest },
          bumpRuntime: true,
        }),
      ),
    async rollback({ expectedRevision, targetRevision, reason } = {}) {
      const entry = history.find((item) => item.revision === targetRevision);
      if (entry === undefined) return { ok: false, code: PROMPT_STORE_CODES.UNKNOWN_REVISION, current: revision };
      let pack;
      try {
        pack = JSON.parse(await io.readFile(packPath(entry.packDigest), "utf8"));
      } catch {
        return { ok: false, code: PROMPT_STORE_CODES.STORE_IO, current: revision };
      }
      // A rollback restores the whole effective head: Base pack plus the sparse
      // overrides and tunings that were active at that revision.
      return enqueue(() =>
        commit({
          expectedRevision,
          pack,
          reason,
          kind: "rollback",
          nextOverrides: entry.overrides ?? {},
          nextTuning: entry.tuning ?? {},
          bumpRuntime: true,
        }),
      );
    },
    async repair({ expectedRevision, recoveryPack = bundledBase, reason } = {}) {
      return enqueue(() => commit({ expectedRevision, pack: recoveryPack, reason, kind: "repair" }));
    },
  });
}
