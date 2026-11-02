// A1 — canonical Vault descriptor primitives (contract §3, §26 A1, §42 SEC-MV02).
//
// Twins: `app/src/vault-runtime/descriptor.js`, contract §3.1/§3.2/§3.3/§3.4.
//
// Two ratchets live here on purpose:
//   1. ID-rule single source — B7 landed the delegation this file anticipated: the
//      Web registry now trims and calls the canonical `validateVaultId` and declares
//      no pattern of its own. The ratchet is therefore a delegation check (no second
//      `const VAULT_ID = /.../` literal, no `"."`/`".."` guard in the Web file, an
//      explicit import of the canonical validator). The Web-side double-run of the ID
//      matrix through the real Web entry points lives in
//      `test/web-vault-registry-canonical.test.js` (B7).
//   2. Import allowlist — `descriptor.js` may import only `node:*` (no
//      `config.js` global path constants, no `app/**`), per contract §43-5.
//
// Known, intentional asymmetry (documented, not a parity claim): Web `safeId`
// normalizes with `String(value || "").trim()` *before* its regex test, while
// the canonical validator requires a string and never trims or coerces. The
// brief requires `" leading"` to be invalid, so the canonical rule has no trim.
// Parity is asserted on the rule (identical pattern source + identical
// `"."`/`".."` guard) over untrimmed strings, not on Web's normalization.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_KEYS,
  MAX_VAULT_ID_LENGTH,
  VAULT_DESCRIPTOR_INVALID,
  VAULT_ID_INVALID,
  VAULT_ID_PATTERN_SOURCE,
  VAULT_ROOT_ALIAS,
  VAULT_ROOT_UNRESOLVED,
  assertDistinctRoots,
  createVaultDescriptor,
  isValidVaultId,
  unavailable,
  validateVaultId,
  vaultDataKey,
} from "../src/vault-runtime/descriptor.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_DIR, "..");
const MODULE_RELATIVE = "src/vault-runtime/descriptor.js";
const WEB_REGISTRY_RELATIVE = "src/app/vault-registry.js";
const WEB_REGISTRY_SOURCE = () => fs.readFileSync(path.join(APP_ROOT, WEB_REGISTRY_RELATIVE), "utf8");
const MODULE_SOURCE = () => fs.readFileSync(path.join(APP_ROOT, MODULE_RELATIVE), "utf8");

// ---------------------------------------------------------------------------
// Shared ID matrix. Expectations are hand-derived from contract §3.2 (the Web
// rule), NOT computed from the implementation, so a rule change is visible here.
// ---------------------------------------------------------------------------
const ID_MATRIX = Object.freeze([
  // valid — plain ascii
  ["vault", true, "plain ascii"],
  ["default", true, "plain ascii"],
  ["vault2", true, "alphanumeric"],
  ["X", true, "single letter"],
  ["9", true, "single digit"],
  // valid — the full separator class ` ._()-`
  ["my.vault", true, "interior dot"],
  ["a..b", true, "consecutive interior dots"],
  ["a b", true, "interior space"],
  ["a ", true, "trailing space (shared rule accepts)"],
  ["notes (2026)", true, "space + parens"],
  ["a-b_c.d", true, "every separator"],
  ["p(aren)", true, "interior parens"],
  // valid — unicode letter/number categories
  ["中文库", true, "CJK letters"],
  ["日本語ノート", true, "Kana"],
  ["Ελληνικά", true, "Greek"],
  ["Кириллица", true, "Cyrillic"],
  ["العربية", true, "Arabic"],
  ["Ñoño", true, "accented latin"],
  ["ｖａｕｌｔ", true, "fullwidth latin (Ll)"],
  ["٣", true, "Arabic-Indic digit (Nd)"],
  ["Ⅻ", true, "Roman numeral (Nl)"],
  ["ʰa", true, "modifier letter (Lm)"],
  ["𝐀", true, "astral letter: pattern is code-point based (/u), 1 code point"],
  // valid — length boundary
  ["a".repeat(MAX_VAULT_ID_LENGTH - 1), true, "79 code points"],
  ["a".repeat(MAX_VAULT_ID_LENGTH), true, "exactly MAX_VAULT_ID_LENGTH code points"],
  ["a" + "-".repeat(MAX_VAULT_ID_LENGTH - 1), true, "80 code points of hyphens after the first"],
  ["a" + ".".repeat(MAX_VAULT_ID_LENGTH - 1), true, "80 code points of dots after the first"],
  // invalid — empty / reserved / boundary
  ["", false, "empty string"],
  [".", false, "reserved dot"],
  ["..", false, "reserved dot-dot"],
  ["a".repeat(MAX_VAULT_ID_LENGTH + 1), false, "81 code points"],
  ["a".repeat(200), false, "well over the bound"],
  // invalid — first code point must be a letter/number
  [" leading", false, "leading space"],
  ["-abc", false, "hyphen first"],
  ["(abc", false, "paren first"],
  ["_a", false, "underscore first"],
  [".name", false, "leading dot: brief listed it as valid, the shared rule forbids it"],
  ["..hidden", false, "leading double dot"],
  // invalid — characters outside the class
  ["a/b", false, "slash"],
  ["a\\b", false, "backslash"],
  ["vault/../etc", false, "path traversal"],
  ["C:\\vault", false, "windows path"],
  ["a\u0000b", false, "NUL"],
  ["a\tb", false, "tab"],
  ["a\nb", false, "newline"],
  ["a\u00A0b", false, "non-breaking space (Zs, not the ascii space)"],
  ["a\u200Bb", false, "zero-width space (Cf)"],
  ["a\u00ADb", false, "soft hyphen (Cf)"],
  ["e\u0301", false, "combining mark (Mn) is not \\p{L}/\\p{N}"],
  ["🎉", false, "emoji (So)"],
  ["vault🎉", false, "trailing emoji"],
  ["a:b", false, "colon (windows drive-looking id)"],
]);

// ---------------------------------------------------------------------------
// Import scanner (comments + non-specifier string bodies blanked), self-proved.
// ---------------------------------------------------------------------------
function blankCommentsAndForeignStrings(source) {
  let out = "";
  let i = 0;
  let state = "code";
  let keep = false;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"') { keep = /(?:from|import)\s*$/.test(out); state = c === "'" ? "sq" : "dq"; out += c; i += 1; continue; }
      if (c === "`") { state = "tpl"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") { out += c === "\n" ? c : " "; if (c === "\n") state = "code"; i += 1; continue; }
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " "; i += 1; continue;
    }
    if (state === "tpl") {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === "`") { state = "code"; out += c; i += 1; continue; }
      out += c === "\n" ? c : " "; i += 1; continue;
    }
    if (c === "\\") { out += keep ? c + (n ?? "") : "  "; i += 2; continue; }
    if (c === (state === "sq" ? "'" : '"')) { state = "code"; out += c; i += 1; continue; }
    out += keep ? c : " "; i += 1; continue;
  }
  return out;
}

function importSpecifiers(source) {
  const text = blankCommentsAndForeignStrings(source);
  const re = /\bimport\s*(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  return [...text.matchAll(re)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------
// Capability / descriptor helpers
// ---------------------------------------------------------------------------
function capabilities(overrides = {}) {
  const map = {};
  for (const key of CAPABILITY_KEYS) map[key] = { available: true };
  return { ...map, ...overrides };
}

async function withTempRoot(run) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "mv-a1-descriptor-"));
  try {
    return await run(base);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
}

function descriptorInput(root, overrides = {}) {
  return { id: "vault", name: "vault", root, primary: true, writable: true, capabilities: capabilities(), ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Web parity of the ID rule
// ---------------------------------------------------------------------------
test("the Web registry delegates the ID rule and keeps no second pattern (B7)", () => {
  const source = WEB_REGISTRY_SOURCE();
  const literals = [...source.matchAll(/const VAULT_ID = \//g)];
  assert.equal(literals.length, 0, `${WEB_REGISTRY_RELATIVE} must not declare its own ID pattern (contract §3.2), found ${literals.length}`);
  const guards = source.match(/id === "\." \|\| id === "\.\."/g) || [];
  assert.equal(guards.length, 0, 'the `"."`/`".."` guard is provided by the canonical validator now');
  assert.match(
    source,
    /import \{ validateVaultId \} from "\.\.\/vault-runtime\/descriptor\.js";/,
    "Web must import the canonical validator instead of forking the rule",
  );
  assert.equal(MAX_VAULT_ID_LENGTH - 1, 79, "MAX_VAULT_ID_LENGTH must match the pattern quantifier");
  assert.ok(VAULT_ID_PATTERN_SOURCE.includes("{0,79}"), "pattern must keep the {0,79} bound");
});

test("ID matrix: canonical validator verdicts (>= 30 samples)", () => {
  assert.ok(ID_MATRIX.length >= 30, `matrix must hold at least 30 samples, has ${ID_MATRIX.length}`);
  for (const [id, expected, note] of ID_MATRIX) {
    assert.equal(isValidVaultId(id), expected, `isValidVaultId(${JSON.stringify(id)}) — ${note}`);
    if (expected) {
      assert.equal(validateVaultId(id), id, `validateVaultId(${JSON.stringify(id)}) must pass through`);
    } else {
      assert.throws(
        () => validateVaultId(id),
        (error) => error.code === VAULT_ID_INVALID && error.message.startsWith(`[${VAULT_ID_INVALID}] `),
        `validateVaultId(${JSON.stringify(id)}) — ${note}`,
      );
    }
  }
});

test("non-string ids are rejected without coercion (documented Web asymmetry)", () => {
  for (const value of [null, undefined, 42, 0, true, ["vault"], {}, Symbol("vault")]) {
    assert.equal(isValidVaultId(value), false, `isValidVaultId must reject non-string ${String(value)}`);
  }
  assert.throws(() => validateVaultId(42), (error) => error.code === VAULT_ID_INVALID);
});

// ---------------------------------------------------------------------------
// 2. dataKey
// ---------------------------------------------------------------------------
test("vaultDataKey is deterministic, full 64 hex, collision-free and matches sha256", () => {
  const ids = ["vault", "default", "中文库", "a..b", "my.vault", ...Array.from({ length: 20 }, (_, i) => `vault_${i}`)];
  assert.ok(ids.length >= 20, "hash sample set must hold at least 20 ids");
  const seen = new Set();
  for (const id of ids) {
    const key = vaultDataKey(id);
    assert.match(key, /^[0-9a-f]{64}$/, `vaultDataKey(${JSON.stringify(id)}) must be 64 lowercase hex chars`);
    assert.equal(key, vaultDataKey(id), "must be deterministic");
    assert.equal(key, createHash("sha256").update(id).digest("hex"), "must equal a direct sha256 of the id");
    assert.notEqual(key, id, "dataKey is not the id");
    seen.add(key);
  }
  assert.equal(seen.size, ids.length, "distinct ids must not collide");
  assert.throws(() => vaultDataKey("a/b"), (error) => error.code === VAULT_ID_INVALID);
});

test("dataKey does not depend on the root and invalidate nothing else", async () => {
  await withTempRoot(async (base) => {
    const first = await createVaultDescriptor(descriptorInput(base));
    const second = await createVaultDescriptor(descriptorInput(base, { name: "renamed", primary: false }));
    assert.equal(first.dataKey, second.dataKey, "dataKey derives from the id only");
    assert.equal(second.dataKey, vaultDataKey("vault"));
  });
});

// ---------------------------------------------------------------------------
// 3. createVaultDescriptor
// ---------------------------------------------------------------------------
test("createVaultDescriptor shape, passthrough, derived dataKey and deep freeze", async () => {
  await withTempRoot(async (base) => {
    const descriptor = await createVaultDescriptor(descriptorInput(base, { id: "notes", name: "notes", primary: false, writable: false }));
    assert.deepEqual(
      Object.keys(descriptor).sort(),
      ["canonicalRoot", "capabilities", "dataKey", "id", "name", "primary", "root", "writable"],
      "descriptor key set must match contract §3.1 exactly",
    );
    assert.equal(descriptor.id, "notes");
    assert.equal(descriptor.name, "notes");
    assert.equal(descriptor.root, base);
    assert.equal(descriptor.primary, false, "primary must pass through");
    assert.equal(descriptor.writable, false, "writable must pass through");
    assert.equal(descriptor.canonicalRoot, await fsp.realpath(base), "canonicalRoot defaults to fs.realpath(root)");
    assert.equal(descriptor.dataKey, vaultDataKey("notes"));
    assert.ok(Object.isFrozen(descriptor), "descriptor must be frozen");
    assert.ok(Object.isFrozen(descriptor.capabilities), "capabilities must be frozen");
    for (const key of CAPABILITY_KEYS) assert.ok(Object.isFrozen(descriptor.capabilities[key]), `capability ${key} must be frozen`);
    assert.throws(() => { descriptor.id = "other"; }, TypeError, "frozen descriptor must reject mutation");
    assert.throws(() => { descriptor.capabilities.notes = { available: false, reason: "x" }; }, TypeError);
    assert.throws(() => { descriptor.capabilities.notes.available = false; }, TypeError, "capability entries must be frozen");
  });
});

test("createVaultDescriptor name defaults to id; explicit canonicalRoot skips realpath", async () => {
  await withTempRoot(async (base) => {
    const implicit = await createVaultDescriptor(descriptorInput(base, { name: undefined }));
    assert.equal(implicit.name, "vault", "name defaults to id");
    const missingRoot = path.join(base, "does-not-exist");
    const explicit = await createVaultDescriptor(descriptorInput(missingRoot, { canonicalRoot: missingRoot, name: "explicit" }));
    assert.equal(explicit.canonicalRoot, missingRoot, "provided canonicalRoot must be used verbatim");
    await assert.rejects(
      createVaultDescriptor(descriptorInput(missingRoot)),
      (error) => error.code === VAULT_ROOT_UNRESOLVED && error.message.startsWith(`[${VAULT_ROOT_UNRESOLVED}] `),
      "an unresolvable root must throw a structured error for the caller to decide",
    );
  });
});

test("createVaultDescriptor rejects missing/invalid inputs explicitly (no silent default)", async () => {
  await withTempRoot(async (base) => {
    const cases = [
      ["bad id", descriptorInput(base, { id: "a/b" }), VAULT_ID_INVALID],
      ["relative root", descriptorInput("vault"), VAULT_DESCRIPTOR_INVALID],
      ["missing root", descriptorInput(undefined), VAULT_DESCRIPTOR_INVALID],
      ["missing primary", descriptorInput(base, { primary: undefined }), VAULT_DESCRIPTOR_INVALID],
      ["missing writable", descriptorInput(base, { writable: undefined }), VAULT_DESCRIPTOR_INVALID],
      ["non-boolean primary", descriptorInput(base, { primary: "true" }), VAULT_DESCRIPTOR_INVALID],
      ["missing capabilities", descriptorInput(base, { capabilities: undefined }), VAULT_DESCRIPTOR_INVALID],
      ["array input", [], VAULT_DESCRIPTOR_INVALID],
    ];
    for (const [label, input, code] of cases) {
      await assert.rejects(createVaultDescriptor(input), (error) => error.code === code, `${label} must throw ${code}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Capability model (contract §3.4 — no silent missing capability)
// ---------------------------------------------------------------------------
test("CAPABILITY_KEYS is the frozen contract §3.4 inventory", () => {
  assert.ok(Object.isFrozen(CAPABILITY_KEYS));
  assert.deepEqual([...CAPABILITY_KEYS], [
    "notes", "files", "history", "trash", "plans", "retrieval", "semantic",
    "webCatalog", "publish", "git", "events", "memory", "skills",
  ]);
});

test("unavailable(reason) requires a real reason; capabilities must be fully declared", async () => {
  const entry = unavailable("secondary not wired yet");
  assert.deepEqual(entry, { available: false, reason: "secondary not wired yet" });
  assert.ok(Object.isFrozen(entry));
  for (const bad of [undefined, null, "", "   ", 42]) {
    assert.throws(() => unavailable(bad), (error) => error.code === VAULT_DESCRIPTOR_INVALID, `unavailable(${String(bad)}) must throw`);
  }
  await withTempRoot(async (base) => {
    const missing = capabilities();
    delete missing.semantic;
    await assert.rejects(
      createVaultDescriptor(descriptorInput(base, { capabilities: missing })),
      (error) => error.code === VAULT_DESCRIPTOR_INVALID && error.message.includes("semantic"),
      "a missing capability must be an explicit error",
    );
    await assert.rejects(
      createVaultDescriptor(descriptorInput(base, { capabilities: { ...capabilities(), extra: { available: true } } })),
      (error) => error.code === VAULT_DESCRIPTOR_INVALID && error.message.includes("extra"),
      "unknown capability keys must be rejected",
    );
    await assert.rejects(
      createVaultDescriptor(descriptorInput(base, { capabilities: capabilities({ git: { available: false } }) })),
      (error) => error.code === VAULT_DESCRIPTOR_INVALID && error.message.includes("git"),
      "available:false without a reason must be rejected",
    );
    await assert.rejects(
      createVaultDescriptor(descriptorInput(base, { capabilities: capabilities({ git: { available: true, reason: "why" } }) })),
      (error) => error.code === VAULT_DESCRIPTOR_INVALID,
      "available:true with a reason is a contradictory declaration",
    );
    await assert.rejects(
      createVaultDescriptor(descriptorInput(base, { capabilities: capabilities({ git: { available: true, note: "x" } }) })),
      (error) => error.code === VAULT_DESCRIPTOR_INVALID,
      "unknown capability entry keys must be rejected",
    );
    const descriptor = await createVaultDescriptor(
      descriptorInput(base, { capabilities: capabilities({ git: unavailable("  git runtime not wired  ") }) }),
    );
    assert.deepEqual(descriptor.capabilities.git, { available: false, reason: "git runtime not wired" }, "reason is trimmed");
  });
});

// ---------------------------------------------------------------------------
// 5. SEC-MV02 — distinct canonical roots per Vault ID
// ---------------------------------------------------------------------------
test("assertDistinctRoots: real same-root aliasing throws, distinct roots pass", async () => {
  await withTempRoot(async (base) => {
    const alpha = path.join(base, "alpha");
    const beta = path.join(base, "beta");
    await fsp.mkdir(alpha);
    await fsp.mkdir(beta);
    const one = await createVaultDescriptor(descriptorInput(alpha, { id: "one" }));
    const two = await createVaultDescriptor(descriptorInput(beta, { id: "two" }));
    assert.deepEqual(assertDistinctRoots([one, two]), [one, two], "validated list must be returned for chaining");
    assert.deepEqual(assertDistinctRoots([one, one]), [one, one], "the same id twice is a registry dedupe concern, not an alias");

    // Same directory reached through two spellings resolves to one canonicalRoot.
    const aliasSpelling = path.join(base, "alpha", "..", "alpha");
    const alias = await createVaultDescriptor(descriptorInput(aliasSpelling, { id: "alias" }));
    assert.equal(alias.canonicalRoot, one.canonicalRoot, "different spellings must collapse to one canonicalRoot");
    assert.throws(
      () => assertDistinctRoots([one, alias]),
      (error) => error.code === VAULT_ROOT_ALIAS && error.message.startsWith(`[${VAULT_ROOT_ALIAS}] `) && error.message.includes("SEC-MV02"),
      "two ids on one canonical root must throw",
    );
    assert.throws(() => assertDistinctRoots("nope"), (error) => error.code === VAULT_DESCRIPTOR_INVALID);
    assert.throws(
      () => assertDistinctRoots([{ id: "one", canonicalRoot: "" }]),
      (error) => error.code === VAULT_DESCRIPTOR_INVALID,
    );
  });
});

test("assertDistinctRoots: a symlinked root is the same Vault root (or skipped)", async (t) => {
  await withTempRoot(async (base) => {
    const target = path.join(base, "target");
    const link = path.join(base, "link");
    await fsp.mkdir(target);
    try {
      await fsp.symlink(target, link, "junction");
    } catch (error) {
      t.skip(`symlink creation unavailable on this host (${error.code}); real-root aliasing is covered by the ".." spelling case`);
      return;
    }
    const direct = await createVaultDescriptor(descriptorInput(target, { id: "direct" }));
    const viaLink = await createVaultDescriptor(descriptorInput(link, { id: "linked" }));
    assert.equal(viaLink.canonicalRoot, direct.canonicalRoot, "realpath must resolve the symlink to the same root");
    assert.throws(() => assertDistinctRoots([direct, viaLink]), (error) => error.code === VAULT_ROOT_ALIAS);
  });
});

// ---------------------------------------------------------------------------
// 6. Architecture constraint — pure module, no global path constants
// ---------------------------------------------------------------------------
test("import scanner self-proof: only real static specifiers are reported", () => {
  const fixture = [
    'import { VAULT } from "../../config.js";',
    "// import { FAKE } from '../config.js';",
    'const text = "import { ALSO_FAKE } from \'./app/fake.js\'";',
    'const html = `<script>import x from "./tpl.js"</script>`;',
    "await import('./dynamic.js');",
    'import("./dynamic-two.js");',
  ].join("\n");
  assert.deepEqual(importSpecifiers(fixture), ["../../config.js"], "comments/strings must not produce specifiers");
  assert.equal(importSpecifiers('import { VAULT } from "../config.js";').length, 1, "a real import must be detected (negative control)");
});

test("descriptor.js imports only node:* built-ins (no config.js globals, no app/**)", () => {
  const specifiers = importSpecifiers(MODULE_SOURCE());
  assert.deepEqual(specifiers, ["node:crypto", "node:fs/promises", "node:path"], "import allowlist changed (contract §43-5)");
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith("node:"), `${specifier} is not a Node built-in`);
    assert.ok(!/(^|\/)config\.js$/.test(specifier), `${specifier} pulls in the global path constants`);
    assert.ok(!specifier.startsWith("app/") && !specifier.includes("/app/"), `${specifier} reaches into app/**`);
  }
});

// ---------------------------------------------------------------------------
// 7. In-memory negative controls (companions to the logged temp-break runs)
// ---------------------------------------------------------------------------
test("negative control: the length boundary is sensitive to the {0,79} quantifier", () => {
  const weakened = new RegExp(VAULT_ID_PATTERN_SOURCE.replace("{0,79}", "{0,80}"), "u");
  const boundary = "a".repeat(MAX_VAULT_ID_LENGTH + 1);
  assert.equal(weakened.test(boundary), true, "widening the quantifier accepts the 81st code point");
  assert.equal(isValidVaultId(boundary), false, "the shipped rule must keep rejecting it");
});

test("negative control: the dataKey length assertion is sensitive to truncation", () => {
  const truncated = (id) => createHash("sha256").update(id).digest("hex").slice(0, 32);
  assert.equal(truncated("vault").length, 32, "a truncated key still looks hash-like");
  assert.ok(!/^[0-9a-f]{64}$/.test(truncated("vault")), "the 64-hex assertion is what catches truncation");
  assert.match(vaultDataKey("vault"), /^[0-9a-f]{64}$/);
});
