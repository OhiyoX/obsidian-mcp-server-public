// B7 — the Web Vault registry consumes the canonical VaultRegistry (A2).
//
// Twins: `app/src/app/vault-registry.js`, `app/src/vault-runtime/registry.js`,
// contract §4 (Canonical VaultRegistry), §4.2 (snapshot semantics), §27 B7,
// §3.2/§42 SEC-MV02 (ID rule + authorization alias).
//
// What this file pins, all through the REAL Web entry points:
//   1. `listWebVaults()` set and ORDER == the canonical registry (`list()`), i.e.
//      primary first and then id code-unit order — deliberately replacing the
//      frozen BASE `localeCompare` order ("Zulu" before "alpha");
//   2. the Web ID rule == the canonical validator over one matrix, run twice (Web
//      create path vs `isValidVaultId`) with the documented Web trim;
//   3. `resolveWebVault()` roots come from the canonical descriptor;
//   4. two IDs on one canonical root are now refused (SEC-MV02) — the BASE behavior
//      registered both, which is why W0-F froze that gap;
//   5. `createWebVault()` refreshes the inventory explicitly (§4.2), so a new Vault
//      is listed immediately and a fresh import ("restart") sees it too.
//
// `vault-registry.js` reads `WEB_VAULTS_ROOT` at module load, so each topology below
// gets its own import (query-string cache buster). `VAULT` comes from `config.js`,
// which Node caches per process — a topology that needs a different primary root
// (the SEC-MV02 alias case) is therefore run in a subprocess, like W0-A does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { isValidVaultId } from "../src/vault-runtime/descriptor.js";
import { createVaultRegistry } from "../src/vault-runtime/registry.js";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const WEB_REGISTRY_RELATIVE = "src/app/vault-registry.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mv-b7-web-registry-"));
const vaultsRoot = path.join(root, "vaults");
const primaryRoot = path.join(root, "primary");
// Secondary samples chosen for the ordering ratchet: digits, uppercase, lowercase
// and CJK, so a locale-dependent comparison is visible ("Zulu" < "alpha" only in
// code-unit order).
const SECONDARY_IDS = Object.freeze(["10-notes", "Zulu", "alpha", "beta", "中文库"]);
const PRIMARY_ID = "dup";

await fs.mkdir(path.join(primaryRoot, ".obsidian"), { recursive: true });
for (const id of [...SECONDARY_IDS, ".hidden"]) {
  await fs.mkdir(path.join(vaultsRoot, id, ".obsidian"), { recursive: true });
}
// A non-directory entry must never become a Vault (canonical §4.2 skip reasons).
await fs.writeFile(path.join(vaultsRoot, "loose-file.md"), "# not a vault\n", "utf8");

process.env.VAULT_PATH = primaryRoot;
process.env.WEB_VAULTS_ROOT = vaultsRoot;
process.env.WEB_DEFAULT_VAULT = PRIMARY_ID;
process.env.DATA_PATH = path.join(root, "data");
process.env.HISTORY_PATH = path.join(root, "data", "history");
process.env.TRASH_PATH = path.join(root, "data", "trash");
process.env.WEB_CATALOG_ENABLED = "false";
process.env.OBSIDIAN_READ_ONLY = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";

let importSeq = 0;
const importWebRegistry = () => import(`../src/app/vault-registry.js?b7=${++importSeq}`);

/** Import the Web registry against a different vaults root (VAULT stays frozen). */
async function importWebRegistryWithRoot(absoluteRoot) {
  const configured = process.env.WEB_VAULTS_ROOT;
  process.env.WEB_VAULTS_ROOT = absoluteRoot;
  try {
    return await importWebRegistry();
  } finally {
    if (configured === undefined) delete process.env.WEB_VAULTS_ROOT;
    else process.env.WEB_VAULTS_ROOT = configured;
  }
}

const registry = await importWebRegistry();
after(() => fs.rm(root, { recursive: true, force: true }));

test("listWebVaults equals the canonical registry: primary first, then id code-unit order", async () => {
  const canonical = createVaultRegistry({ primaryRoot, primaryId: PRIMARY_ID, vaultsRoot, writable: true });
  await canonical.refresh();

  const inventory = await registry.listWebVaults();
  const webIds = inventory.vaults.map((vault) => vault.id);

  assert.deepEqual(webIds, canonical.list().map((vault) => vault.id), "Web inventory must be the canonical inventory");
  assert.deepEqual(webIds, [PRIMARY_ID, "10-notes", "Zulu", "alpha", "beta", "中文库"]);
  assert.deepEqual(inventory.vaults.filter((vault) => vault.primary).map((vault) => vault.id), [PRIMARY_ID], "exactly one primary, first");
  // BASE (frozen by W0-F) sorted secondaries with localeCompare; the canonical order
  // is code-unit, so uppercase "Zulu" now precedes lowercase "alpha".
  assert.ok(webIds.indexOf("Zulu") < webIds.indexOf("alpha"), "code-unit order, not localeCompare");
  assert.deepEqual([...webIds.slice(1)].sort(), ["10-notes", "Zulu", "alpha", "beta", "中文库"].sort());
  assert.equal(inventory.canCreate, true);
  assert.ok(!webIds.includes(".hidden"), "hidden entries are skipped");
  assert.ok(!webIds.includes("loose-file.md"), "non-directories are skipped");

  // The minimized Web record shape is unchanged (W0-F freeze): internal canonical
  // fields stay out of the Web surface.
  assert.deepEqual(Object.keys(inventory.vaults[0]).sort(), ["id", "name", "primary", "root", "writable"]);
  for (const vault of inventory.vaults) {
    assert.equal("canonicalRoot" in vault, false);
    assert.equal("dataKey" in vault, false);
    assert.equal("capabilities" in vault, false);
  }
});

test("resolveWebVault roots come from the canonical descriptor", async () => {
  const canonical = createVaultRegistry({ primaryRoot, primaryId: PRIMARY_ID, vaultsRoot, writable: true });
  await canonical.refresh();

  for (const descriptor of canonical.list()) {
    const vault = await registry.resolveWebVault(descriptor.id);
    assert.equal(vault.root, descriptor.root, `root of ${descriptor.id} must be the descriptor root`);
    assert.equal(vault.primary, descriptor.primary);
    assert.equal(vault.name, descriptor.name);
    assert.equal(vault.writable, descriptor.writable);
  }
  assert.equal((await registry.resolveWebVault("beta")).root, path.join(vaultsRoot, "beta"));
  assert.equal((await registry.resolveWebVault()).id, PRIMARY_ID, "the default id is the primary id");
  assert.equal(registry.defaultWebVaultId(), PRIMARY_ID);
  await assert.rejects(
    () => registry.resolveWebVault("missing-vault"),
    (error) => error.code === "ENOENT" && /Vault not found/.test(error.message),
  );
});

// One matrix, two runs: the Web create path and the canonical validator. Web keeps its
// historical `String(value || "").trim()` normalization (W0-F freeze), so the expected
// canonical verdict is `isValidVaultId(sample.trim())` — for " padded " the raw string
// is invalid while the trimmed one is accepted.
const ID_MATRIX = Object.freeze([
  ["vault", true, "plain ascii"],
  ["Main", true, "uppercase"],
  ["中文库", true, "CJK letters"],
  ["a b", true, "interior space"],
  ["a..b", true, "consecutive interior dots"],
  ["9", true, "single digit id"],
  [" padded ", true, "trimmed by the Web entry (documented asymmetry)"],
  [".", false, "reserved dot"],
  ["..", false, "reserved dot-dot"],
  ["", false, "empty"],
  [" ", false, "blank after trim"],
  [".hidden", false, "leading dot"],
  ["-a", false, "hyphen first"],
  ["(a)", false, "paren first"],
  ["a/b", false, "slash"],
  ["a\\b", false, "backslash"],
  ["a\u0000b", false, "NUL"],
  ["a".repeat(81), false, "81 code points"],
  ["emoji\u{1F600}", false, "emoji"],
]);

test("ID validation parity: Web create path === canonical validator (same matrix, both runs)", async () => {
  const idRoot = path.join(root, "id-matrix-vaults");
  await fs.mkdir(idRoot, { recursive: true }); // the Web startup path creates/list WEB_VAULTS_ROOT first
  const web = await importWebRegistryWithRoot(idRoot);
  assert.deepEqual((await web.listWebVaults()).vaults.map((vault) => vault.id), [PRIMARY_ID]);
  let checked = 0;

  for (const [sample, expected, note] of ID_MATRIX) {
    const normalized = String(sample).trim();
    assert.equal(isValidVaultId(normalized), expected, `canonical validator verdict for ${JSON.stringify(sample)} — ${note}`);
    let verdict;
    try {
      verdict = (await web.createWebVault(sample)).id;
    } catch (error) {
      verdict = `ERR:${error.message}`;
    }
    if (expected) assert.equal(verdict, normalized, `Web must accept ${JSON.stringify(sample)} — ${note}`);
    else assert.equal(verdict, "ERR:Invalid Vault name", `Web must reject ${JSON.stringify(sample)} — ${note}`);
    checked += 1;
  }

  assert.ok(checked >= 15, `matrix must hold at least 15 samples, has ${checked}`);
  // A valid id is also resolvable through the same entry point; an invalid one is not.
  assert.equal((await web.resolveWebVault("Main")).root, path.join(idRoot, "Main"));
  await assert.rejects(() => web.resolveWebVault("a/b"), (error) => error.code === "ENOENT");
});

test("createWebVault refreshes the inventory explicitly (no restart, no watcher)", async () => {
  const createRoot = path.join(root, "create-refresh-vaults");
  const web = await importWebRegistryWithRoot(createRoot);

  assert.deepEqual((await web.listWebVaults()).vaults.map((vault) => vault.id), [PRIMARY_ID]);

  const created = await web.createWebVault("Projects");
  assert.deepEqual(created, {
    id: "Projects",
    name: "Projects",
    root: path.join(createRoot, "Projects"),
    primary: false,
    writable: true,
  });
  assert.ok((await fs.stat(path.join(createRoot, "Projects", ".obsidian"))).isDirectory(), "the Web create layout is unchanged");

  // Visible immediately through the same module instance (§4.2 explicit refresh)...
  assert.deepEqual((await web.listWebVaults()).vaults.map((vault) => vault.id), [PRIMARY_ID, "Projects"]);
  assert.deepEqual(await web.resolveWebVault("Projects"), created);
  await assert.rejects(() => web.createWebVault("Projects"), /Vault already exists/);

  // ...and after a "restart" (fresh import) which rescans once at startup.
  const restarted = await importWebRegistryWithRoot(createRoot);
  assert.deepEqual((await restarted.listWebVaults()).vaults.map((vault) => vault.id), [PRIMARY_ID, "Projects"]);
});

test("two IDs on one canonical root are refused now (SEC-MV02; BASE registered both)", async () => {
  // Dedicated topology: the primary root IS a directory under the vaults root while
  // `WEB_DEFAULT_VAULT` names a different id, so `dup` and `alpha` share one real path.
  // BASE registered both ids (the SEC-MV02 authorization alias); the canonical registry
  // refuses the whole inventory instead of publishing an alias.
  const aliasRoot = path.join(root, "alias-vaults");
  await fs.mkdir(path.join(aliasRoot, "alpha", ".obsidian"), { recursive: true });
  await fs.mkdir(path.join(aliasRoot, "beta", ".obsidian"), { recursive: true });

  const code = [
    `import("./${WEB_REGISTRY_RELATIVE}").then(async (web) => {`,
    "  try {",
    "    const inventory = await web.listWebVaults();",
    '    console.log(JSON.stringify({ ok: true, ids: inventory.vaults.map((vault) => vault.id) }));',
    "  } catch (error) {",
    '    console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));',
    "  }",
    "});",
  ].join("\n");

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: APP_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      VAULT_PATH: path.join(aliasRoot, "alpha"),
      WEB_VAULTS_ROOT: aliasRoot,
      WEB_DEFAULT_VAULT: PRIMARY_ID,
      OBSIDIAN_READ_ONLY: "false",
    },
  });
  const result = JSON.parse(output.trim().split("\n").pop());
  assert.equal(result.ok, false, `an alias inventory must fail closed, got ${JSON.stringify(result)}`);
  assert.equal(result.code, "VAULT_ROOT_ALIAS");
  assert.match(result.message, /"dup" and "alpha" resolve to the same canonical root/);
});
