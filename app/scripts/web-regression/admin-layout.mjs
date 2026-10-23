// Admin plane browser gate — the one entry the Web regression suite calls.
//
// **Rewritten 2026-10-18 (lane w5-gates).** The previous revision was the Admin UI v2 layout gate:
// its criteria were real (column floors, mid-word breaks, badge size, primary-button paint, panel
// placement) but every one of them was expressed in the vocabulary of the deleted implementation
// (`table.data-table`, `td.col-actions`, `.card.metric`, `[data-capability]`, `.col-vault`, `.tabs`,
// `#vault-git details.card`). The Admin plane was rebuilt on the prototype
// (`docs/admin-ui-proto/`), so this module now:
//
//   1. registers the **prototype-parity gate** (`scripts/proto-parity/gate.mjs`), which compares
//      every page against the running prototype — columns, required elements, `?id=` drawer field
//      inventory, paint, no-JS rendering, shell navigation, capability-chip bounds — and proves its
//      own discrimination with three in-gate negative controls;
//   2. keeps the three defect criteria that outlived the rewrite, re-anchored to the prototype's
//      vocabulary: the mid-word contract over `.tbl` cells, the capability picker's
//      filter-keeps-selection contract, and the real-MCP pending-author regression;
//   3. owns the fixture (scratch Vault + real Git repo + real server) and its teardown evidence.
//
// Criteria that were retired rather than re-anchored (`Vault 8-column summary`, `7em` column floor
// declaration, the v2 window-presentation scene, the v2 badge selector) are recorded in
// the prototype markup, with the reason and where the surviving half now lives.
//
// Standalone entry (no Web build, no credentials): `node scripts/run-admin-layout-checks.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startAdminLayoutFixture } from './admin-layout-fixture.mjs';
import { protoUrl as protoFileUrl, registerProtoParityChecks } from '../proto-parity/gate.mjs';
import { PARITY_PAGES } from '../proto-parity/spec.mjs';
import { registerMidwordChecks } from './admin-layout-midword.mjs';
import { registerCapabilityPickerCheck } from './admin-layout-capq.mjs';
import { registerPendingAuthorCheck } from './admin-layout-author.mjs';
import { registerInteractionChecks } from './admin-layout-interaction.mjs';
import { registerProtoShapeChecks } from '../proto-parity/shape-gate.mjs';
import { registerSecurityChecks } from './admin-layout-security.mjs';
import { registerNoScriptChecks } from './admin-layout-noscript.mjs';
import { registerDesignChecks } from './admin-layout-design.mjs';

const VAULTS_URL = '/admin/auth/vault-git';
const AUTHZ_URL = '/admin/auth/access-policy';

export async function registerAdminLayoutChecks(ctx) {
  const { check, sleep, browser, root, appRoot, serverErrors, outputRoot } = ctx;
  const fixture = await startAdminLayoutFixture({ root, appRoot, serverErrors });
  const trace = { startedAt: new Date().toISOString(), fixture: { gitRepo: fixture.gitRepo, gitReason: fixture.gitReason }, phases: [] };
  const tracePhase = (name, data) => { trace.phases.push({ name, at: new Date().toISOString(), ...data }); };

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const base = fixture.base;
  const repoRoot = path.resolve(appRoot, '..');
  const goto = async (url) => {
    await page.goto(`${base}${url}`, { waitUntil: 'load' });
    await page.evaluate('document.fonts ? document.fonts.ready : true');
    await sleep(80);
  };
  /** The prototype is the same page for every scene; one file:// load per hash route. */
  const gotoProto = async (hash) => {
    await page.goto(protoFileUrl(repoRoot, hash), { waitUntil: 'load' });
    await page.evaluate('document.fonts ? document.fonts.ready : true');
    await sleep(80);
  };
  /** POST a real HTML form body (Playwright's `form` helper cannot send repeated keys). */
  const postForm = async (url, fields) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields || {})) {
      for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item ?? ''));
    }
    return page.request.post(`${base}${url}`, {
      data: params.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
    });
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch { /* keep waiting */ }
      if (fixture.child.exitCode !== null) break;
      await sleep(100);
    }
    assert.ok(ready, 'the Admin layout fixture server must become ready');
    const login = await page.request.post(`${base}/admin/auth/login`, { form: { password: fixture.password }, maxRedirects: 0 });
    assert.equal(login.status(), 303, 'the Admin layout fixture login must succeed');

    // 1. prototype parity: structure / paint / negative controls / no-JS / shell.
    const parity = await registerProtoParityChecks({ check, browser, appRoot, root, outputRoot, fixture });
    trace.parity = parity.comparison.failures.length;

    // 2. the migrated defect criteria (prototype vocabulary, same judgments). The mid-word scene
    // measures BOTH trees: a criterion that only ever runs on one side cannot tell a real break
    // from a measurement artefact (lane w5-gates-fix).
    // 2b. the full-DOM **shape** gate (Wave P): the same normalized skeleton on both trees for every
    // page state, plus its own negative controls. `gate.mjs` compares chosen criteria (selectors,
    // columns, geometry) and was blind to "a whole region is extra" / "the control kind changed";
    // this is the补强 that sees them.
    await registerProtoShapeChecks({ ...ctx, fixture });
    await registerMidwordChecks(ctx, {
      page, goto, gotoProto, tracePhase,
      tablePages: PARITY_PAGES.filter((entry) => entry.table).map((entry) => ({ id: entry.id, live: entry.live, proto: entry.proto })),
    });
    await registerCapabilityPickerCheck(ctx, { page, goto, postForm, tracePhase, authzListUrl: AUTHZ_URL });
    await registerPendingAuthorCheck(ctx, {
      page, goto, sleep, tracePhase, base, apiKey: fixture.apiKey,
      gitRepo: fixture.gitRepo, gitReason: fixture.gitReason, vaultsUrl: VAULTS_URL,
    });

    // 3. D0 interaction gate (lane l4-gates): JS-on behaviour parity against the running prototype,
    // the CSP/script policy, the fragment fetch path and the injection surface. The scene owns its
    // own contexts, so the shared `page` above is left exactly as the migrated criteria expect it.
    await registerInteractionChecks(ctx, { browser, fixture, repoRoot, protoUrl: protoFileUrl, outputRoot, tracePhase });
    // Wave R: the two items that are USER DECISIONS rather than prototype parity (the self-drawn
    // select and the narrow-screen menu) plus the preview-card height fix. Kept in their own scene so
    // the parity criteria are not asked to judge something the prototype deliberately does not have.
    await registerDesignChecks(ctx, { browser, fixture, repoRoot, protoUrl: protoFileUrl, outputRoot, tracePhase });
    await registerSecurityChecks(ctx, { browser, fixture, outputRoot, tracePhase });
    await registerNoScriptChecks(ctx, { browser, fixture, root, appRoot, serverErrors, outputRoot, tracePhase });

    // 4. teardown is itself a criterion (a leaked child, port or scratch dir is cross-scene noise).
    await context.close().catch(() => {});
    const shutdown = await fixture.stop();
    tracePhase('fixture-stop', shutdown);
    await check('admin-layout: no page error, no server error, and the fixture releases its process, port and scratch directory', async () => {
      assert.deepEqual(pageErrors, []);
      const fatal = serverErrors.filter((line) => /unhandled|UnhandledPromiseRejection|TypeError|ReferenceError/.test(line));
      assert.deepEqual(fatal, []);
      assert.equal(shutdown.childExited, true, `the fixture child must be reaped: ${JSON.stringify(shutdown)}`);
      assert.equal(shutdown.portReleased, true, `the fixture port must be free after the run: ${JSON.stringify(shutdown)}`);
      assert.equal(shutdown.fixtureRootRemoved, true, `the fixture scratch directory must be gone: ${JSON.stringify(shutdown)}`);
    });
  } finally {
    await fs.writeFile(path.join(outputRoot, 'admin-layout-trace.json'), JSON.stringify(trace, null, 2)).catch(() => {});
    await context.close().catch(() => {});
    await fixture.stop();
  }
}
