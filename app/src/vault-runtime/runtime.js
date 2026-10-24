// B1 — canonical VaultRuntime factory (contract §5 "VaultRuntime", §5.3 "No ambient worker
// state", §43-5, §3.4 capability model, §10.2 per-runtime lock).
//
// This module is a *composition* seam, not a service:
//   * every runtime fact is an explicit parameter (A1 descriptor facts, the A7
//     `vaultDataPaths(...)` mapping, the B1 `createLocalFs` instance). It never imports
//     `config.js`, never reads `process.env`, never touches the filesystem and holds no
//     module-level mutable state (§43-5, SEC-MV07);
//   * it never consults the request AsyncLocalStorage: a runtime is built for a Vault, not
//     for "whatever request is current". Background workers must capture the runtime
//     explicitly (contract §5.3, MV-I04);
//   * it is synchronous. Creation performs no I/O, so importing the compatibility facade
//     stays side-effect free (a realpath here would add an import-time syscall);
//   * capabilities fail closed: a runtime created without an explicit capability map (and
//     without one on its descriptor) declares every `CAPABILITY_KEYS` entry unavailable
//     with a visible reason instead of guessing "available" (§3.4).
//
// Field names are the frozen seam that lanes B2 / B3 / B4 / B6 / C dock to; see
// `scratch/multi-vault/B1/B1.HANDOFF.md` for the literal contract.

import path from "node:path";
import { CAPABILITY_KEYS, unavailable } from "./descriptor.js";
import { createLocalFs } from "./local-fs.js";

export const RUNTIME_CAPABILITY_REASON =
  "capability wiring lands in Wave B/C; the B1 runtime factory declares it unavailable instead of guessing (contract §3.4)";

function fail(detail) {
  throw new Error(`vault-runtime/runtime: ${detail}`);
}

function describe(value) {
  return typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : Array.isArray(value) ? `array(${value.length})` : `${typeof value} ${String(value)}`;
}

/**
 * Fail-closed capability map: every `CAPABILITY_KEYS` entry is `{ available:false, reason }`.
 * Uses A1's `unavailable(reason)` so the entry shape stays single-sourced.
 */
export function defaultRuntimeCapabilities(reason = RUNTIME_CAPABILITY_REASON) {
  const capabilities = {};
  for (const key of CAPABILITY_KEYS) capabilities[key] = unavailable(reason);
  return Object.freeze(capabilities);
}

/**
 * Validate + freeze a capability map with A1's shape rules (contract §3.4). A1's
 * `createVaultDescriptor` already applies the same rule to descriptor capabilities;
 * this is the runtime-side path for a caller that injects capabilities directly. Any
 * missing, extra or malformed entry is an error — never a silent default.
 */
export function normalizeRuntimeCapabilities(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`capabilities must be an object keyed by CAPABILITY_KEYS, got ${describe(value)}`);
  const missing = CAPABILITY_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) fail(`capabilities must declare every key explicitly (contract §3.4); missing: ${missing.join(", ")}`);
  const unknown = Object.keys(value).filter((key) => !CAPABILITY_KEYS.includes(key));
  if (unknown.length > 0) fail(`unknown capability keys: ${unknown.join(", ")}`);
  const normalized = {};
  for (const key of CAPABILITY_KEYS) {
    const entry = value[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.available !== "boolean") {
      fail(`capability "${key}" must be {available:<boolean>} or {available:false, reason}, got ${describe(entry)}`);
    }
    const keys = Object.keys(entry).sort();
    const allowed = entry.available ? ["available"] : ["available", "reason"];
    if (keys.length !== allowed.length || keys.some((name, index) => name !== allowed[index])) {
      fail(`capability "${key}" must use exactly {${allowed.join(", ")}} for available:${entry.available}, got {${keys.join(", ")}}`);
    }
    normalized[key] = entry.available ? Object.freeze({ available: true }) : unavailable(entry.reason);
  }
  return Object.freeze(normalized);
}

/**
 * `createVaultRuntime({ descriptor, paths, dataRoot?, capabilities?, deps? })`
 *
 *   descriptor   — `{ id, root, primary, ... }`. Shape is validated here (non-empty id
 *                  without NUL, absolute root, boolean primary). The canonical Vault-ID
 *                  rule and canonical-root resolution stay A1/A2 policy: the primary
 *                  compatibility runtime must not refuse to boot because of an
 *                  env-derived id (contract §4.1, MV-I07).
 *   paths        — the A7 `vaultDataPaths(...)` result, passed through by identity (it is
 *                  already frozen by A7) and consumed by `localFs`.
 *   dataRoot     — protected data root for `getVaultHealth`; defaults to `paths.root`
 *                  (secondary) and is `null` for a primary runtime unless passed explicitly.
 *   capabilities — explicit capability map; defaults to the descriptor's map, else the
 *                  fail-closed `defaultRuntimeCapabilities()`.
 *   deps         — forwarded to `createLocalFs` (`requireRequestAuthor`, `trackGitMutation`).
 *
 * Returns a frozen `{ id, root, primary, descriptor, paths, localFs, capabilities }`.
 */
export function createVaultRuntime(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail(`createVaultRuntime expects an input object, got ${describe(input)}`);
  const descriptor = input.descriptor;
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    fail(`descriptor must be an object (A1 createVaultDescriptor or the primary compatibility descriptor), got ${describe(descriptor)}`);
  }
  if (typeof descriptor.id !== "string" || descriptor.id === "" || descriptor.id.includes("\0")) fail(`descriptor.id must be a non-empty string without a NUL byte, got ${describe(descriptor.id)}`);
  if (typeof descriptor.root !== "string" || descriptor.root === "" || !path.isAbsolute(descriptor.root)) fail(`descriptor.root must be an absolute path, got ${describe(descriptor.root)}`);
  if (typeof descriptor.primary !== "boolean") fail(`descriptor.primary must be passed explicitly as a boolean, got ${describe(descriptor.primary)}`);

  const paths = input.paths;
  if (paths === null || typeof paths !== "object" || Array.isArray(paths)) fail(`paths must be the A7 vaultDataPaths result, got ${describe(paths)}`);

  const dataRoot = input.dataRoot === undefined || input.dataRoot === null ? (paths.root ?? null) : input.dataRoot;
  const descriptorCapabilities = descriptor.capabilities === undefined || descriptor.capabilities === null ? null : descriptor.capabilities;
  const capabilities = input.capabilities !== undefined
    ? normalizeRuntimeCapabilities(input.capabilities)
    : descriptorCapabilities !== null ? normalizeRuntimeCapabilities(descriptorCapabilities) : defaultRuntimeCapabilities();

  const localFs = createLocalFs({ root: descriptor.root, dataPaths: paths, dataRoot, deps: input.deps });

  return Object.freeze({
    id: descriptor.id,
    root: descriptor.root,
    primary: descriptor.primary,
    descriptor: Object.freeze({ ...descriptor }),
    paths,
    localFs,
    capabilities,
  });
}
