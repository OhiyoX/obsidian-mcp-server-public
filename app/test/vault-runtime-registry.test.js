// A2 — canonical VaultRegistry: pure discovery (contract §4, §26 A2, §41, §42,
// §43). Twin: `app/src/vault-runtime/registry.js`.
//
// What this file ratchets:
//   1. discovery set/order (primary always registered from primaryRoot, first;
//      direct child directories only; hidden / symlink / non-directory /
//      invalid-id / primary-id entries skipped);
//   2. SEC-MV02 duplicate canonical root → `VAULT_ROOT_ALIAS` (delegated to A1);
//   3. §4.3 hard bound — fail closed, never truncate, never republish;
//   4. §4.2 snapshot semantics — lookups never rescan; explicit refresh only;
//   5. §43-5 purity — `node:*` + `./descriptor.js` only, no `config.js`, no
//      `process.env` (asserted on masked source, so comments cannot lie).
//
// Host note: on Windows a directory link must be created as a junction (a plain
// symlink needs elevation and fails with EPERM). `linkDir` tries both and the
// symlink-skip assertion records a diagnostic instead of failing when the host
// refuses entirely; the injected-dirent case below covers the same rule without
// needing link privileges.

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
  VAULT_DESCRIPTOR_INVALID,
  VAULT_ID_INVALID,
  VAULT_ROOT_ALIAS,
  VAULT_ROOT_UNRESOLVED,
  vaultDataKey,
} from "../src/vault-runtime/descriptor.js";
import {
  MAX_SKIPPED_REPORTED,
  MAX_SUPPORTED_VAULTS,
  SKIP_REASONS,
  VAULT_REGISTRY_BOUND_EXCEEDED,
  VAULT_REGISTRY_CONFIG_INVALID,
  VAULT_REGISTRY_INVENTORY_UNREADABLE,
  createVaultRegistry,
} from "../src/vault-runtime/registry.js";
import { countLines, LINE_BUDGET } from "../scripts/line-budget.mjs";
import { importSpecifiers, maskSource } from "./helpers/vault-runtime-source-scan.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(TEST_DIR, "..");
const MODULE_RELATIVE = "src/vault-runtime/registry.js";
const MODULE_SOURCE = () => fs.readFileSync(path.join(APP_ROOT, MODULE_RELATIVE), "utf8");

async function withTempRoot(run) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "mv-a2-registry-"));
  try {
    await run(base);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
}

async function makeDirs(base, names) {
  for (const name of names) await fsp.mkdir(path.join(base, ...name.split("/")), { recursive: true });
}

/** Directory link; Windows needs "junction", POSIX ignores the type. Returns false when the host refuses. */
async function linkDir(target, link) {
  for (const type of ["junction", "dir"]) {
    try {
      await fsp.symlink(target, link, type);
      return true;
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) throw error;
    }
  }
  return false;
}

function dirent(name, { directory = true, symlink = false } = {}) {
  return { name, isDirectory: () => directory, isSymbolicLink: () => symlink };
}

/** Deterministic fsApi: replays a mutable entry list and counts readdir calls (§4.2 proof). */
function fakeFsApi(entries) {
  const state = { calls: 0, entries, failure: null };
  return {
    state,
    api: {
      readdir: async () => {
        state.calls += 1;
        if (state.failure) throw state.failure;
        return state.entries;
      },
    },
  };
}

const idsOf = (registry) => registry.list().map((vault) => vault.id);
const rejectsCode = (code) => (error) => error.code === code;

// ---------------------------------------------------------------------------
// 1. primary-only registry, descriptor shape, frozen snapshot
// ---------------------------------------------------------------------------
test("primary-only registry (vaultsRoot: null): primary registered first, descriptor complete, snapshot frozen", async () => {
  await withTempRoot(async (base) => {
    const primaryRoot = path.join(base, "primary");
    await fsp.mkdir(primaryRoot);
    const registry = createVaultRegistry({ primaryRoot, primaryId: "vault" });

    const before = registry.snapshot();
    assert.equal(before.ready, false, "no implicit pre-refresh inventory");
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.get("vault"), undefined, "there is no implicit pre-refresh Vault");
    assert.equal(registry.describe().counts.registered, 0);

    const snapshot = await registry.refresh();
    assert.equal(registry.snapshot(), snapshot, "snapshot identity is stable until the next successful refresh");
    assert.equal(snapshot.ready, true);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.vaultsRoot, null);
    assert.equal(MAX_SUPPORTED_VAULTS, 64, "contract §4.3 v1 hard bound");

    const primary = registry.list()[0];
    assert.equal(registry.list().length, 1);
    assert.equal(primary.id, "vault");
    assert.equal(primary.name, "vault");
    assert.equal(primary.primary, true);
    assert.equal(primary.writable, true);
    assert.equal(primary.root, primaryRoot);
    assert.equal(primary.canonicalRoot, await fsp.realpath(primaryRoot));
    assert.equal(primary.dataKey, vaultDataKey("vault"));
    assert.equal(primary.dataKey, createHash("sha256").update("vault").digest("hex"));
    for (const key of CAPABILITY_KEYS) {
      assert.equal(primary.capabilities[key].available, false, `${key} must be an explicit unavailable fact, not a silent default`);
      assert.ok(primary.capabilities[key].reason.length > 0, `${key} must carry a visible reason`);
    }
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(registry.list()) && Object.isFrozen(primary) && Object.isFrozen(primary.capabilities));
    assert.deepEqual(registry.describe().counts, { registered: 1, primary: 1, skipped: 0 });
    assert.equal(registry.get("vault"), primary);
  });
});

// ---------------------------------------------------------------------------
// 2. discovery: what becomes a Vault and what is skipped
// ---------------------------------------------------------------------------
test("discovery: direct child directories only, primary first, id order; hidden/symlink/file/invalid-id entries skipped", async (t) => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(vaultsRoot, "vault");
    await makeDirs(base, ["vaults/vault", "vaults/zeta", "vaults/alpha", "vaults/beta", "vaults/.hidden", "vaults/-bad", "vaults/ leading"]);
    await fsp.writeFile(path.join(vaultsRoot, "notes.txt"), "not a vault\n");
    const linkCreated = await linkDir(path.join(vaultsRoot, "alpha"), path.join(vaultsRoot, "linked"));
    if (!linkCreated) t.diagnostic("host refused to create a directory link; the symlink rule is still covered by the injected-dirent case");

    const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot });
    const snapshot = await registry.refresh();
    assert.deepEqual(idsOf(registry), ["vault", "alpha", "beta", "zeta"], "primary first, then id code-unit order");
    assert.equal(registry.list()[0].root, primaryRoot, "primary is registered from primaryRoot");
    assert.equal(registry.get("vault").primary, true);
    assert.equal(registry.get("alpha").primary, false);

    const skipped = Object.fromEntries(snapshot.skipped.map((entry) => [entry.name, entry]));
    assert.equal(skipped[".hidden"].reason, SKIP_REASONS.HIDDEN);
    assert.equal(skipped["notes.txt"].reason, SKIP_REASONS.NOT_DIRECTORY);
    assert.equal(skipped["-bad"].reason, SKIP_REASONS.INVALID_ID);
    assert.equal(skipped["-bad"].code, VAULT_ID_INVALID, "the skip carries A1's stable code");
    assert.equal(skipped[" leading"].reason, SKIP_REASONS.INVALID_ID);
    assert.equal(skipped.vault.reason, SKIP_REASONS.PRIMARY_ID, "the primary's own directory is never a second entry");
    if (linkCreated) assert.equal(skipped.linked.reason, SKIP_REASONS.SYMLINK, "a linked root is never followed (SEC-MV01)");
    assert.equal(registry.get("linked"), undefined);
    assert.deepEqual(registry.describe().counts, { registered: 4, primary: 1, skipped: snapshot.skipped.length });
  });
});

// ---------------------------------------------------------------------------
// 3. SEC-MV02 — duplicate canonical root, fail closed
// ---------------------------------------------------------------------------
test("SEC-MV02: a discovered candidate resolving to the primary canonical root throws VAULT_ROOT_ALIAS", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    await makeDirs(base, ["vaults/one"]);
    // `..` spelling: primaryRoot and the discovered id "one" reach one real path.
    const spelled = `${vaultsRoot}${path.sep}one${path.sep}..${path.sep}one`;
    const registry = createVaultRegistry({ primaryRoot: spelled, primaryId: "vault", vaultsRoot });
    await assert.rejects(
      registry.refresh(),
      (error) => error.code === VAULT_ROOT_ALIAS && error.message.startsWith(`[${VAULT_ROOT_ALIAS}] `) && error.message.includes("one"),
    );
    assert.equal(registry.snapshot().ready, false, "a failed refresh publishes nothing");
    assert.deepEqual(registry.list(), []);
  });
});

test("SEC-MV02 + SEC-MV01: a link presented as a directory is an alias error; presented as a symlink it is skipped", async (t) => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "target");
    await makeDirs(base, ["vaults", "target"]);
    if (!(await linkDir(primaryRoot, path.join(vaultsRoot, "alias")))) {
      t.diagnostic("host refused to create a directory link; skipping the alias-through-link case");
      return;
    }
    // Negative control pair: the ONLY difference is the dirent flags the fsApi reports.
    const asDirectory = fakeFsApi([dirent("alias", { directory: true, symlink: false })]);
    const aliasing = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, fsApi: asDirectory.api });
    await assert.rejects(aliasing.refresh(), rejectsCode(VAULT_ROOT_ALIAS), "following a linked entry must be caught by SEC-MV02");

    const asSymlink = fakeFsApi([dirent("alias", { directory: false, symlink: true })]);
    const skipping = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, fsApi: asSymlink.api });
    const snapshot = await skipping.refresh();
    assert.deepEqual(idsOf(skipping), ["vault"]);
    assert.equal(snapshot.skipped[0].reason, SKIP_REASONS.SYMLINK);
  });
});

// ---------------------------------------------------------------------------
// 4. unreadable / malformed inventory, snapshot preservation
// ---------------------------------------------------------------------------
test("an unreadable or malformed vaultsRoot fails closed and preserves the published snapshot", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "primary");
    await makeDirs(base, ["vaults/a", "primary"]);
    const { api, state } = fakeFsApi([dirent("a")]);
    const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, fsApi: api });
    const first = await registry.refresh();
    assert.deepEqual(idsOf(registry), ["vault", "a"]);

    state.failure = Object.assign(new Error("denied"), { code: "EACCES" });
    await assert.rejects(registry.refresh(), (error) => error.code === VAULT_REGISTRY_INVENTORY_UNREADABLE && error.message.includes("EACCES"));
    state.failure = null;

    state.entries = 42;
    await assert.rejects(registry.refresh(), rejectsCode(VAULT_REGISTRY_INVENTORY_UNREADABLE), "a non-array readdir result is not a real dirent list");
    state.entries = [{ name: "a" }];
    await assert.rejects(registry.refresh(), rejectsCode(VAULT_REGISTRY_INVENTORY_UNREADABLE), "a malformed dirent must not be guessed at");
    state.entries = [dirent("a")];

    assert.equal(registry.snapshot(), first, "no failed refresh may publish");
    assert.equal(registry.snapshot().revision, 1);
    const second = await registry.refresh();
    assert.equal(second.revision, 2, "a successful refresh bumps the revision");
    assert.notEqual(second, first);
  });
});

// ---------------------------------------------------------------------------
// 5. §4.3 bound — inclusive of primary, refusal (not truncation)
// ---------------------------------------------------------------------------
test("§4.3: exactly maxVaults (primary included) registers; one more fails closed without republishing", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "primary");
    await fsp.mkdir(vaultsRoot, { recursive: true });
    await fsp.mkdir(primaryRoot);
    const names = Array.from({ length: MAX_SUPPORTED_VAULTS }, (_, index) => `v${String(index).padStart(2, "0")}`);
    for (const name of names.slice(0, MAX_SUPPORTED_VAULTS - 1)) await fsp.mkdir(path.join(vaultsRoot, name));

    const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot });
    const snapshot = await registry.refresh();
    assert.equal(snapshot.vaults.length, MAX_SUPPORTED_VAULTS, "64 = primary + 63 secondaries");
    assert.equal(registry.describe().counts.registered, MAX_SUPPORTED_VAULTS);

    await fsp.mkdir(path.join(vaultsRoot, names[MAX_SUPPORTED_VAULTS - 1]));
    await assert.rejects(
      registry.refresh(),
      (error) => error.code === VAULT_REGISTRY_BOUND_EXCEEDED && error.message.startsWith(`[${VAULT_REGISTRY_BOUND_EXCEEDED}] `),
      "must refuse rather than truncate",
    );
    assert.equal(registry.snapshot(), snapshot, "a bound failure must not truncate or republish");
    assert.equal(registry.list().length, MAX_SUPPORTED_VAULTS);
  });
});

test("boundary sensitivity: a lower maxVaults is honoured, and maxVaults can never be raised above the contract bound", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "primary");
    await makeDirs(base, ["vaults/a", "vaults/b", "primary"]);

    const exact = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, maxVaults: 3 });
    assert.equal((await exact.refresh()).vaults.length, 3, "primary + 2 secondaries == maxVaults is allowed");
    const tight = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, maxVaults: 2 });
    await assert.rejects(tight.refresh(), rejectsCode(VAULT_REGISTRY_BOUND_EXCEEDED));

    const configRejected = (options) => assert.throws(() => createVaultRegistry(options), rejectsCode(VAULT_REGISTRY_CONFIG_INVALID));
    configRejected({ primaryRoot, maxVaults: 0 });
    configRejected({ primaryRoot, maxVaults: MAX_SUPPORTED_VAULTS + 1 });
    configRejected({ primaryRoot, maxVaults: 1.5 });
    configRejected({ primaryRoot, maxVaults: "8" });
  });
});

// ---------------------------------------------------------------------------
// 6. §4.2 snapshot semantics — no polling
// ---------------------------------------------------------------------------
test("§4.2: lookups never rescan; a directory that appears later is invisible until an explicit refresh", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "primary");
    await makeDirs(base, ["vaults/a", "vaults/b", "primary"]);
    const { api, state } = fakeFsApi([dirent("a")]);
    const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, fsApi: api });
    await registry.refresh();
    assert.equal(state.calls, 1, "refresh is the only filesystem access");

    for (let index = 0; index < 25; index += 1) {
      registry.list();
      registry.get("a");
      registry.get("b");
      registry.snapshot();
      registry.describe();
      registry.get(42);
      registry.get("../escape");
    }
    assert.equal(state.calls, 1, "ordinary lookups must not touch the filesystem (§4.2/§41)");
    assert.deepEqual(idsOf(registry), ["vault", "a"]);
    assert.equal(registry.get("b"), undefined, "not refreshed yet, even though the directory exists on disk");
    assert.equal(registry.get(42), undefined, "get() never throws and never coerces");
    assert.equal(registry.get("../escape"), undefined);
    assert.equal(registry.describe().ready, true);

    state.entries = [dirent("a"), dirent("b")];
    const second = await registry.refresh();
    assert.equal(state.calls, 2);
    assert.deepEqual(idsOf(registry), ["vault", "a", "b"]);
    assert.equal(second.revision, 2);
  });
});

// ---------------------------------------------------------------------------
// 7. unresolved roots, bounded skip reporting
// ---------------------------------------------------------------------------
test("a discovered directory whose root cannot be resolved is reported as skipped, never registered and never aliased to primary", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "primary");
    await makeDirs(base, ["vaults/a", "primary"]);
    const { api } = fakeFsApi([dirent("a"), dirent("ghost")]);
    const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, fsApi: api });
    const snapshot = await registry.refresh();

    assert.deepEqual(idsOf(registry), ["vault", "a"], "a vanished root must not become a Vault with a synthetic canonicalRoot");
    assert.equal(registry.get("ghost"), undefined);
    const ghost = snapshot.skipped.find((entry) => entry.name === "ghost");
    assert.equal(ghost.reason, SKIP_REASONS.UNRESOLVED_ROOT);
    assert.equal(ghost.code, VAULT_ROOT_UNRESOLVED, "the structured A1 code is preserved for Admin/health");
    assert.deepEqual(registry.describe().counts, { registered: 2, primary: 1, skipped: 1 });
  });
});

test("skipped reporting is bounded: detail is capped and the remainder is counted", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "primary");
    await makeDirs(base, ["vaults", "primary"]);
    const extra = 5;
    const entries = Array.from({ length: MAX_SKIPPED_REPORTED + extra }, (_, index) => dirent(`.hidden${String(index).padStart(3, "0")}`));
    const { api } = fakeFsApi(entries);
    const registry = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, fsApi: api });
    const snapshot = await registry.refresh();
    assert.equal(snapshot.skipped.length, MAX_SKIPPED_REPORTED);
    assert.equal(snapshot.skippedOverflow, extra);
    assert.deepEqual(idsOf(registry), ["vault"]);
    assert.equal(registry.describe().counts.skipped, MAX_SKIPPED_REPORTED + extra);
  });
});

// ---------------------------------------------------------------------------
// 8. capabilities / writable are explicit facts, validated fail-closed
// ---------------------------------------------------------------------------
test("capability facts and writable come from explicit configuration; a broken factory fails closed", async () => {
  await withTempRoot(async (base) => {
    const vaultsRoot = path.join(base, "vaults");
    const primaryRoot = path.join(base, "primary");
    await makeDirs(base, ["vaults/a", "primary"]);
    const seen = [];
    const capabilities = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, { available: true }]));
    const registry = createVaultRegistry({
      primaryRoot,
      primaryId: "vault",
      vaultsRoot,
      writable: false,
      capabilitiesFor: (vault) => {
        seen.push(vault);
        return capabilities;
      },
    });
    const snapshot = await registry.refresh();
    assert.deepEqual(seen.map((vault) => vault.id).sort(), ["a", "vault"]);
    assert.equal(seen.find((vault) => vault.id === "vault").primary, true);
    assert.equal(seen.find((vault) => vault.id === "a").primary, false);
    for (const vault of snapshot.vaults) {
      assert.equal(vault.writable, false, "writable is configuration, not a silent per-vault default");
      assert.equal(vault.capabilities.notes.available, true);
    }

    const broken = createVaultRegistry({ primaryRoot, primaryId: "vault", vaultsRoot, capabilitiesFor: () => ({ notes: { available: true } }) });
    await assert.rejects(broken.refresh(), rejectsCode(VAULT_DESCRIPTOR_INVALID), "A1 validates the capability map, A2 must not paper over it");
    assert.equal(broken.snapshot().ready, false);

    // A capability bug that only affects a secondary must abort the refresh, not be
    // filed as an inventory anomaly (which would silently drop that Vault).
    let calls = 0;
    const partiallyBroken = createVaultRegistry({
      primaryRoot,
      primaryId: "vault",
      vaultsRoot,
      capabilitiesFor: () => {
        calls += 1;
        return calls === 1 ? capabilities : { notes: { available: true } };
      },
    });
    await assert.rejects(partiallyBroken.refresh(), rejectsCode(VAULT_DESCRIPTOR_INVALID), "a per-Vault capability bug must fail the whole refresh");
    assert.equal(partiallyBroken.snapshot().ready, false);
    assert.equal(partiallyBroken.describe().counts.skipped, 0, "the failure is not disguised as a skipped directory");
  });
});

// ---------------------------------------------------------------------------
// 9. configuration is explicit and fail-closed
// ---------------------------------------------------------------------------
test("configuration validation is fail-closed (typos, relative paths, nested vaultsRoot, unresolvable primary)", async () => {
  await withTempRoot(async (base) => {
    const primaryRoot = path.join(base, "primary");
    const vaultsRoot = path.join(base, "vaults");
    await makeDirs(base, ["primary", "vaults"]);
    const rejected = (options) => assert.throws(() => createVaultRegistry(options), rejectsCode(VAULT_REGISTRY_CONFIG_INVALID));

    rejected({});
    rejected({ primaryRoot: "relative/path" });
    rejected({ primaryRoot, vaultsRoot: primaryRoot });
    rejected({ primaryRoot, vaultsRoot: path.join(primaryRoot, "vaults") });
    rejected({ primaryRoot, writable: "yes" });
    rejected({ primaryRoot, capabilitiesFor: {} });
    rejected({ primaryRoot, fsApi: {} });
    rejected({ primaryRoot, vaultRoot: primaryRoot });

    // ID validation is delegated to A1 (§3.2: do not fork the rule), so an invalid
    // primaryId surfaces A1's code, not a registry-local wrapper code.
    const rejectedId = (options) => assert.throws(() => createVaultRegistry(options), rejectsCode(VAULT_ID_INVALID));
    rejectedId({ primaryRoot, primaryId: "../escape" });
    rejectedId({ primaryRoot, primaryId: "" });

    const missingPrimary = createVaultRegistry({ primaryRoot: path.join(base, "missing"), primaryId: "vault" });
    await assert.rejects(missingPrimary.refresh(), rejectsCode(VAULT_ROOT_UNRESOLVED), "the primary root is mandatory (fail closed)");
  });
});

// ---------------------------------------------------------------------------
// 10. §43-5 purity of the source
// ---------------------------------------------------------------------------
test("source scanner self-proof: comments and foreign strings produce no specifiers", () => {
  const fixture = [
    'import { VAULT } from "../config.js";',
    "// import { FAKE } from '../config.js';",
    'const text = "import { ALSO_FAKE } from \'./app/fake.js\'";',
    "const html = `<script>import x from \"./tpl.js\"</script>`;",
    "await import('./dynamic.js');",
    "// process.env.SECRET",
    'const message = "process.env is not read here";',
  ].join("\n");
  assert.deepEqual(importSpecifiers(fixture), ["../config.js"], "only real static specifiers may be reported");
  assert.deepEqual(importSpecifiers('import { VAULT } from "../config.js";'), ["../config.js"], "negative control: a real import is still detected");
  assert.ok(!/process\s*\.\s*env/.test(maskSource(fixture)), "negative control: a string/comment mention must be masked out");
});

test("registry.js is pure: node:* + ./descriptor.js only, no config.js, no process.env, within the line budget", () => {
  const source = MODULE_SOURCE();
  const specifiers = importSpecifiers(source);
  assert.ok(!specifiers.includes("../config.js"), "registry.js must not import config.js");
  assert.deepEqual(specifiers, ["node:fs/promises", "node:path", "./descriptor.js", "./registry-scan.js", "./serving-gate.js", "./composed-commit.js", "./registry-commit.js", "./registry-snapshot.js"], "import allowlist changed (contract §43-5)");
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith("node:") || specifier === "./descriptor.js" || specifier === "./registry-scan.js" || specifier === "./registry-snapshot.js" || specifier === "./serving-gate.js" || specifier === "./composed-commit.js" || specifier === "./registry-commit.js", `${specifier} is not allowed in a pure vault-runtime module`);
  }
  const masked = maskSource(source);
  assert.ok(!/process\s*\.\s*env/.test(masked), "registry.js must not read process.env (all inputs are explicit parameters)");
  assert.ok(!/config\.js/.test(masked), "registry.js must not import the global path constants (contract §43-5)");
  assert.ok(countLines(source) <= LINE_BUDGET, `${MODULE_RELATIVE} exceeds the ${LINE_BUDGET}-line budget`);
  assert.ok(!/\bVAULT\b\s*[,}]/.test(masked), "no global VAULT constant may be reachable from this module");
});

// W2FIX5 (#437 W2FIX4 item A / R1): the ONE composed commit record is a leaf module — the shared
// pointer must not be able to pull an ambient collaborator (config.js / process.env) into the three
// faces that read it.
test("composed-commit.js is a pure leaf: no imports, no process.env, within the line budget", () => {
  const relative = "src/vault-runtime/composed-commit.js";
  const source = fs.readFileSync(path.join(APP_ROOT, relative), "utf8");
  assert.deepEqual(importSpecifiers(source), [], "the composed commit record must stay a leaf module");
  const masked = maskSource(source);
  assert.ok(!/process\s*\.\s*env/.test(masked), "composed-commit.js must not read process.env");
  assert.ok(!/config\.js/.test(masked), "composed-commit.js must not import config.js");
  assert.ok(countLines(source) <= LINE_BUDGET, `${relative} exceeds the ${LINE_BUDGET}-line budget`);
});
