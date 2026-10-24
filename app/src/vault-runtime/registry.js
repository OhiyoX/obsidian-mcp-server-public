// A2 — canonical VaultRegistry: pure discovery (contract §4 "Canonical VaultRegistry", §26 A2,
// §4.2 snapshot semantics, §4.3 bounded inventory, §41 performance/boundedness, §42 SEC-MV01/02/06).
//
// PURE DISCOVERY FOUNDATION — deliberately NOT wired to Web (B7) or MCP (C): every input is an
// explicit parameter; this module never imports `config.js`, never reads `process.env` and holds no
// module-level mutable state (§43-5, SEC-MV07). ID validation, canonical-root resolution and
// duplicate-root detection are delegated to A1 (§3.2), and no data file is touched: no mkdir, no
// write, no index, no Git — the only filesystem operations are read-only directory enumerations
// inside `prepare()`.
//
// Fail-closed policy: invalid input, an unreadable vaults root, a broken bound, a timeout or an
// authorization-alias root throws a structured `Error` with a stable `code`/`[CODE] ` prefix and the
// previously published snapshot stays untouched.
//
// Snapshot semantics (§4.2): ordinary lookups (`snapshot`/`list`/`get`/`describe`) never touch the
// filesystem. Only `prepare()` enumerates, and only `commit()` publishes; no timer, no watcher.

import fs from "node:fs/promises";
import path from "node:path";
import {
  CAPABILITY_KEYS,
  VAULT_ID_INVALID,
  VAULT_ROOT_UNRESOLVED,
  assertDistinctRoots,
  createVaultDescriptor,
  isValidVaultId,
  unavailable,
  validateVaultId,
} from "./descriptor.js";
import {
  MAX_ENTRIES_PER_PARENT, ROUND_BUDGET_MS, VAULT_REGISTRY_BOUND_EXCEEDED,
  VAULT_REGISTRY_INVENTORY_UNREADABLE, VAULT_REGISTRY_ROUND_TIMEOUT, collectEntries,
} from "./registry-scan.js";
import { admissionServingSets } from "./serving-gate.js";
import { createComposedCommit, publishComposedRecord, refuseComposed } from "./composed-commit.js";
import { buildStagedCommit } from "./registry-commit.js";
import { compareCodeUnit, describeSnapshot, emptySnapshot, freezeSkipRecord } from "./registry-snapshot.js";

// Stable error codes (exported so consumers/tests never match on prose).
export const VAULT_REGISTRY_CONFIG_INVALID = "VAULT_REGISTRY_CONFIG_INVALID";
// W2 (#437) §1/§4.1: bounded enumeration (per-parent cap + logical round deadline) is a cohesive
// unit in `./registry-scan.js`; its codes/limits are re-exported here so consumers keep one site.
export { MAX_ENTRIES_PER_PARENT, ROUND_BUDGET_MS, VAULT_REGISTRY_BOUND_EXCEEDED, VAULT_REGISTRY_INVENTORY_UNREADABLE, VAULT_REGISTRY_ROUND_TIMEOUT };

/**
 * Why a directory-like entry under `vaultsRoot` did not become a registered
 * Vault. Reported in `snapshot().skipped` for Admin/health (§4.2, §4.3).
 */
export const SKIP_REASONS = Object.freeze({
  HIDDEN: "hidden-entry",
  SYMLINK: "symlink-entry",
  NOT_DIRECTORY: "not-a-directory",
  INVALID_ID: "invalid-id",
  PRIMARY_ID: "primary-id",
  UNRESOLVED_ROOT: "unresolved-root",
// W2 (#437) contract §1/§4.1: a discovered directory that exists but is not admitted.
  // Reported, never served, never aliased to primary.
  NOT_ADMITTED: "not-admitted",
});

// Contract §4.3: "inventory 必须有 hard upper bound；建议 v1 最多 64 个 local
// Vault". `MAX_SUPPORTED_VAULTS` is the hard ceiling: a caller may lower the bound
// (tests/ops) but never raise it. Exceeding the *inventory* bound is a separate,
// fail-closed error (`VAULT_REGISTRY_BOUND_EXCEEDED`).
//
// Bounded reporting (§41): the skipped-entry detail list is capped so a hostile or broken vaults
// root cannot grow the snapshot without limit; the remainder is counted in
// `snapshot().skippedOverflow`.
export const MAX_SUPPORTED_VAULTS = 64;

// Bounded reporting (§41): the skipped-entry detail list is capped so a hostile
// or broken vaults root cannot grow the snapshot without limit; the remainder is
// counted in `snapshot().skippedOverflow`.
export const MAX_SKIPPED_REPORTED = 64;

/**
 * Default capability declaration for every Vault (contract §3.4: a capability is
 * a *runtime fact*, not an authorization). This lane wires nothing, so every
 * capability is honestly declared unavailable with a visible reason instead of
 * silently defaulting to "available". Wave B/C lanes inject the real per-vault
 * facts through `capabilitiesFor`; an injected factory must return every
 * `CAPABILITY_KEYS` entry or `createVaultDescriptor` rejects it (fail closed).
 */
export const DEFAULT_CAPABILITY_REASON =
  "capability wiring lands in Wave B/C; the A2 registry is pure discovery (contract §26 A2)";

export function defaultCapabilitiesFor() {
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) capabilities[key] = unavailable(DEFAULT_CAPABILITY_REASON);
  return capabilities;
}

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describeValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || value === "") {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `${label} must be a non-empty absolute path string, got ${describeValue(value)}`);
  }
  if (!path.isAbsolute(value)) {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `${label} must be absolute, got ${describeValue(value)}`);
  }
  if (value.includes("\0")) {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `${label} must not contain a NUL byte`);
  }
  return value;
}

/** Lexical containment (no syscall). Security containment is enforced at I/O time (SEC-MV01). */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const ALLOWED_OPTIONS = Object.freeze(["primaryRoot", "primaryId", "vaultsRoot", "maxVaults", "writable", "capabilitiesFor", "gate", "fsApi", "servingGate"]);

function normalizeConfig(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `createVaultRegistry expects an options object, got ${describeValue(options)}`);
  }
  const unknown = Object.keys(options).filter((key) => !ALLOWED_OPTIONS.includes(key));
  if (unknown.length > 0) {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `unknown registry option(s): ${unknown.join(", ")} (typo protection, no silent ignore)`);
  }

  const primaryRoot = requireAbsolutePath(options.primaryRoot, "primaryRoot");
  const primaryId = validateVaultId(options.primaryId === undefined ? "vault" : options.primaryId);

  const vaultsRoot = options.vaultsRoot === undefined || options.vaultsRoot === null ? null : requireAbsolutePath(options.vaultsRoot, "vaultsRoot");
  if (vaultsRoot !== null) {
    const resolvedVaultsRoot = path.resolve(vaultsRoot);
    const resolvedPrimaryRoot = path.resolve(primaryRoot);
    if (resolvedVaultsRoot === resolvedPrimaryRoot) {
      fail(
        VAULT_REGISTRY_CONFIG_INVALID,
        `vaultsRoot and primaryRoot must differ (both resolve to ${JSON.stringify(resolvedVaultsRoot)}); ` +
          "the primary Vault is registered from primaryRoot, never discovered as a child",
      );
    }
    if (isInside(resolvedVaultsRoot, resolvedPrimaryRoot)) {
      fail(
        VAULT_REGISTRY_CONFIG_INVALID,
        `vaultsRoot ${JSON.stringify(resolvedVaultsRoot)} must not live inside primaryRoot ` +
          `${JSON.stringify(resolvedPrimaryRoot)}: secondary Vault roots may not sit inside Vault content`,
      );
    }
  }

  const maxVaults = options.maxVaults === undefined ? MAX_SUPPORTED_VAULTS : options.maxVaults;
  if (!Number.isInteger(maxVaults) || maxVaults < 1 || maxVaults > MAX_SUPPORTED_VAULTS) {
    fail(
      VAULT_REGISTRY_CONFIG_INVALID,
      `maxVaults must be an integer in [1, ${MAX_SUPPORTED_VAULTS}] (contract §4.3 hard bound), got ${describeValue(maxVaults)}`,
    );
  }

  const writable = options.writable === undefined ? true : options.writable;
  if (typeof writable !== "boolean") {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `writable must be an explicit boolean, got ${describeValue(writable)}`);
  }

  const capabilitiesFor = options.capabilitiesFor === undefined ? defaultCapabilitiesFor : options.capabilitiesFor;
  if (typeof capabilitiesFor !== "function") {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `capabilitiesFor must be a function (vault) => capabilities, got ${describeValue(capabilitiesFor)}`);
  }

  const gate = options.gate === undefined || options.gate === null ? null : options.gate;
  if (gate !== null && typeof gate !== "function") fail(VAULT_REGISTRY_CONFIG_INVALID, `gate must be a function (descriptor) => decision, got ${describeValue(gate)}`);

  const fsApi = options.fsApi === undefined ? fs : options.fsApi;
  if (fsApi === null || typeof fsApi !== "object" || typeof fsApi.readdir !== "function") {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `fsApi must be an object exposing readdir(), got ${describeValue(fsApi)}`);
  }

  // W2 fix (#437 RETURN, item 1): the optional serving gate is the ONE authority for "may this id
  // serve content". The registry only *consults* it (and calls `refuse`/`publish` when present), so
  // a structural primary descriptor can remain while its service right is refused.
  const servingGate = options.servingGate === undefined || options.servingGate === null ? null : options.servingGate;
  if (servingGate !== null && !isServingGate(servingGate)) {
    fail(VAULT_REGISTRY_CONFIG_INVALID, `servingGate must expose isServable()/refusalFor(), got ${describeValue(servingGate)}`);
  }

  return { primaryRoot, primaryId, vaultsRoot, maxVaults, writable, capabilitiesFor, defaultGate: gate, fsApi, servingGate };
}

/** A serving gate is an object with `isServable(id)`/`refusalFor(id)`; the registry never constructs one. */
function isServingGate(value) {
  return value !== null && typeof value === "object" && typeof value.isServable === "function" && typeof value.refusalFor === "function";
}

/** Contract-strict shape of what `fsApi.readdir(path, {withFileTypes:true})` must return. */
function readEntries(entries, vaultsRoot) {
  if (!Array.isArray(entries)) {
    fail(VAULT_REGISTRY_INVENTORY_UNREADABLE, `fsApi.readdir(${JSON.stringify(vaultsRoot)}) must return an array of dirents, got ${describeValue(entries)}`);
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || typeof entry.isDirectory !== "function" || typeof entry.isSymbolicLink !== "function") {
      fail(VAULT_REGISTRY_INVENTORY_UNREADABLE, `fsApi.readdir(${JSON.stringify(vaultsRoot)}) returned a malformed dirent: ${describeValue(entry)}`);
    }
  }
  return [...entries].sort((left, right) => compareCodeUnit(left.name, right.name));
}

/**
 * Create a pure canonical VaultRegistry (§4).
 *
 * `createVaultRegistry({ primaryRoot, primaryId = "vault", vaultsRoot = null,
 * maxVaults = 64, writable = true, capabilitiesFor, fsApi })`
 *
 * All inputs are explicit (no `config.js`, no `process.env`; §43-5). The primary
 * Vault is ALWAYS registered from `primaryRoot` under `primaryId` and always
 * sorts first; a directory named `primaryId` under `vaultsRoot` is never
 * registered a second time (it is normally the very same primary root). When
 * `vaultsRoot` is `null` the registry is primary-only (Web parity: multi-Vault
 * management not configured).
 *
 * Returns a frozen registry object:
 *   - `prepare(options)` — async; builds candidate inventory + admission/identity projection,
 *                     WITHOUT publishing; bounded by `maxEntriesPerParent`/`deadlineAt`;
 *   - `commit(candidate)` — sync; the only publisher, refusing a candidate past its deadline;
 *   - `refresh(options)` — async, `prepare` + `commit` (the pre-W2 one-shot). `revision` is a
 *                     monotonic successful-commit counter, so a consumer detects a new inventory;
 *   - `snapshot()`/`list()`/`get(id)`/`describe()` — sync, no FS (see the header);
 *   - `composedCommit` — the ONE composed commit record (W2FIX5 R1) every consumer face reads.
 */
export function createVaultRegistry(options = {}) {
  const config = normalizeConfig(options);
  const { primaryRoot, primaryId, vaultsRoot, maxVaults, writable, capabilitiesFor, defaultGate, fsApi, servingGate } = config;

  let current = emptySnapshot(config);
  let refreshCount = 0;
  let commits = 0;

  // W2FIX5 (#437 W2FIX4 item A / R1): the ONE composed commit record. `committed()` is every outward
  // read; a publish replaces the WHOLE record in one assignment (never one face at a time), so no
  // synchronous consumer can pair a new descriptor with an old runtime. The holder is created here and
  // attached to the serving gate, so every caller of the canonical registry (and therefore
  // `createVaultRuntimeMap({ registry })`) is wired without a new composition option.
  const composed = createComposedCommit();
  if (servingGate !== null && typeof servingGate.attachComposed === "function") servingGate.attachComposed(composed);
  const committed = () => composed.current()?.snapshot ?? current;

  // The ONE service-right question (W2 fix, item 1). Without a gate the legacy pass-through holds.
  const servable = (id) => servingGate === null || servingGate.isServable(id);

  async function buildDescriptor({ id, root, primary }) {
    return createVaultDescriptor({
      id,
      name: id,
      root,
      primary,
      writable,
      capabilities: capabilitiesFor({ id, name: id, root, primary, writable }),
    });
  }

  /**
   * Read-only discovery of `vaultsRoot`'s DIRECT children (§4.2). Skipped per
   * SEC-MV01/§3.2: hidden entries, symlinks (a symlinked root could escape the
   * vaults root or alias another Vault), non-directories, invalid Vault IDs and
   * the reserved primary id.
   */
  async function discover(limits) {
    const candidates = [];
    const skipped = [];
    let skippedOverflow = 0;
    const record = (name, reason, code) => {
      if (skipped.length < MAX_SKIPPED_REPORTED) skipped.push({ name, reason, ...(code === undefined ? {} : { code }) });
      else skippedOverflow += 1;
    };

    if (vaultsRoot === null) return { candidates, skipped, skippedOverflow };

    const entries = await collectEntries({
      fsApi,
      directory: vaultsRoot,
      maxEntriesPerParent: limits.maxEntriesPerParent,
      deadlineAt: limits.deadlineAt,
      now: limits.now,
    });

    for (const entry of readEntries(entries, vaultsRoot)) {
      const name = entry.name;
      if (name.startsWith(".")) {
        record(name, SKIP_REASONS.HIDDEN);
        continue;
      }
      if (entry.isSymbolicLink()) {
        record(name, SKIP_REASONS.SYMLINK);
        continue;
      }
      if (!entry.isDirectory()) {
        record(name, SKIP_REASONS.NOT_DIRECTORY);
        continue;
      }
      if (!isValidVaultId(name)) {
        record(name, SKIP_REASONS.INVALID_ID, VAULT_ID_INVALID);
        continue;
      }
      if (name === primaryId) {
        record(name, SKIP_REASONS.PRIMARY_ID);
        continue;
      }
      candidates.push(name);
    }
    return { candidates, skipped, skippedOverflow };
  }

  /**
   * W2 (#437) contract §4 step ①②: build a candidate inventory + admission/identity projection and
   * **publish nothing**; `commit(candidate)` is the only publisher, so a caller can order
   * "prepare runtime → persist the authoritative record → publish".
   *
   * `options.gate(descriptor)` is the optional async admission seam; it returns
   * `{ admitted, admission, status, reason, code, identity }`. A non-primary descriptor is kept in
   * the candidate only when `admitted === true`; a rejected one becomes a `not-admitted` skip and is
   * never aliased to the primary. The primary is a structural process fact (its root comes from
   * configuration), so it always stays in the snapshot while its *admission decision* is still
   * reported through `snapshot().admissions` (see the W2 handoff "W3 interface"). Bounded discovery
   * grading is delegated to `./registry-scan.js`; a breach aborts the whole prepare.
   */
  async function prepare(options = {}) {
    const gate = options.gate ?? defaultGate ?? null;
    if (gate !== null && typeof gate !== "function") fail(VAULT_REGISTRY_CONFIG_INVALID, `gate must be a function (descriptor) => decision, got ${describeValue(gate)}`);
    const maxEntriesPerParent = options.maxEntriesPerParent === undefined ? MAX_ENTRIES_PER_PARENT : options.maxEntriesPerParent;
    const now = typeof options.now === "function" ? options.now : Date.now;
    const deadlineAt = options.deadlineAt === undefined || options.deadlineAt === null ? null : options.deadlineAt;
    const startedAt = now();
    const limits = { maxEntriesPerParent, deadlineAt, now };

    const primary = await buildDescriptor({ id: primaryId, root: primaryRoot, primary: true });
    const discovered = await discover(limits);

    // §4.3 hard bound, checked BEFORE resolving any candidate (bounded work,
    // §41) and before publishing anything — a failure leaves the previous
    // snapshot intact. Never truncate silently.
    const discoveredTotal = 1 + discovered.candidates.length;
    if (discoveredTotal > maxVaults) {
      fail(VAULT_REGISTRY_BOUND_EXCEEDED, `vault registry would hold ${discoveredTotal} Vaults (primary + ${discovered.candidates.length} discovered) but maxVaults is ${maxVaults}: refusing to truncate the inventory (contract §4.3)`);
    }

    const secondaries = [];
    const skipped = [...discovered.skipped];
    let skippedOverflow = discovered.skippedOverflow;
    for (const name of discovered.candidates) {
      try {
        secondaries.push(await buildDescriptor({ id: name, root: path.join(vaultsRoot, name), primary: false }));
      } catch (error) {
        // Only an unresolvable real path (the directory was removed or became unreadable between
        // readdir and realpath) is an inventory anomaly: such a candidate is NOT registered and NOT
        // silently replaced by a synthetic canonical root (that would weaken SEC-MV02/SEC-MV01). The
        // anomaly stays visible via `describe().skipped`, and a request for that Vault later fails
        // closed ("unknown Vault") instead of falling back to primary (SEC-MV06). Every other
        // descriptor error (e.g. a broken `capabilitiesFor` shape) is a configuration bug: abort the
        // whole refresh loudly rather than filing it as an anomaly and dropping the Vault.
        if (error?.code !== VAULT_ROOT_UNRESOLVED) throw error;
        if (skipped.length < MAX_SKIPPED_REPORTED) {
          skipped.push({ name, reason: SKIP_REASONS.UNRESOLVED_ROOT, code: error?.code || VAULT_ROOT_UNRESOLVED });
        } else {
          skippedOverflow += 1;
        }
      }
    }

    const admissions = {}; const identities = {}; const vaults = [];
    for (const descriptor of [primary, ...secondaries]) {
      if (gate === null) {
        vaults.push(descriptor);
        continue;
      }
      let decision;
      try {
        decision = await gate(descriptor);
      } catch (error) {
        // A gate that throws is a per-Vault admission failure, not a global abort: the Vault is
        // isolated as `error` and every other Vault still gets its decision (contract §4 "失败隔离").
        decision = { admitted: false, status: "error", reason: error?.code || "admission-gate-failed", code: error?.code ?? null };
      }
      if (decision === null || typeof decision !== "object" || typeof decision.admitted !== "boolean") {
        fail(VAULT_REGISTRY_CONFIG_INVALID, `prepare gate returned a malformed decision for ${JSON.stringify(descriptor.id)}: ${describeValue(decision)}`);
      }
      admissions[descriptor.id] = Object.freeze({
        admitted: decision.admitted === true,
        admission: decision.admission ?? null,
        status: decision.status ?? (decision.admitted ? "ready" : "unavailable"),
        reason: decision.reason ?? null,
        code: decision.code ?? null,
        // W2FIX3 item 4: the authorization generation/identity travel with the committed snapshot.
        generation: Number.isInteger(decision.generation) ? decision.generation : null,
        identityVersion: decision.identity?.identityVersion ?? null,
        identityDigest: decision.identity?.digest ?? null,
      });
      identities[descriptor.id] = decision.identity ?? null;
      if (descriptor.primary || decision.admitted === true) {
        vaults.push(descriptor);
      } else if (skipped.length < MAX_SKIPPED_REPORTED) {
        skipped.push({ name: descriptor.id, reason: SKIP_REASONS.NOT_ADMITTED, code: decision.code ?? null });
      } else {
        skippedOverflow += 1;
      }
    }

    assertDistinctRoots(vaults); // SEC-MV02, delegated to A1

    skipped.sort((left, right) => compareCodeUnit(left.name, right.name) || compareCodeUnit(left.reason, right.reason));
    const revision = Math.max(refreshCount, committed().revision) + 1;
    const snapshot = Object.freeze({
      ready: true,
      revision,
      primaryId,
      vaultsRoot,
      maxVaults,
      vaults: Object.freeze(vaults),
      admissions: Object.freeze(admissions),
      identities: Object.freeze(identities),
      skipped: Object.freeze(skipped.map(freezeSkipRecord)),
      skippedOverflow,
      preparedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(0, now() - startedAt),
    });
    return Object.freeze({ snapshot, deadlineAt, now });
  }

  function commit(candidate, options = {}) {
    const staged = stageCommit(candidate, options);
    if (options.staged === true) return staged;
    applyStaged(staged);
    return committed();
  }

  function stageCommit(candidate, options = {}) {
    return buildStagedCommit({ candidate, options, current: committed(), codes: { config: VAULT_REGISTRY_CONFIG_INVALID, timeout: VAULT_REGISTRY_ROUND_TIMEOUT }, describeValue, fail });
  }

  /** Standalone publish; an attached registry must use complete reconciliation. */
  function applyStaged(staged) {
    if (composed.runtimeOwner() !== null) refuseComposed("attached registry must publish through its runtime owner/reconciliation");
    if (staged === null || typeof staged !== "object" || staged.snapshot === undefined) {
      fail(VAULT_REGISTRY_CONFIG_INVALID, "applyStaged expects a record returned by stageCommit()");
    }
    current = staged.snapshot;
    refreshCount = staged.snapshot.revision;
    commits = (composed.current()?.commits ?? commits) + (staged.revert === true ? -1 : 1);
    const defer = staged.deferServing === true;
    const sets = defer ? null : staged.serving ?? admissionServingSets(current.admissions);
    if (composed.current() === null) {
      if (!defer && servingGate !== null && typeof servingGate.publish === "function") servingGate.publish(sets.allowed ?? [], sets.refusals ?? null);
    } else {
      const extra = { snapshot: current, revision: current.revision, commits };
      if (sets !== null) extra.serving = sets;
      publishComposedRecord(composed, extra);
    }
    return committed();
  }
  /** Back-compat one-shot: prepare + commit. `staged` may also be an undo record (W2FIX4 item A). */
  async function refresh(options = {}) {
    if (composed.runtimeOwner() !== null) {
      if (servingGate?.armed()) refuseComposed("managed refresh requires unified reconciliation");
      await composed.runtimeOwner().refresh(options);
      return committed();
    }
    return commit(await prepare(options));
  }

  return Object.freeze({
    primaryId,
    vaultsRoot,
    maxVaults,
    writable,
    prepare,
    commit,
    stageCommit,
    applyStaged,
    refresh,
    servingGate,
    composedCommit: composed,
    snapshot: () => committed(),
    admission: (vaultId) => (typeof vaultId === "string" ? committed().admissions[vaultId] ?? null : null),
    // Structural description (primary is always present) — NOT a service grant (item 1).
    structuralList: () => committed().vaults,
    structural: (vaultId) => (typeof vaultId === "string" ? committed().vaults.find((vault) => vault.id === vaultId) : undefined),
    // Servable views: the only sets a content consumer may use.
    list: () => (servingGate === null ? committed().vaults : Object.freeze(committed().vaults.filter((vault) => servingGate.isServable(vault.id)))),
    get: (vaultId) => (typeof vaultId === "string" && servable(vaultId) ? committed().vaults.find((vault) => vault.id === vaultId) : undefined),
    servable,
    refusal: (vaultId) => (servingGate === null || typeof vaultId !== "string" ? null : servingGate.refusalFor(vaultId)),
    refuse: (vaultId, refusal) => { if (servingGate !== null && typeof servingGate.refuse === "function") servingGate.refuse(vaultId, refusal); },
    setServedIds: (allowedIds, refusals) => { if (servingGate !== null && typeof servingGate.publish === "function") servingGate.publish(allowedIds ?? [], refusals ?? null); },
    commits: () => composed.current()?.commits ?? commits,
    describe: () => describeSnapshot(committed()),
  });
}
