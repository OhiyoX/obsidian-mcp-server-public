// A7 — `vault-runtime/paths.js` layout tests (pure foundation).
//
// Contract: "DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置"
//   §5.1 primary compatibility, §5.2 secondary data layout, §22.2 (no primary migration),
//   §26 A7, §43 (architecture tests), §45 (lane gates).
//
// These tests deliberately do NOT import `src/config.js`: importing it evaluates the host
// environment at import time. The link to the legacy naming is instead verified by reading
// the current legacy sources as text (test `legacy naming ↔ layout seam`).
//
// Every path below is synthetic and host-independent; nothing is created on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRIMARY_PATH_KEYS,
  SECONDARY_PATH_KEYS,
  isVaultDataKey,
  primaryVaultDataPaths,
  requiredDirectories,
  secondaryVaultDataPaths,
  vaultDataPaths,
} from "../src/vault-runtime/paths.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_DIR, "..");
const MODULE_RELATIVE = "src/vault-runtime/paths.js";

// Absolute synthetic data root (never touched on disk; works on Windows and POSIX).
const DATA_ROOT = path.join(path.parse(APP_ROOT).root, "mv-a7-data-root");
const VAULTS_DIR = "vaults";
const KEY_A = createHash("sha256").update("vault-a").digest("hex");
const KEY_B = createHash("sha256").update("vault-b").digest("hex");
const ROOT_A = path.join(DATA_ROOT, VAULTS_DIR, KEY_A);
const ROOT_B = path.join(DATA_ROOT, VAULTS_DIR, KEY_B);
// Built by string concatenation on purpose: `path.join` would normalize the '..' away.
const TRAVERSAL_ROOT = `${DATA_ROOT}${path.sep}..${path.sep}escape`;

const LEGACY = Object.freeze({
  history: path.join(DATA_ROOT, "history"),
  trash: path.join(DATA_ROOT, "trash"),
  retrievalIndex: path.join(DATA_ROOT, "index", "retrieval-index.json"),
  transfersUploads: path.join(DATA_ROOT, "transfers", "uploads"),
  mutationJournal: path.join(DATA_ROOT, "mutation-journal"),
  mutationIdempotency: path.join(DATA_ROOT, "mutation-idempotency"),
});

function moduleSource() {
  return fs.readFileSync(path.join(APP_ROOT, MODULE_RELATIVE), "utf8");
}

function readSource(relative) {
  return fs.readFileSync(path.join(APP_ROOT, relative), "utf8");
}

function isUnder(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// ---------------------------------------------------------------------------
// 1. Layout exactness (§5.2)
// ---------------------------------------------------------------------------

test("secondary layout matches contract §5.2 field by field", () => {
  const paths = secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_A });
  const expected = {
    root: ROOT_A,
    history: path.join(ROOT_A, "history"),
    trash: path.join(ROOT_A, "trash"),
    retrievalIndex: path.join(ROOT_A, "index", "retrieval-index.json"),
    transfersUploads: path.join(ROOT_A, "transfers", "uploads"),
    mutationJournal: path.join(ROOT_A, "mutation-journal"),
    mutationIdempotency: path.join(ROOT_A, "mutation-idempotency"),
  };
  assert.deepEqual(paths, expected);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(paths[key], value, `${key} must be exactly ${value}`);
  }
  assert.deepEqual(Object.keys(paths), [...SECONDARY_PATH_KEYS]);
  assert.equal(paths.retrievalIndex, path.join(paths.root, "index", "retrieval-index.json"));
});

test("secondary layout is absolute, traversal-free and frozen", () => {
  const paths = secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_A });
  assert.ok(Object.isFrozen(paths), "layout must be frozen to prevent consumer mutation");
  for (const value of Object.values(paths)) {
    assert.ok(path.isAbsolute(value), `${value} must be absolute`);
    assert.ok(!value.split(/[\\/]+/).includes(".."), `${value} must not contain '..'`);
    assert.ok(!value.includes("\0"), `${value} must not contain a NUL byte`);
  }
});

// ---------------------------------------------------------------------------
// 2. Primary passthrough (§5.1 / §22.2): never re-derive, never relocate
// ---------------------------------------------------------------------------

test("primary legacy mapping is passed through unchanged", () => {
  const paths = primaryVaultDataPaths(LEGACY);
  for (const key of PRIMARY_PATH_KEYS) {
    assert.strictEqual(paths[key], LEGACY[key], `${key} must be the caller's value, untouched`);
  }
  assert.deepEqual(Object.keys(paths), [...PRIMARY_PATH_KEYS]);
  assert.equal(paths.root, undefined, "primary has no per-vault root (§22.2: no migration)");
  assert.deepEqual(paths, LEGACY);
  assert.ok(Object.isFrozen(paths));
});

test("primary passthrough keeps non-default legacy roots (no DATA_PATH re-derivation)", () => {
  const custom = {
    history: path.join(DATA_ROOT, "custom-history"),
    trash: path.join(DATA_ROOT, "custom-trash"),
    retrievalIndex: path.join(DATA_ROOT, "custom-index", "retrieval-index.json"),
    transfersUploads: path.join(DATA_ROOT, "custom-transfers", "uploads"),
    mutationJournal: path.join(DATA_ROOT, "custom-journal"),
    mutationIdempotency: path.join(DATA_ROOT, "custom-idempotency"),
  };
  const paths = primaryVaultDataPaths(custom);
  assert.deepEqual(paths, custom);
  assert.ok(!Object.values(paths).some((value) => value.startsWith(path.join(DATA_ROOT, VAULTS_DIR))),
    "primary paths must never be re-written into the secondary layout");
});

// ---------------------------------------------------------------------------
// 3. Dispatcher
// ---------------------------------------------------------------------------

test("dispatcher routes primary to legacy and secondary to the per-vault layout", () => {
  assert.deepEqual(vaultDataPaths({ primary: true, ...LEGACY }), primaryVaultDataPaths(LEGACY));
  assert.deepEqual(
    vaultDataPaths({ primary: false, dataRoot: DATA_ROOT, dataKey: KEY_B }),
    secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_B }),
  );
  assert.equal(vaultDataPaths({ primary: false, dataRoot: DATA_ROOT, dataKey: KEY_B }).root, ROOT_B);
});

test("dispatcher fails closed instead of silently falling back to primary", () => {
  assert.throws(() => vaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_A }), /primary must be a boolean/);
  assert.throws(() => vaultDataPaths({ primary: "true", ...LEGACY }), /primary must be a boolean/);
  assert.throws(() => vaultDataPaths(null), /must be an object/);
  assert.throws(() => vaultDataPaths({ primary: false, dataRoot: DATA_ROOT }), /dataKey/);
  assert.throws(() => vaultDataPaths({ primary: true, history: LEGACY.history }), /trash/);
});

// ---------------------------------------------------------------------------
// 4. Isolation + idempotency + purity
// ---------------------------------------------------------------------------

test("two dataKeys share no path and cannot nest or escape (SEC-MV01)", () => {
  const a = secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_A });
  const b = secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_B });
  assert.notEqual(KEY_A, KEY_B);
  for (const key of SECONDARY_PATH_KEYS) {
    assert.notEqual(a[key], b[key], `${key} must differ between vaults`);
    assert.ok(!a[key].startsWith(`${b[key]}${path.sep}`), `${key}: A must not nest inside B`);
    assert.ok(!b[key].startsWith(`${a[key]}${path.sep}`), `${key}: B must not nest inside A`);
    const relative = path.relative(a[key], b[key]);
    assert.ok(relative === "" || relative.startsWith("..") || path.isAbsolute(relative),
      `${key}: the other vault's path must be outside this one`);
    assert.ok(isUnder(DATA_ROOT, a[key]) && isUnder(DATA_ROOT, b[key]),
      `${key}: both vaults must stay contained under dataRoot`);
  }
  assert.equal(path.dirname(a.root), path.dirname(b.root), "vault roots share the same parent");
  assert.equal(path.basename(a.root), KEY_A);
  assert.equal(path.basename(b.root), KEY_B);
  assert.ok(isUnder(a.root, a.history) && isUnder(a.root, a.retrievalIndex));
  assert.ok(!isUnder(a.root, b.history), "another vault's data must live outside this vault root");
});

test("layout is pure and idempotent for the same input", () => {
  const input = { dataRoot: DATA_ROOT, dataKey: KEY_A };
  assert.deepEqual(secondaryVaultDataPaths(input), secondaryVaultDataPaths(input));
  assert.deepEqual(
    primaryVaultDataPaths({ ...LEGACY }),
    primaryVaultDataPaths({ ...LEGACY }),
  );
  assert.notEqual(secondaryVaultDataPaths(input), secondaryVaultDataPaths(input),
    "results are fresh objects (no shared mutable cache)");
});

// ---------------------------------------------------------------------------
// 5. requiredDirectories (§22.3)
// ---------------------------------------------------------------------------

test("requiredDirectories lists protected directories, not the index file", () => {
  const secondary = secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_A });
  assert.deepEqual(requiredDirectories(secondary), [
    ROOT_A,
    path.join(ROOT_A, "history"),
    path.join(ROOT_A, "trash"),
    path.join(ROOT_A, "index"),
    path.join(ROOT_A, "transfers", "uploads"),
    path.join(ROOT_A, "mutation-journal"),
    path.join(ROOT_A, "mutation-idempotency"),
  ]);
  assert.ok(!requiredDirectories(secondary).includes(secondary.retrievalIndex),
    "the retrieval index file itself is not a directory to create");
});

test("requiredDirectories for primary has no per-vault root and is deduplicated", () => {
  const primary = primaryVaultDataPaths(LEGACY);
  const dirs = requiredDirectories(primary);
  assert.deepEqual(dirs, [
    LEGACY.history,
    LEGACY.trash,
    path.join(DATA_ROOT, "index"),
    LEGACY.transfersUploads,
    LEGACY.mutationJournal,
    LEGACY.mutationIdempotency,
  ]);
  assert.equal(dirs.length, new Set(dirs).size, "no duplicate directories");
  assert.ok(!dirs.includes(path.join(DATA_ROOT, VAULTS_DIR)), "primary must not use the secondary root");
});

// ---------------------------------------------------------------------------
// 6. Guards: fail closed instead of producing a traversal path
// ---------------------------------------------------------------------------

test("dataKey guard accepts only the canonical sha256 hex form", () => {
  assert.ok(isVaultDataKey(KEY_A));
  assert.deepEqual(
    ["", "..", ".", "../../etc", "a".repeat(63), "a".repeat(65), `${KEY_A}a`, KEY_A.toUpperCase(),
      "A".repeat(64), 1234, null, undefined, `${KEY_A}/x`, `x/${KEY_A}`, `${KEY_A}\0`,
    ].filter(isVaultDataKey),
    [],
    "no non-canonical key may be accepted",
  );
});

test("traversal-ish dataKey and non-absolute dataRoot throw", () => {
  assert.throws(() => secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: "../../etc" }), /dataKey/);
  assert.throws(() => secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_A.toUpperCase() }), /dataKey/);
  assert.throws(() => secondaryVaultDataPaths({ dataRoot: "data", dataKey: KEY_A }), /absolute/);
  assert.throws(() => secondaryVaultDataPaths({ dataRoot: TRAVERSAL_ROOT, dataKey: KEY_A }), /\.\./);
  assert.throws(() => secondaryVaultDataPaths({ dataRoot: DATA_ROOT }), /dataKey/);
  assert.throws(() => secondaryVaultDataPaths(undefined), /must be an object/);
});

// ---------------------------------------------------------------------------
// 7. Source assertions: purity (no environment read, no config.js, no I/O)
// ---------------------------------------------------------------------------

function mentionsEnvRead(source) {
  return source.includes("process.env");
}

test("module source has no environment read, no config.js import and no filesystem I/O", () => {
  const source = moduleSource();
  assert.equal(mentionsEnvRead(source), false, "paths.js must not read the environment");
  assert.doesNotMatch(source, /from\s+["'][^"']*config\.js["']/, "paths.js must not import config.js");
  assert.doesNotMatch(source, /from\s+["']node:fs/, "paths.js must stay free of filesystem I/O");
  assert.doesNotMatch(source, /\b(?:mkdir|writeFile|rmSync|existsSync)\b/, "paths.js must not create or inspect paths");
  assert.doesNotMatch(source, /\brequire\s*\(/, "paths.js is ESM-only");
  assert.match(source, /export function secondaryVaultDataPaths\(/, "positive control: expected export missing");
});

test("the source assertion is not vacuous (control fixture + scan proof)", () => {
  assert.equal(mentionsEnvRead(`${moduleSource()}\nconst x = process.env.DATA_PATH;`), true,
    "the scanner must detect the pattern it forbids");
  const source = moduleSource();
  assert.equal(source.includes("process.env"), false);
  assert.ok(source.split("\n").length > 40 && source.split("\n").length <= 500,
    "module must be non-trivial and inside the local 500-line cap");
  for (const name of ["PRIMARY_PATH_KEYS", "SECONDARY_PATH_KEYS", "isVaultDataKey",
    "primaryVaultDataPaths", "secondaryVaultDataPaths", "vaultDataPaths", "requiredDirectories"]) {
    assert.match(source, new RegExp(`export (?:const|function) ${name}\\b`), `${name} must stay exported`);
  }
});

// ---------------------------------------------------------------------------
// 8. Legacy seam: the layout mirrors the *current* legacy naming (read-only)
// ---------------------------------------------------------------------------

// file → the legacy literal that must still exist on main, and the §5.2 suffix it maps to.
const LEGACY_SEAM = Object.freeze([
  { file: "src/config.js", literal: 'path.join(DATA_PATH, "history")' },
  { file: "src/config.js", literal: 'path.join(DATA_PATH, "trash")' },
  { file: "src/config.js", literal: 'path.join(DATA_PATH, "index", "retrieval-index.json")' },
  { file: "src/file-transfer.js", literal: 'path.join(DATA_PATH, "transfers", "uploads")' },
  { file: "src/batch-journal.js", literal: 'path.join(DATA_PATH, "mutation-journal")' },
  { file: "src/mutation-idempotency.js", literal: 'path.join(DATA_PATH, "mutation-idempotency")' },
]);

test("legacy naming ↔ secondary layout seam (§5.1/§5.2): read the legacy sources", () => {
  const paths = secondaryVaultDataPaths({ dataRoot: DATA_ROOT, dataKey: KEY_A });
  const suffixOf = (literal) => {
    const inner = literal.slice('path.join(DATA_PATH, '.length, -1);
    return inner.split(",").map((part) => part.trim().replace(/^"(.*)"$/, "$1"));
  };
  for (const { file, literal } of LEGACY_SEAM) {
    assert.ok(readSource(file).includes(literal),
      `${file} no longer contains ${literal} — the §5.1 legacy naming changed, re-check the §5.2 layout`);
  }
  assert.deepEqual([
    paths.history,
    paths.trash,
    paths.retrievalIndex,
    paths.transfersUploads,
    paths.mutationJournal,
    paths.mutationIdempotency,
  ], LEGACY_SEAM.map(({ literal }) => path.join(DATA_ROOT, VAULTS_DIR, KEY_A, ...suffixOf(literal))));
  assert.deepEqual(PRIMARY_PATH_KEYS, [
    "history", "trash", "retrievalIndex", "transfersUploads", "mutationJournal", "mutationIdempotency",
  ]);
});
