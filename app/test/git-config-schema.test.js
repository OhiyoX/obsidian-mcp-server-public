// Focused tests for the Wave A / A5 per-vault GitConfig schema
// (app/src/git-config/schema.js). Deterministic and pure: no I/O, no clock.
// Contract: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
// §15.1/§15.2 (shape + bounds), §15.4/§38.1 (inheritance), §42 SEC-MV04.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GIT_CONFIG_CODES,
  GIT_CONFIG_LIMITS,
  GIT_CONFIG_RECORD_DEFAULTS,
  GIT_CONFIG_RECORD_KEYS,
  GIT_CONFIG_SCHEMA,
  GIT_CONFIG_SOURCES,
  MAX_VAULT_RECORDS,
  buildGitConfigRecord,
  isGitConfigError,
  isValidGitConfigVaultId,
  normalizeGitConfigRecord,
  parseGitConfigDocument,
  resolveEffectiveGitConfig,
  serializeGitConfigDocument,
  validateGitConfigDocument,
} from "../src/git-config/schema.js";

const INSTANT = "2026-10-05T00:00:00.000Z";

function record(overrides = {}) {
  return buildGitConfigRecord({ patch: overrides, updatedAt: INSTANT });
}

function documentOf(revision, vaults) {
  return { schema: GIT_CONFIG_SCHEMA, revision, vaults };
}

const DATA_CODES = [GIT_CONFIG_CODES.INVALID_RECORD, GIT_CONFIG_CODES.LIMIT_EXCEEDED];

function rejectsData(error) {
  assert.equal(isGitConfigError(error), true, `expected a GitConfigError, got ${error?.name}: ${error?.message}`);
  assert.ok(DATA_CODES.includes(error.code), `unexpected code ${error.code}`);
  return true;
}

test("the document schema version and registry bound are frozen", () => {
  assert.equal(GIT_CONFIG_SCHEMA, 1);
  assert.equal(MAX_VAULT_RECORDS, 64);
  assert.equal(GIT_CONFIG_LIMITS.maxVaultRecords, MAX_VAULT_RECORDS);
  assert.equal(Object.isFrozen(GIT_CONFIG_RECORD_DEFAULTS), true);
  assert.deepEqual(GIT_CONFIG_RECORD_KEYS, [
    "enabled", "autoCommit", "autoPush", "autoCommitSweep", "debounceSeconds",
    "maxDelaySeconds", "sweepIntervalSeconds", "remote", "branch", "updatedAt",
  ]);
});

test("a fresh record is complete and canonical", () => {
  assert.deepEqual(record(), { ...GIT_CONFIG_RECORD_DEFAULTS, updatedAt: INSTANT });
  assert.deepEqual(Object.keys(record()), [...GIT_CONFIG_RECORD_KEYS]);
});

test("per-field matrix: valid values pass and out-of-contract values fail closed", async (t) => {
  const cases = [
    { field: "enabled", valid: [true, false], invalid: [1, 0, "true", null] },
    { field: "autoCommit", valid: [true, false], invalid: ["yes", {}, []] },
    { field: "autoPush", valid: [true, false], invalid: [1, "false", undefined] },
    { field: "autoCommitSweep", valid: [true, false], invalid: [null, 0, "sweep"] },
    { field: "debounceSeconds", valid: [5, 180, 86400], invalid: [4, 0, -1, 4.5, 86401, "180"] },
    { field: "maxDelaySeconds", valid: [1, 900, 86400], invalid: [0, -1, 86401, 1.5, "900"] },
    { field: "sweepIntervalSeconds", valid: [30, 900, 604800], invalid: [29, 0, 604801, 60.5, null] },
    { field: "updatedAt", valid: ["2026-10-05T00:00:00.000Z", "2026-10-05T08:00:00+08:00"], invalid: ["", "not-an-instant", 0, null] },
  ];
  for (const { field, valid, invalid } of cases) {
    await t.test(field, () => {
      for (const value of valid) {
        const normalized = normalizeGitConfigRecord({ ...record(), [field]: value });
        assert.deepEqual(normalized[field], field === "updatedAt" ? new Date(value).toISOString() : value);
      }
      for (const value of invalid) {
        assert.throws(() => normalizeGitConfigRecord({ ...record(), [field]: value }), rejectsData, `${field}=${String(value)}`);
      }
    });
  }
});

test("remote and branch accept only plain git names (no URL, no credentials, no dash prefix)", async (t) => {
  await t.test("remote", () => {
    for (const value of ["origin", "upstream", "group/remote", "a.b-c_d", "a".repeat(GIT_CONFIG_LIMITS.remoteMaxLength)]) {
      assert.equal(record({ remote: value }).remote, value);
    }
    const invalid = [
      "", "a".repeat(GIT_CONFIG_LIMITS.remoteMaxLength + 1),
      "https://x:y@host/r.git", "http://host/r.git", "ssh://host/r.git",
      "git@host:r.git", "host:path/r.git",
      "-oProxyCommand=touch /tmp/pwned", "-origin",
      "origin remote", "origin\tx", "origin\nx", "origin\u0000x", "origin\u007fx",
      "..", "a..b", "C:\\repo\\remote", "origin~1", "origin?x",
    ];
    for (const value of invalid) assert.throws(() => record({ remote: value }), rejectsData, `remote=${JSON.stringify(value)}`);
  });
  await t.test("branch", () => {
    for (const value of ["", "main", "feature/foo-2", "b".repeat(GIT_CONFIG_LIMITS.branchMaxLength)]) {
      assert.equal(record({ branch: value }).branch, value);
    }
    const invalid = [
      "b".repeat(GIT_CONFIG_LIMITS.branchMaxLength + 1),
      "-main", "main:other", "main\nx", "main x", "main..other", "main@host", "../main",
    ];
    for (const value of invalid) assert.throws(() => record({ branch: value }), rejectsData, `branch=${JSON.stringify(value)}`);
  });
});

test("unknown keys are rejected, never silently dropped (SEC-MV04)", () => {
  assert.throws(() => normalizeGitConfigRecord({ ...record(), token: "x" }), rejectsData);
  assert.throws(() => normalizeGitConfigRecord({ ...record(), password: "x" }), rejectsData);
  assert.throws(() => buildGitConfigRecord({ patch: { credential: "x" }, updatedAt: INSTANT }), rejectsData);
  assert.throws(() => validateGitConfigDocument({ ...documentOf(0, {}), extra: true }), (error) => {
    assert.equal(error.code, GIT_CONFIG_CODES.INVALID_DOCUMENT);
    return true;
  });
});

test("incomplete records and non-object input are rejected", () => {
  const { enabled, ...incomplete } = record();
  assert.equal(enabled, false);
  assert.throws(() => normalizeGitConfigRecord(incomplete), rejectsData);
  assert.throws(() => normalizeGitConfigRecord(null), rejectsData);
  assert.throws(() => normalizeGitConfigRecord([]), rejectsData);
  assert.throws(() => buildGitConfigRecord({ patch: "enabled=true", updatedAt: INSTANT }), rejectsData);
});

test("vaultId keys follow the store-side key guard", () => {
  for (const value of ["vault", "My Vault", "名字 1", "a-b_c.d (e)", "a".repeat(80)]) {
    assert.equal(isValidGitConfigVaultId(value), true, value);
  }
  for (const value of ["", ".", "..", "a/b", "a\\b", "a\u0000b", " vault", "a".repeat(81), 1, null, undefined]) {
    assert.equal(isValidGitConfigVaultId(value), false, String(value));
  }
  assert.throws(
    () => validateGitConfigDocument(documentOf(0, { "bad/id": record() })),
    (error) => {
      assert.equal(error.code, GIT_CONFIG_CODES.INVALID_VAULT_ID);
      return true;
    },
  );
});

test("the document envelope is bounded and versioned", () => {
  assert.deepEqual(validateGitConfigDocument(documentOf(3, { vault: record() })), documentOf(3, { vault: record() }));
  assert.throws(() => validateGitConfigDocument({ ...documentOf(0, {}), schema: 2 }), (error) => {
    assert.equal(error.code, GIT_CONFIG_CODES.UNSUPPORTED_SCHEMA);
    return true;
  });
  for (const revision of [-1, 1.5, "1", null]) {
    assert.throws(() => validateGitConfigDocument({ ...documentOf(0, {}), revision }), (error) => {
      assert.equal(error.code, GIT_CONFIG_CODES.INVALID_DOCUMENT);
      return true;
    });
  }
  assert.throws(() => validateGitConfigDocument(documentOf(0, [])), (error) => {
    assert.equal(error.code, GIT_CONFIG_CODES.INVALID_DOCUMENT);
    return true;
  });
  const full = Object.fromEntries(Array.from({ length: MAX_VAULT_RECORDS }, (_, index) => [`vault-${index}`, record()]));
  assert.equal(Object.keys(validateGitConfigDocument(documentOf(1, full)).vaults).length, MAX_VAULT_RECORDS);
  assert.throws(
    () => validateGitConfigDocument(documentOf(1, { ...full, overflow: record() })),
    (error) => {
      assert.equal(error.code, GIT_CONFIG_CODES.LIMIT_EXCEEDED);
      return true;
    },
  );
});

test("parse/serialize round trip is canonical and fails closed on corrupt input", () => {
  const payload = serializeGitConfigDocument(documentOf(7, { vault: record({ enabled: true }) }));
  assert.equal(payload.endsWith("}\n"), true);
  const parsed = parseGitConfigDocument(payload);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.document.revision, 7);
  assert.deepEqual(parsed.document, documentOf(7, { vault: record({ enabled: true }) }));

  for (const [name, raw, code] of [
    ["corrupt JSON", "{ nope", GIT_CONFIG_CODES.INVALID_DOCUMENT],
    ["unsupported schema", JSON.stringify({ ...documentOf(0, {}), schema: 3 }), GIT_CONFIG_CODES.UNSUPPORTED_SCHEMA],
    ["unknown key", JSON.stringify({ ...documentOf(0, {}), extra: 1 }), GIT_CONFIG_CODES.INVALID_DOCUMENT],
    ["secret field", JSON.stringify(documentOf(0, { vault: { ...record(), token: "x" } })), GIT_CONFIG_CODES.INVALID_RECORD],
    ["oversize", "x".repeat(GIT_CONFIG_LIMITS.fileBytes + 1), GIT_CONFIG_CODES.LIMIT_EXCEEDED],
  ]) {
    const result = parseGitConfigDocument(raw);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, code, name);
  }
});

test("inheritance matrix §38.1: primary/secondary x record/no record", async (t) => {
  const env = { enabled: true, autoCommit: true, autoPush: true, autoCommitSweep: true, debounceSeconds: 42, remote: "upstream", branch: "trunk" };
  const persisted = record({ enabled: true, autoCommit: true, debounceSeconds: 30, remote: "origin", branch: "main" });

  await t.test("primary + no record -> env-default", () => {
    const effective = resolveEffectiveGitConfig({ vaultId: "vault", primary: true, envDefaults: env });
    assert.equal(effective.source, GIT_CONFIG_SOURCES.ENV_DEFAULT);
    for (const [key, value] of Object.entries(env)) assert.equal(effective[key], value, key);
    assert.equal(effective.maxDelaySeconds, GIT_CONFIG_RECORD_DEFAULTS.maxDelaySeconds);
    assert.equal(effective.sweepIntervalSeconds, GIT_CONFIG_RECORD_DEFAULTS.sweepIntervalSeconds);
    assert.equal(effective.updatedAt, null);
    assert.equal(Object.isFrozen(effective), true);
  });

  await t.test("primary + no record + no env -> record defaults", () => {
    const effective = resolveEffectiveGitConfig({ vaultId: "vault", primary: true });
    assert.equal(effective.source, GIT_CONFIG_SOURCES.ENV_DEFAULT);
    assert.equal(effective.enabled, GIT_CONFIG_RECORD_DEFAULTS.enabled);
    assert.equal(effective.debounceSeconds, GIT_CONFIG_RECORD_DEFAULTS.debounceSeconds);
  });

  await t.test("primary + record -> persisted wins over env", () => {
    const effective = resolveEffectiveGitConfig({ vaultId: "vault", primary: true, record: record({ enabled: false, remote: "origin" }), envDefaults: env });
    assert.equal(effective.source, GIT_CONFIG_SOURCES.PERSISTED);
    assert.equal(effective.enabled, false);
    assert.equal(effective.autoCommit, false);
    assert.equal(effective.debounceSeconds, GIT_CONFIG_RECORD_DEFAULTS.debounceSeconds);
  });

  await t.test("secondary + no record -> default-disabled even when every env toggle is true", () => {
    const effective = resolveEffectiveGitConfig({ vaultId: "other", primary: false, envDefaults: env });
    assert.equal(effective.source, GIT_CONFIG_SOURCES.DEFAULT_DISABLED);
    assert.equal(effective.enabled, false);
    assert.equal(effective.autoCommit, false);
    assert.equal(effective.autoPush, false);
    assert.equal(effective.autoCommitSweep, false);
    assert.equal(effective.debounceSeconds, 42, "timing stays displayable");
    assert.equal(effective.remote, "upstream");
    assert.equal(effective.branch, "trunk");
  });

  await t.test("secondary + record -> persisted is honoured", () => {
    const effective = resolveEffectiveGitConfig({ vaultId: "other", primary: false, record: persisted, envDefaults: { enabled: false, autoCommit: false } });
    assert.equal(effective.source, GIT_CONFIG_SOURCES.PERSISTED);
    assert.equal(effective.enabled, true);
    assert.equal(effective.autoCommit, true);
    assert.equal(effective.updatedAt, INSTANT);
    assert.equal(effective.remote, "origin");
  });

  await t.test("invalid inputs fail closed", () => {
    assert.throws(() => resolveEffectiveGitConfig({ vaultId: "bad/id", primary: true }), (error) => {
      assert.equal(error.code, GIT_CONFIG_CODES.INVALID_VAULT_ID);
      return true;
    });
    assert.throws(() => resolveEffectiveGitConfig({ vaultId: "vault", primary: "yes" }), (error) => {
      assert.equal(error.code, GIT_CONFIG_CODES.INVALID_DOCUMENT);
      return true;
    });
    assert.throws(() => resolveEffectiveGitConfig({ vaultId: "vault", primary: true, envDefaults: { token: "x" } }), rejectsData);
    assert.throws(() => resolveEffectiveGitConfig({ vaultId: "vault", primary: true, envDefaults: { updatedAt: INSTANT } }), rejectsData);
    assert.throws(() => resolveEffectiveGitConfig({ vaultId: "vault", primary: true, envDefaults: { debounceSeconds: 0 } }), rejectsData);
    assert.throws(() => resolveEffectiveGitConfig({ vaultId: "vault", primary: true, envDefaults: { remote: "https://x:y@host/r.git" } }), rejectsData);
  });
});

function moduleSource(relative) {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("architecture gate: git-config modules never import config.js and never read process.env", () => {
  const configImport = /from\s+["'][^"']*config\.js["']/;
  for (const relative of ["../src/git-config/schema.js", "../src/git-config/store.js"]) {
    const source = moduleSource(relative);
    assert.doesNotMatch(source, configImport, relative);
    assert.doesNotMatch(source, /process\.env/, relative);
    assert.ok(source.length > 0, relative);
  }
  // Negative control: the matchers are not vacuous.
  const violating = 'import { VAULT } from "../config.js";\nconst enabled = process.env.GIT_ENABLED;\n';
  assert.match(violating, configImport);
  assert.match(violating, /process\.env/);
});
