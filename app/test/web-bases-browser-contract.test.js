// Node-only contract test for the Web Bases browser contract (Wave A / A5).
//
// No browser and no server: it pins the fixture file set, the checks module's
// exports, the scenario naming/phase contract, the `--list` coverage of TODO
// §15.8 items 1-17, and the Wave C registration snippet.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWebBasesFixtureVault,
  WEB_BASES_MAIN_VAULT_ID,
  WEB_BASES_SECONDARY_VAULT_ID,
  WEB_BASES_DENIED_VAULT_ID,
} from '../scripts/web-bases-fixtures.mjs';
import {
  registerWebBasesChecks,
  listWebBasesScenarios,
  WEB_BASES_SCENARIOS,
  WEB_BASES_SECTION_ITEMS,
  WAVE_C_REGISTRATION_SNIPPET,
} from '../scripts/web-bases-checks.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(appRoot, 'scripts', 'run-web-bases-checks.mjs');
const VALID_PHASES = ['characterization', 'full'];
const SECTION_ITEMS = Array.from({ length: 17 }, (_value, index) => index + 1);

function withFixture(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-bases-fixture-test-'));
  try {
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fixture builder creates the synthetic multi-Vault file set', async () => {
  await withFixture(async (root) => {
    const fixtures = await createWebBasesFixtureVault(root);
    assert.equal(fixtures.vaultId, WEB_BASES_MAIN_VAULT_ID);
    assert.equal(fixtures.secondaryVaultId, WEB_BASES_SECONDARY_VAULT_ID);
    assert.equal(fixtures.deniedVaultId, WEB_BASES_DENIED_VAULT_ID);
    assert.equal(fixtures.serverEnv.WEB_VAULTS_ROOT, root);
    assert.equal(fixtures.serverEnv.WEB_DEFAULT_VAULT, WEB_BASES_MAIN_VAULT_ID);

    const exists = (vaultRoot, relative) => fs.existsSync(path.join(vaultRoot, ...relative.split('/')));
    // Supported and unsupported .base documents, plus the case/hidden edge cases.
    for (const relative of [
      fixtures.files.projectBase,
      fixtures.files.filesBase,
      fixtures.files.xssBase,
      fixtures.files.unsupportedFormulaBase,
      fixtures.files.unsupportedFilterBase,
      fixtures.files.uppercaseBase,
      fixtures.files.hiddenBase,
      fixtures.files.mixedBase,
    ]) {
      assert.ok(exists(fixtures.vault, relative), `missing primary base: ${relative}`);
    }
    // Target Markdown notes across the directory hierarchy.
    for (const relative of [
      fixtures.files.readmeNote,
      fixtures.files.payloadNote,
      fixtures.files.alphaNote,
      fixtures.files.deltaNote,
      fixtures.files.plainNote,
      fixtures.files.hiddenNote,
    ]) {
      assert.ok(exists(fixtures.vault, relative), `missing primary note: ${relative}`);
    }
    // Same-named Base in the secondary Vault and a denied Vault.
    assert.ok(exists(fixtures.secondaryVault, fixtures.files.secondaryBase), 'secondary Project.base missing');
    assert.ok(exists(fixtures.secondaryVault, fixtures.files.secondaryNote), 'secondary note missing');
    assert.ok(exists(fixtures.deniedVault, fixtures.files.deniedBase), 'denied Secret.base missing');

    // The generated XSS payload files contain the hostile strings but never the
    // marker assignment outside a payload.
    const xss = fs.readFileSync(path.join(fixtures.vault, fixtures.files.xssBase), 'utf8');
    assert.ok(xss.includes(fixtures.xss.marker));
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.startsWith('vault')).sort(),
      [WEB_BASES_MAIN_VAULT_ID, WEB_BASES_SECONDARY_VAULT_ID, WEB_BASES_DENIED_VAULT_ID].sort(),
    );
  });
});

test('checks module exports the registration API and a Wave C snippet', () => {
  assert.equal(typeof registerWebBasesChecks, 'function');
  assert.equal(typeof listWebBasesScenarios, 'function');
  assert.equal(typeof WAVE_C_REGISTRATION_SNIPPET, 'string');
  assert.match(WAVE_C_REGISTRATION_SNIPPET, /registerWebBasesChecks/);
  assert.match(WAVE_C_REGISTRATION_SNIPPET, /web-bases-checks\.mjs/);
  assert.match(WAVE_C_REGISTRATION_SNIPPET, /web-bases-fixtures\.mjs/);
});

test('every scenario has a unique name, id and a valid phase tag', () => {
  const names = new Set();
  const ids = new Set();
  for (const scenario of WEB_BASES_SCENARIOS) {
    assert.ok(typeof scenario.name === 'string' && scenario.name.length > 0);
    assert.ok(!names.has(scenario.name), `duplicate scenario name: ${scenario.name}`);
    names.add(scenario.name);
    assert.ok(!ids.has(scenario.id), `duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(VALID_PHASES.includes(scenario.phase), `invalid phase for ${scenario.id}: ${scenario.phase}`);
    assert.ok(Number.isInteger(scenario.item) && scenario.item >= 1 && scenario.item <= 17);
  }
  assert.ok(WEB_BASES_SCENARIOS.length >= 17);
});

test('the scenario set covers TODO §15.8 items 1-17 in both phases', () => {
  assert.deepEqual([...WEB_BASES_SECTION_ITEMS].sort((a, b) => a - b), SECTION_ITEMS);
  for (const item of SECTION_ITEMS) {
    for (const phase of VALID_PHASES) {
      const matches = WEB_BASES_SCENARIOS.filter((scenario) => scenario.item === item && scenario.phase === phase);
      assert.equal(matches.length, 1, `item ${item} needs exactly one ${phase} scenario`);
    }
  }
});

test('registerWebBasesChecks registers the phase-scoped scenarios without a browser', async () => {
  const stubContext = (phase) => {
    const registered = [];
    return {
      registered,
      context: {
        check: (name, fn) => {
          assert.equal(typeof name, 'string');
          assert.equal(typeof fn, 'function');
          registered.push(name);
        },
        page: { request: {}, on() {}, off() {} },
        serverUrl: 'http://127.0.0.1:1',
        phase,
        fixtures: { vault: '/tmp/vault', vaultId: 'vault', files: {} },
      },
    };
  };
  for (const phase of VALID_PHASES) {
    const { registered, context } = stubContext(phase);
    const ids = await registerWebBasesChecks(context);
    assert.equal(registered.length, 17, `${phase} must register 17 checks`);
    assert.equal(ids.length, 17);
    const expected = listWebBasesScenarios(phase).map((scenario) => scenario.name);
    assert.deepEqual(registered, expected);
  }
  await assert.rejects(() => registerWebBasesChecks({ check() {}, page: {}, serverUrl: 'x', fixtures: {}, phase: 'nope' }), /unknown phase/);
});

test('--list prints all §15.8 items and exits 0 without a browser runtime', () => {
  const result = spawnSync(process.execPath, [runner, '--list'], {
    cwd: appRoot,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_MODULE: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}`;
  for (const item of SECTION_ITEMS) {
    assert.match(output, new RegExp(`§15\\.8\\.${item}\\b`), `--list must mention §15.8.${item}`);
  }
  assert.match(output, /scenario-count: 34/);
  assert.match(output, /section-items: 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17/);
  assert.match(output, /characterization/);
  assert.match(output, /full/);
});

test('runner exits 2 with a clear message when the Playwright runtime is unavailable', () => {
  const result = spawnSync(process.execPath, [runner, '--phase=characterization'], {
    cwd: appRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Point at a path that cannot exist so the import fails deterministically.
      PLAYWRIGHT_MODULE: path.join(os.tmpdir(), 'definitely-missing-playwright', 'index.mjs'),
    },
  });
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}\n${result.stderr}`);
  assert.match(`${result.stderr}`, /runtime unavailable/);
});
