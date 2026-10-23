// W2 (#437) — canonical Vault identity, contract §3 (identity / generation).
//
// Authority: `_Workspace/40-Projects/obsidian_mcp_server/Architecture/DEVELOPMENT - Vault 热发现与准入（Issue 437）.md`
//   §3    identity 规格（identityVersion / 规范化 realpath / 卷+文件标识 / 结构化元组编码后哈希 /
//         大整数十进制定长字符串）；identity 无法可靠确认时保持不可用，**不得**退化为路径相等
//   §3.1  身份绑定持久化：旧绑定不得被新目录覆盖
//   §41  boundedness / no ambient state
//   §43-5  a new Vault-dependent module must not import the global path constants
//
// This module calculates identity and reads realpath/stat plus the bounded incarnation proof:
//   - every input is an explicit parameter (`root`, `fsApi`, `platform`); no `config.js`, no
//     `process.env`, no module-level mutable state;
//   - it never writes, never caches and never publishes; the caller decides policy (a Vault whose
//     identity cannot be confirmed stays `unavailable`, it is never admitted by path equality).
//
// Encoding decision (contract §3 "不得直接拼接字符串"):
//   v2 digest = sha256 over `[2, canonicalRoot, volumeId, fileId, incarnation]`.
//   v1 four-field decoding only preserves historical bindings; the managed gate refuses v1.
//   JSON makes the tuple unambiguous (no delimiter collision: `["/a","1","23"]` and `["/a1","2","3"]`
//   differ), and every integer is a **decimal string**, which is what keeps a 64-bit Windows
//   `FileIndex` / `VolumeSerialNumber` from losing precision through a JS `Number`.
//
// Platform normalization (contract §3 "平台规范化（大小写、分隔符、UNC/驱动器大小写按平台规则统一）"):
//   separators are normalized to `/` and, on `win32`, the whole path is lower-cased — a drive letter
//   or UNC host case change is not a different Vault. Windows-only case folding matches the Web
//   write-lock precedent (`src/app/vault-registry.js#webNoteWriteLockKey`).

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { readIncarnation, readIncarnationSync } from "./incarnation.js";

/** Stable machine-readable failure codes; consumers/tests never match on prose. */
export const IDENTITY_UNRESOLVED = "VAULT_IDENTITY_UNRESOLVED";
export const IDENTITY_INVALID = "VAULT_IDENTITY_INVALID";

/** Identity record format version (contract §3: increments when the encoded format changes). */
export const IDENTITY_VERSION = 2;

function fail(code, detail) {
  throw Object.assign(new Error(`[${code}] ${detail}`), { code });
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return `${typeof value} ${String(value)}`;
}

/**
 * Platform normalization of a real path (contract §3). Exported so tests/persistence can compare a
 * stored `canonicalRoot` with a fresh one without re-deriving the rule.
 */
export function normalizeCanonicalRoot(value, platform = process.platform) {
  if (typeof value !== "string" || value === "") {
    fail(IDENTITY_INVALID, `canonical root must be a non-empty string, got ${describe(value)}`);
  }
  // Collapse `\` to `/`, drop a trailing separator (but keep a bare root such as `C:/`).
  let normalized = value.replace(/\\/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  if (normalized === "") normalized = "/";
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Decimal string for a device/file id. `bigint` input is required to preserve 64-bit ids. */
function decimalId(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) fail(IDENTITY_INVALID, `${label} must not be negative, got ${value.toString()}`);
    return value.toString(10);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  fail(IDENTITY_INVALID, `${label} must be a non-negative integer (use fs.stat(..., { bigint: true })), got ${describe(value)}`);
}

/** A decimal id must arrive as a string (or bigint) so a 64-bit id can never lose precision. */
function requireDecimalId(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) fail(IDENTITY_INVALID, `${label} must not be negative, got ${value.toString()}`);
    return value.toString(10);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(IDENTITY_INVALID, `${label} must be a decimal string (or bigint) — never a JS number, got ${describe(value)}`);
  }
  return value;
}

/**
 * Canonical, unambiguous tuple encoding (contract §3). Exported for tests and for a future format
 * migration; the digest is the only field consumers compare.
 */
export function encodeIdentityTuple({ identityVersion = 1, canonicalRoot, volumeId, fileId, incarnation }) {
  if (![1, IDENTITY_VERSION].includes(identityVersion)) {
    fail(IDENTITY_INVALID, `unsupported identityVersion ${describe(identityVersion)}`);
  }
  if (typeof canonicalRoot !== "string" || canonicalRoot === "") {
    fail(IDENTITY_INVALID, `canonicalRoot must be a non-empty string, got ${describe(canonicalRoot)}`);
  }
  const tuple = [identityVersion, canonicalRoot, requireDecimalId(volumeId, "volumeId"), requireDecimalId(fileId, "fileId")];
  if (identityVersion === 2) {
    if (typeof incarnation !== "string" || !/^[0-9a-f]{64}$/.test(incarnation)) fail(IDENTITY_INVALID, "v2 requires an incarnation proof");
    tuple.push(incarnation);
  }
  return JSON.stringify(tuple);
}

/** `sha256:<hex>` over the canonical tuple (contract §3 "结构化元组编码后哈希"). */
export function computeIdentityDigest(parts) {
  return `sha256:${createHash("sha256").update(encodeIdentityTuple(parts), "utf8").digest("hex")}`;
}

/** Shape + self-consistency check for a persisted identity record (fail closed, never coerced). */
export function isVaultIdentity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (![1, IDENTITY_VERSION].includes(value.identityVersion)) return false;
  if (typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.digest)) return false;
  if (typeof value.canonicalRoot !== "string" || value.canonicalRoot === "") return false;
  if (typeof value.volumeId !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.volumeId)) return false;
  if (typeof value.fileId !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.fileId)) return false;
  try {
    return computeIdentityDigest(value) === value.digest;
  } catch {
    return false;
  }
}

/** Throw `IDENTITY_INVALID` unless `value` is a shape-valid, self-consistent identity record. */
export function assertVaultIdentity(value, label = "identity") {
  if (!isVaultIdentity(value)) {
    fail(IDENTITY_INVALID, `${label} is not a valid v${IDENTITY_VERSION} Vault identity record: ${describe(value)}`);
  }
  return value;
}

/**
 * Resolve the process-independent identity of an existing directory.
 *
 * `resolveVaultIdentity({ root, fsApi = fs, platform = process.platform })` →
 * `{ identityVersion, digest, canonicalRoot, volumeId, fileId }` (frozen).
 *
 * Failure policy (contract §3): an unresolvable real path, an unreadable `stat`, a non-directory or
 * an unusable (`0`) device/file id throws `VAULT_IDENTITY_UNRESOLVED`. The caller MUST keep that
 * Vault `unavailable`; falling back to "the paths are equal" is explicitly forbidden.
 *
 * `fs.stat` is called with `{ bigint: true }` on purpose: on Windows Node reports `ino` as the NTFS
 * `FileIndex` and `dev` as the `VolumeSerialNumber`, and only the bigint form preserves all 64 bits.
 */
export async function resolveVaultIdentity({ root, fsApi = fs, platform = process.platform } = {}) {
  if (typeof root !== "string" || root === "") {
    fail(IDENTITY_INVALID, `root must be a non-empty path string, got ${describe(root)}`);
  }
  if (fsApi === null || typeof fsApi !== "object" || typeof fsApi.realpath !== "function" || typeof fsApi.stat !== "function") {
    fail(IDENTITY_INVALID, `fsApi must expose realpath() and stat(), got ${describe(fsApi)}`);
  }

  let real;
  try {
    real = await fsApi.realpath(root);
  } catch (error) {
    fail(IDENTITY_UNRESOLVED, `cannot resolve the real path of ${JSON.stringify(root)}: ${error?.code || error?.message || "unknown error"}`);
  }
  const canonicalRoot = normalizeCanonicalRoot(real, platform);

  let stat;
  try {
    stat = await fsApi.stat(root, { bigint: true });
  } catch (error) {
    fail(IDENTITY_UNRESOLVED, `cannot stat ${JSON.stringify(root)}: ${error?.code || error?.message || "unknown error"}`);
  }
  if (typeof stat.isDirectory === "function" && !stat.isDirectory()) {
    fail(IDENTITY_UNRESOLVED, `${JSON.stringify(root)} is not a directory: a Vault identity cannot be confirmed`);
  }

  const volumeId = decimalId(stat.dev, "dev");
  const fileId = decimalId(stat.ino, "ino");
  if (volumeId === "0" || fileId === "0") {
    fail(
      IDENTITY_UNRESOLVED,
      `device/file id of ${JSON.stringify(root)} is unusable (dev=${volumeId}, ino=${fileId}): identity cannot be confirmed, ` +
        "keeping the Vault unavailable instead of falling back to path equality (contract §3)",
    );
  }

  const incarnation = await readIncarnation(real, fsApi);
  const parts = { identityVersion: IDENTITY_VERSION, canonicalRoot, volumeId, fileId, incarnation };
  return Object.freeze({ ...parts, digest: computeIdentityDigest(parts) });
}

// Synchronous worker/consumer currency check: no scan, no writes, no cached proof.
export function isVaultDirectoryCurrent(identity) {
  if (!isVaultIdentity(identity) || identity.identityVersion !== 2) return false;
  try {
    const stat = fsSync.statSync(identity.canonicalRoot, { bigint: true });
    return stat.isDirectory() && String(stat.dev) === identity.volumeId && String(stat.ino) === identity.fileId &&
      normalizeCanonicalRoot(fsSync.realpathSync(identity.canonicalRoot)) === identity.canonicalRoot &&
      readIncarnationSync(identity.canonicalRoot) === identity.incarnation;
  } catch { return false; }
}

/** Same-identity comparison for admission/registry cross-checks (never path equality). */
export function sameVaultIdentity(left, right) {
  return Boolean(isVaultIdentity(left) && isVaultIdentity(right) && left.digest === right.digest);
}

/** Short, non-secret label for logs/status: identity is not a credential but need not be echoed whole. */
export function describeIdentity(identity) {
  return isVaultIdentity(identity) ? `v${identity.identityVersion}:${identity.digest.slice(7, 19)}` : "unknown";
}
