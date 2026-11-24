// The effective prompt snapshot: one immutable answer per request to the question
// "what text does the server use right now?".
//
// Two layers only: a Runtime Override (empty by default) over the active Base pack.
// Nothing here reads files, the Vault or the network; the store owns durability and
// this module only combines values, so a request can never observe half a publish.

import { promptBaseDigest } from "./schema.js";

export const PROMPT_REGISTRY_STATUS = Object.freeze(["ready", "degraded", "bootstrap"]);

export class PromptRegistryError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "PromptRegistryError";
    this.code = code;
  }
}

function freezeValues(values) {
  return Object.freeze({ ...values });
}

/**
 * Combine a Base pack with sparse overrides into the frozen snapshot every MCP
 * request reads. `overrides` may only be non-empty for an authorized admin path.
 */
export function resolveEffective({
  basePack,
  overrides = {},
  revision = 0,
  baseRevision = 0,
  runtimeRevision = 0,
  tuning = {},
  status = "ready",
} = {}) {
  if (basePack === null || typeof basePack !== "object" || typeof basePack.values !== "object") {
    throw new TypeError("resolveEffective needs a base pack");
  }
  if (!PROMPT_REGISTRY_STATUS.includes(status)) throw new TypeError(`unknown status: ${String(status)}`);
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("overrides must be a plain object");
  }

  const values = { ...basePack.values };
  const sources = {};
  for (const key of Object.keys(values)) sources[key] = "base";
  const shadowedKeys = [];
  const ignoredOverrideKeys = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" || value.trim() === "") throw new TypeError(`override for ${key} must be text`);
    // A key the Base does not have covers nothing: drop it and say so. Publishing
    // rejects unknown keys, so this only happens after a hand edit or an older Base.
    if (!Object.hasOwn(values, key)) {
      ignoredOverrideKeys.push(key);
      continue;
    }
    values[key] = value;
    sources[key] = "override";
    shadowedKeys.push(key);
  }
  ignoredOverrideKeys.sort();
  shadowedKeys.sort();

  const effective = freezeValues(values);
  return Object.freeze({
    tuning: Object.freeze({ ...tuning }),
    status,
    revision,
    baseRevision,
    runtimeRevision,
    baseDigest: basePack.digest,
    effectiveDigest: promptBaseDigest(effective),
    values: effective,
    sources: Object.freeze(sources),
    overrides: freezeValues(
      Object.fromEntries(Object.entries(overrides).filter(([key]) => !ignoredOverrideKeys.includes(key))),
    ),
    overrideCount: shadowedKeys.length,
    ignoredOverrideKeys: Object.freeze(ignoredOverrideKeys),
    shadowedKeys: Object.freeze(shadowedKeys),
  });
}

/**
 * Read and write facade used by the MCP side and the admin service.
 * `snapshot()` is the only thing a request calls; it is synchronous by design.
 */
export function createPromptRegistry({ bundledBase, store, service = null }) {
  if (store === null || typeof store?.snapshot !== "function") throw new TypeError("a store is required");
  return Object.freeze({
    ready: store.ready,
    bundledBaseDigest: bundledBase?.digest ?? null,
    snapshot: () => store.snapshot(),
    status: () => store.status(),
    ...(service === null
      ? {}
      : {
          previewBase: (input) => service.previewBase(input),
          publishBase: (input) => service.publishBase(input),
          rollback: (input) => service.rollback(input),
          subscribe: (listener) => service.subscribe(listener),
        }),
  });
}
