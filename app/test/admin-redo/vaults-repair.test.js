// Lane W4-vaults — the Git config store repair path (`POST <base>/repair`).
//
// Contract (owner decision 2026-10-18; prototype `docs/admin-ui-proto/src/5-render.js:468` and the
// danger modal `src/6-app.js:351`):
//   * only a broken store may be repaired — a readable one is a 409 and is never overwritten;
//   * nothing is deleted: the corrupt file is renamed into an isolation slot and the path is shown;
//   * an isolation failure is a 503 with zero writes (fail closed);
//   * the confirm text is checked on the SERVER; a browser `disabled` is not a gate;
//   * success and refusal each record exactly one audit entry without the stored document;
//   * no script, no inline handler, no `data-act`.
//
// Two layers, both real: the store over a temporary directory (isolation, zero-write refusals,
// rollback) and the express router over that same store (status codes, CSRF, confirm gate, audit).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { GIT_CONFIG_REPAIR_CODES, createGitConfigStore } from "../../src/git-config/store.js";
import { GIT_CONFIG_CODES } from "../../src/git-config/schema.js";
import { REPAIR_CONFIRM_TEXT, renderVaultsPage } from "../../src/admin/pages/vaults.js";
import { renderAuthShell } from "../../src/admin/pages/shell.js";
import {
  REPAIR_AUDIT_ACTION,
  VAULT_GIT_REPAIR_CODES,
  registerVaultGitRoutes,
  resolveActions,
  statusForCode,
} from "../../src/admin/routes/vault-git.js";
import { listenFetchSafeOrigin } from "../../scripts/fetch-safe-listen.mjs";

// D0 (approved 2026-10-18) script policy, in one place:
//   * a fragment (a page module's content) renders no script at all;
//   * an authenticated document renders exactly one same-origin, whitelisted enhancement module;
//   * neither may contain an inline handler or a javascript: URL.
const D0_MODULE_SCRIPT = /^<script type="module" src="\/admin\/auth\/assets\/[a-z-]+\.js"><\/script>$/i;
function assertConfirmInputBound(html, label) {
  const input = /<input[^>]*name="confirm"[^>]*>/.exec(html)?.[0] ?? "";
  const bound = /\bform="([^"]+)"/.exec(input)?.[1] ?? null;
  if (bound) {
    assert.ok(html.includes(`<form id="${bound}"`), `${label}: the input names form id ${bound}, which must exist`);
    return;
  }
  const index = html.indexOf('name="confirm"');
  for (const match of html.matchAll(/<form\b[^>]*>/g)) {
    const start = match.index ?? 0;
    const closes = html.indexOf("</form>", start);
    if (closes > 0 && index > start && index < closes) return;
  }
  assert.fail(`${label}: the input must belong to the POST form (inside it, or bound by form=)`);
}

function assertScriptPolicy(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>(?:<\/script>)?/gi)].map((match) => match[0]);
  if (scripts.length > 0) {
    assert.equal(scripts.length, 1, "no script beyond the one whitelisted same-origin module");
    assert.match(scripts[0], D0_MODULE_SCRIPT, "the single script is the whitelisted same-origin module");
  }
  assert.doesNotMatch(html, /[\s"']on(?:click|change|input|submit|load|error|mouseover|focus|blur|toggle|keydown|keyup)\s*=/i, "no inline event handlers");
  assert.doesNotMatch(html, /javascript:/i, "no javascript: URLs");
}



const CSRF = "csrf-token-for-repair-tests";
const BASE = "/admin/auth/vault-git";
const ACTIONS = Object.freeze({ base: BASE, save: `${BASE}/save`, refresh: `${BASE}/refresh`, verify: `${BASE}/verify`, repair: `${BASE}/repair` });
/** The exact bytes the operator's broken file holds — must survive the repair untouched. */
const CORRUPT = '{ "schema": 1, "revision": 2, "vaults": { "default": { "enabled": tru';
const VALID_DOCUMENT = JSON.stringify({ schema: 1, revision: 4, vaults: {} }, null, 2);

// ------------------------------------------------------------------ fixtures --

/** A temporary data root plus a helper to read what a repair left behind. */
async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "w4-repair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
  const file = path.join(root, "git-vaults.json");
  return {
    root,
    file,
    write: (text) => fs.writeFile(file, text),
    read: () => fs.readFile(file, "utf8"),
    exists: async (target = file) => fs.stat(target).then(() => true, () => false),
    /** Every isolation slot the repair created (`<file>.<ISO>-<hex>.broken`). */
    isolated: async () => (await fs.readdir(root)).filter((name) => name.startsWith("git-vaults.json.") && name.endsWith(".broken")),
    /** Every leftover temp file — a repair must never leave one behind. */
    temps: async () => (await fs.readdir(root)).filter((name) => name.startsWith(".git-vaults.")),
  };
}

/** `fs/promises` with one failing call, so a store can be driven into a refusal deterministically. */
function ioWith({ rename, open } = {}) {
  return {
    ...fs,
    ...(rename ? { rename } : {}),
    ...(open ? { open } : {}),
  };
}

function record(overrides = {}) {
  return {
    enabled: true, autoCommit: true, autoPush: true, autoCommitSweep: false,
    debounceSeconds: 30, maxDelaySeconds: 300, sweepIntervalSeconds: 900,
    remote: "origin", branch: "main", updatedAt: "2026-10-17T10:00:00.000Z",
    ...overrides,
  };
}

/** The page model the real service would produce for this store snapshot (broken ⇒ no config). */
function modelFor(store) {
  const snapshot = store.snapshot();
  const ready = snapshot.status === "ready";
  return {
    vaults: [{
      id: "default",
      name: "主库",
      primary: true,
      writable: true,
      root: "/data/vaults/default",
      canonicalRoot: "/data/vaults/default",
      editable: ready,
      admission: { admission: "approved", status: "ready", reason: null, generation: 1, servable: true },
      capabilities: [{ key: "git", available: true, reason: null }],
      git: {
        state: ready ? "disabled" : null,
        repository: null,
        configSource: ready ? "default-disabled" : null,
        configError: null,
        config: record({ enabled: false, autoCommit: false, autoPush: false }),
        pending: { count: 0, paths: [], authors: [], since: null },
        dirty: null,
        timers: null,
        lastSweep: null,
        push: null,
      },
    }],
    revision: snapshot.revision,
    status: snapshot.status,
    broken: ready ? null : { errorCode: snapshot.errorCode ?? null },
    defaultVaultId: "default",
    notice: null,
    admission: null,
  };
}

function stubAdmin(store) {
  return {
    async model() {
      return modelFor(store);
    },
    async save() {
      throw new Error("the repair tests never save");
    },
    async refreshInventory() {
      return { ok: true, notice: "refreshed" };
    },
    async verify() {
      return { ok: true, notice: "verified" };
    },
  };
}

function auditSink() {
  const events = [];
  return { events, provider: { recordAudit: (event) => events.push(event) } };
}

async function startServer(t, { store, provider = null, repairStore = store, admin = stubAdmin(store) }) {
  const app = express();
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "32kb" }));
  router.use((req, _res, next) => { req.adminSession = { id: "session", csrf: CSRF }; next(); });
  const requireAdmin = (_req, _res, next) => next();
  const requireCsrf = (req, res, next) => (req.body?.csrf === CSRF ? next() : res.status(403).send("csrf rejected"));
  const registered = registerVaultGitRoutes(router, {
    admin,
    requireAdmin,
    requireCsrf,
    view: { renderAuthShell: (options) => renderAuthShell(options) },
    ...(provider ? { provider } : {}),
    ...(repairStore ? { gitConfigStore: repairStore } : {}),
  });
  app.use("/admin/auth", router);
  const server = http.createServer(app);
  const origin = await listenFetchSafeOrigin(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin, registered };
}

async function get(origin, target) {
  const response = await fetch(`${origin}${target}`, { redirect: "manual" });
  return { status: response.status, body: await response.text() };
}

async function post(origin, target, form) {
  const response = await fetch(`${origin}${target}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: await response.text() };
}

/** Everything the broken page + confirm page must carry. Shared with the negative control. */
function checkRepairSurface(html) {
  assert.ok(html.includes('<div class="banner danger">'), "broken store keeps the danger banner");
  assert.ok(html.includes("Git 配置存储不可用"), "banner headline");
  assert.ok(html.includes("重置为默认并修复…"), "the prototype's CTA label");
  assert.ok(html.includes(`href="${BASE}?confirm=repair"`), "the CTA is a GET link (no script, no data-act)");
  assertScriptPolicy(html);
  assert.equal(/\son[a-z]+=/i.test(html), false, "no inline event handler");
  assert.equal(/data-act=|data-open=|data-menu=/.test(html), false, "no JS hooks");
  for (const [, body] of html.matchAll(/<form\b[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/g)) {
    assert.ok(body.includes('name="csrf"'), "every POST form carries the CSRF field");
  }
}

/** The confirm page's own contract. */
function checkConfirmPage(html) {
  assert.ok(html.includes('<div class="modal show" role="alertdialog"'), "the danger modal is the GET state");
  assert.ok(html.includes("重置 Git 配置存储？"), "prototype modal title (6-app.js:351)");
  assert.ok(html.includes(`action="${ACTIONS.repair}"`), "the modal posts to the repair route");
  assert.ok(html.includes('name="confirm"'), "type-to-confirm input");
  assert.ok(html.includes(`<code>${REPAIR_CONFIRM_TEXT}</code>`), "the prompt names the exact text the server checks");
  assert.ok(html.includes("隔离"), "the modal states that the corrupt file is isolated, not deleted");
  assert.equal(/type="submit"[^>]*disabled/.test(html), false, "the submit is not disabled: no-script users must be able to submit");
  // Regression: the input must be ASSOCIATED WITH the form. `ui.confirmPage` used to render it outside
  // any form, which submits an empty `confirm` in a scriptless browser and turns every repair into a
  // 403. The prototype keeps the input as a direct child of `.modal` (above the button row) and the
  // JS-off gate compares those children element by element, so the association is the standard
  // `form="<id>"` attribute rather than DOM nesting: either shape satisfies this check, but the input
  // must belong to the repair form.
  assertConfirmInputBound(html, "the repair confirm");
  checkRepairSurface(html);
}

// -------------------------------------------------------------- store layer --

test("store: repair isolates the corrupt file and resets to an empty A5 document", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root, clock: () => new Date("2026-10-18T07:30:00.000Z") });
  await store.ready;
  assert.equal(store.snapshot().status, "broken", "the fixture really is a broken store");
  await assert.rejects(() => store.read(), "a broken store still fails closed before the repair");

  const result = await store.repair();
  assert.equal(result.ok, true);
  assert.equal(result.revision, 0, "a reset store is at revision 0, exactly like a pristine one");
  assert.equal(store.snapshot().status, "ready", "memory moved to ready");
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual({ ...store.snapshot().vaults }, {}, "no records survive a reset");

  const slots = await dir.isolated();
  assert.equal(slots.length, 1, "exactly one isolation slot was created");
  assert.match(slots[0], /^git-vaults\.json\.2026-10-18T07-30-00-000Z-[0-9a-f]{6}\.broken$/, "ISO timestamp + unique tail");
  assert.equal(result.isolatedPath, path.join(dir.root, slots[0]), "the reported path is the real slot");
  assert.equal(await fs.readFile(path.join(dir.root, slots[0]), "utf8"), CORRUPT, "the corrupt content is preserved byte for byte");

  assert.deepEqual(JSON.parse(await dir.read()), { schema: 1, revision: 0, vaults: {} }, "the new document satisfies the A5 schema");
  assert.deepEqual(await dir.temps(), [], "no temp file is left behind");

  // The store's own write path still works afterwards: CAS from the reset revision.
  const written = await store.upsertVault("default", { enabled: true }, { expectedRevision: 0 });
  assert.equal(written.ok, true);
  assert.equal(written.revision, 1, "the reset revision is a valid CAS base");
  assert.equal(JSON.parse(await dir.read()).vaults.default.enabled, true);
});

test("store: a readable store is never repaired and never rewritten (409 source)", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(JSON.stringify({ schema: 1, revision: 3, vaults: {} }, null, 2));
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  const before = await dir.read();

  const result = await store.repair();
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_CONFIG_REPAIR_CODES.NOT_NEEDED);
  assert.equal(await dir.read(), before, "healthy configuration is byte-identical after the refusal");
  assert.deepEqual(await dir.isolated(), [], "nothing was isolated");
  assert.equal(store.snapshot().status, "ready");
  assert.equal(store.snapshot().revision, 3, "the committed revision is untouched");
});

test("store: a file fixed outside the process is adopted, not thrown away", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  assert.equal(store.snapshot().status, "broken");

  await dir.write(VALID_DOCUMENT);
  const result = await store.repair();
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_CONFIG_REPAIR_CODES.NOT_NEEDED);
  assert.equal(store.snapshot().status, "ready", "the externally repaired document is adopted");
  assert.equal(store.snapshot().revision, 4);
  assert.equal(await dir.read(), VALID_DOCUMENT, "no write happened on the adoption path");
  assert.deepEqual(await dir.isolated(), [], "an external fix is never isolated");
});

test("store: an isolation failure is a 503-class refusal with zero writes", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({
    dataRoot: dir.root,
    io: ioWith({ rename: async () => { throw new Error("EPERM"); } }),
  });
  await store.ready;

  const result = await store.repair();
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_CONFIG_REPAIR_CODES.ISOLATE_FAILED);
  assert.equal(await dir.read(), CORRUPT, "the corrupt file is untouched");
  assert.deepEqual(await dir.isolated(), [], "nothing was isolated");
  assert.deepEqual(await dir.temps(), [], "zero writes: not even a temp file");
  assert.equal(store.snapshot().status, "broken", "memory stays broken");
});

test("store: a failed reset write rolls the isolated file back and keeps the store broken", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  // Isolation succeeds; the empty-document write fails (its temp file cannot be renamed into place).
  const store = createGitConfigStore({
    dataRoot: dir.root,
    io: ioWith({
      rename: async (from, to) => {
        if (String(from).includes(".git-vaults.")) throw new Error("EIO");
        return fs.rename(from, to);
      },
    }),
  });
  await store.ready;

  const result = await store.repair();
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_CONFIG_CODES.STORE_IO);
  assert.equal(await dir.read(), CORRUPT, "the corrupt file was put back");
  assert.deepEqual(await dir.isolated(), [], "no orphan isolation slot is left behind");
  assert.equal(store.snapshot().status, "broken");
  assert.equal(result.isolatedPath, undefined, "a rolled-back repair reports no isolation path");
});

test("store: when the rollback also fails the isolation path is reported instead of losing track", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  // Isolation succeeds; every rename that targets the document itself fails, so neither the reset
  // write nor the put-back can land. The content must still be findable, and reported.
  const store = createGitConfigStore({
    dataRoot: dir.root,
    io: ioWith({ rename: async (from, to) => {
      if (String(to).endsWith("git-vaults.json") || String(from).includes(".git-vaults.")) throw new Error("EIO");
      return fs.rename(from, to);
    } }),
  });
  await store.ready;

  const result = await store.repair();
  assert.equal(result.ok, false);
  assert.equal(result.code, GIT_CONFIG_CODES.STORE_IO);
  assert.equal(typeof result.isolatedPath, "string", "the stranded isolation slot is reported");
  assert.equal(await fs.readFile(result.isolatedPath, "utf8"), CORRUPT, "the corrupt content is preserved there");
  assert.equal(await dir.exists(), false, "no readable document was left at the store path");
  assert.equal(store.snapshot().status, "broken");
});

// --------------------------------------------------------------- page layer --

test("page: the broken state carries the repair CTA and the ?confirm=repair modal", () => {
  const store = { snapshot: () => ({ status: "broken", revision: null, vaults: {}, errorCode: "git_config_invalid_document" }) };
  const brokenModel = modelFor(store);
  const page = (query = {}, repairWired = true) => {
    const rendered = renderVaultsPage({ vaultGit: { wired: true, model: brokenModel, error: null }, csrf: CSRF, actions: ACTIONS, query, repairWired });
    return rendered.content + rendered.detailPanel;
  };

  const list = page();
  checkRepairSurface(list);
  assert.equal(list.includes('<div class="modal show"'), false, "no modal without ?confirm=repair");

  const confirm = page({ confirm: "repair" });
  checkConfirmPage(confirm);
  assert.ok(confirm.includes("git_config_invalid_document"), "the frozen store code is still shown");

  // A healthy store never renders the reset dialog, even with the query string.
  const healthy = modelFor({ snapshot: () => ({ status: "ready", revision: 2, vaults: {} }) });
  const healthyPage = renderVaultsPage({ vaultGit: { wired: true, model: healthy, error: null }, csrf: CSRF, actions: ACTIONS, query: { confirm: "repair" }, repairWired: true });
  assert.equal(healthyPage.content.includes("modal show"), false, "nothing to repair ⇒ no confirm page");
  assert.equal(healthyPage.content.includes("重置为默认并修复…"), false, "nothing to repair ⇒ no CTA");
});

test("page: without a wired store the CTA is absent and the copy stays honest", () => {
  const brokenModel = modelFor({ snapshot: () => ({ status: "broken", revision: null, vaults: {}, errorCode: "git_config_invalid_document" }) });
  const rendered = renderVaultsPage({ vaultGit: { wired: true, model: brokenModel, error: null }, csrf: CSRF, actions: ACTIONS, query: { confirm: "repair" }, repairWired: false });
  assert.equal(rendered.content.includes("重置为默认并修复…"), false, "no fake CTA in an unwired deployment");
  assert.equal(rendered.content.includes("modal show"), false, "no confirm page either");
  assert.ok(rendered.content.includes("本部署没有网页「重置」修复入口"), "the old honest copy is kept");
});

test("negative control: the repair-surface checks turn red when the CTA or the CSRF field is dropped", () => {
  const brokenModel = modelFor({ snapshot: () => ({ status: "broken", revision: null, vaults: {}, errorCode: "git_config_invalid_document" }) });
  const html = renderVaultsPage({ vaultGit: { wired: true, model: brokenModel, error: null }, csrf: CSRF, actions: ACTIONS, query: { confirm: "repair" }, repairWired: true }).content;
  checkConfirmPage(html);

  assert.throws(() => checkRepairSurface(html.replace(`href="${BASE}?confirm=repair"`, `href="${BASE}"`)), /GET link/);
  assert.throws(() => checkRepairSurface(html.replace(`name="csrf" value="${CSRF}"`, 'name="token" value=""')), /CSRF/);
  assert.throws(() => checkConfirmPage(html.replace('name="confirm"', 'name="ok"')), /type-to-confirm/);
  assert.throws(
    () => checkConfirmPage(html.replace(/<input class="inp" name="confirm"[^>]*>/, "").replace("</form></div>", "</form><input class=\"inp\" name=\"confirm\"></div>")),
    /belong to the POST form/,
  );
  assert.throws(() => checkConfirmPage(html.replace(`<code>${REPAIR_CONFIRM_TEXT}</code>`, "<code>确认</code>")), /prompt names/);
  // The script policy itself: an injected non-whitelisted script, an inline handler and a
  // javascript: URL must each turn it red, while the real document shape stays green.
  assert.throws(() => assertScriptPolicy('<script>alert(1)</script>'), /whitelisted same-origin module/);
  assert.throws(() => assertScriptPolicy('<div onclick="x()"></div>'), /inline event handler/);
  assert.throws(() => assertScriptPolicy('<a href="javascript:x()">x</a>'), /javascript:/);
  assert.doesNotThrow(() => assertScriptPolicy('<script type="module" src="/admin/auth/assets/admin-client.js"></script>'));
});

// --------------------------------------------------------------- HTTP layer --

test("HTTP: GET ?confirm=repair renders the confirm page; the plain page does not", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  const { origin } = await startServer(t, { store });

  const list = await get(origin, BASE);
  assert.equal(list.status, 200);
  checkRepairSurface(list.body);
  assert.equal(list.body.includes('class="modal show"'), false);

  const confirm = await get(origin, `${BASE}?confirm=repair`);
  assert.equal(confirm.status, 200);
  checkConfirmPage(confirm.body);
  assert.equal(confirm.body.includes(CORRUPT.slice(0, 20)), false, "the corrupt payload is never echoed");
});

test("HTTP: repair without CSRF is refused by the guard and never reaches the store", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  const { events, provider } = auditSink();
  const { origin } = await startServer(t, { store, provider });

  const response = await post(origin, `${BASE}/repair`, { confirm: REPAIR_CONFIRM_TEXT });
  assert.equal(response.status, 403);
  assert.equal(await dir.read(), CORRUPT, "the store was not touched");
  assert.deepEqual(await dir.isolated(), []);
  assert.equal(store.snapshot().status, "broken");
  assert.deepEqual(events, [], "the CSRF guard answers before any audit entry");
});

test("HTTP: a wrong confirm text is a server-side 403 (the disabled button is not the gate)", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  const { events, provider } = auditSink();
  const { origin } = await startServer(t, { store, provider });

  for (const confirm of ["", "确认", "reset"]) {
    const response = await post(origin, `${BASE}/repair`, { csrf: CSRF, confirm });
    assert.equal(response.status, 403, `confirm=${JSON.stringify(confirm)} is refused`);
    assert.ok(response.body.includes('<div class="result err" role="status">'), "refusal renders .result err");
    assert.match(response.body, /确认文本不匹配/);
    assert.equal(response.body.includes(CORRUPT.slice(0, 20)), false, "no stored content is echoed");
  }
  assert.equal(events.length, 3, "every refusal is audited exactly once");
  for (const event of events) {
    assert.equal(event.action, REPAIR_AUDIT_ACTION);
    assert.equal(event.credentialType, "admin-session");
    assert.equal(event.outcome, "failure");
    assert.equal(event.detail, VAULT_GIT_REPAIR_CODES.CONFIRM_MISMATCH, "the audit carries a frozen code, nothing else");
    assert.equal(typeof event.source, "string");
  }
  assert.equal(JSON.stringify(events).includes(CORRUPT.slice(0, 20)), false, "no document content in the audit trail");
});

test("HTTP: a healthy store answers 409 and stays byte-identical", async (t) => {
  const dir = await tempRoot(t);
  const healthy = JSON.stringify({ schema: 1, revision: 5, vaults: {} }, null, 2);
  await dir.write(healthy);
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  const { events, provider } = auditSink();
  const { origin } = await startServer(t, { store, provider });

  const response = await post(origin, `${BASE}/repair`, { csrf: CSRF, confirm: REPAIR_CONFIRM_TEXT });
  assert.equal(response.status, 409, "healthy configuration is never overwritten");
  assert.ok(response.body.includes('<div class="result err" role="status">'));
  assert.match(response.body, /不需要修复/);
  assert.equal(await dir.read(), healthy, "the file is unchanged");
  assert.deepEqual(await dir.isolated(), []);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "failure");
  assert.equal(events[0].detail, VAULT_GIT_REPAIR_CODES.NOT_NEEDED);
});

test("HTTP: a confirmed repair isolates, resets, reports the isolation path and audits success", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  const { events, provider } = auditSink();
  const { origin } = await startServer(t, { store, provider });

  const response = await post(origin, `${BASE}/repair`, { csrf: CSRF, confirm: REPAIR_CONFIRM_TEXT });
  assert.equal(response.status, 200);
  assert.ok(response.body.includes('<div class="result ok" role="status">'), "success renders .result ok");
  assert.match(response.body, /Git 配置存储已修复/);

  const slots = await dir.isolated();
  assert.equal(slots.length, 1);
  const isolatedPath = path.join(dir.root, slots[0]);
  assert.ok(response.body.includes(isolatedPath), "the operator is told exactly where the old file went");
  assert.equal(response.body.includes("Git 配置存储不可用"), false, "the banner is gone: the page re-read the store");

  assert.deepEqual(JSON.parse(await dir.read()), { schema: 1, revision: 0, vaults: {} });
  assert.equal(await fs.readFile(isolatedPath, "utf8"), CORRUPT, "the corrupt content is preserved");
  assert.equal(store.snapshot().status, "ready");

  assert.equal(events.length, 1, "one audit entry for the successful repair");
  assert.deepEqual(
    { action: events[0].action, credentialType: events[0].credentialType, outcome: events[0].outcome, detail: events[0].detail },
    { action: REPAIR_AUDIT_ACTION, credentialType: "admin-session", outcome: "success", detail: "reset_to_defaults" },
  );
  assert.equal("isolatedPath" in events[0], false, "the isolation path stays out of the audit trail");
});

test("HTTP: an isolation failure is a 503 with zero writes and an audited refusal", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root, io: ioWith({ rename: async () => { throw new Error("EPERM"); } }) });
  await store.ready;
  const { events, provider } = auditSink();
  const { origin } = await startServer(t, { store, provider });

  const response = await post(origin, `${BASE}/repair`, { csrf: CSRF, confirm: REPAIR_CONFIRM_TEXT });
  assert.equal(response.status, 503);
  assert.ok(response.body.includes('<div class="result err" role="status">'));
  assert.match(response.body, /无法隔离/);
  assert.equal(await dir.read(), CORRUPT, "zero writes");
  assert.deepEqual(await dir.temps(), [], "not even a temp file");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail, VAULT_GIT_REPAIR_CODES.ISOLATE_FAILED);
});

test("HTTP: a write-then-rollback failure reports where the preserved file is", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  // Isolation succeeds; every rename into the document path fails, so neither the reset write nor the
  // put-back lands: the corrupt content stays in the isolation slot and the page must say where.
  const store = createGitConfigStore({
    dataRoot: dir.root,
    io: ioWith({ rename: async (from, to) => {
      if (String(to).endsWith("git-vaults.json") || String(from).includes(".git-vaults.")) throw new Error("EIO");
      return fs.rename(from, to);
    } }),
  });
  await store.ready;
  const { events, provider } = auditSink();
  const { origin } = await startServer(t, { store, provider });

  const response = await post(origin, `${BASE}/repair`, { csrf: CSRF, confirm: REPAIR_CONFIRM_TEXT });
  assert.equal(response.status, 503);
  assert.ok(response.body.includes('<div class="result err" role="status">'));
  const slots = await dir.isolated();
  assert.equal(slots.length, 1);
  assert.ok(response.body.includes(path.join(dir.root, slots[0])), "the stranded isolation path is shown");
  assert.equal(events.length, 1);
  assert.equal(events[0].detail, GIT_CONFIG_CODES.STORE_IO);
});

test("HTTP: an unwired deployment offers no CTA and refuses the POST with 503", async (t) => {
  const dir = await tempRoot(t);
  await dir.write(CORRUPT);
  const store = createGitConfigStore({ dataRoot: dir.root });
  await store.ready;
  const { events, provider } = auditSink();
  const { origin } = await startServer(t, { store, provider, repairStore: null });

  const page = await get(origin, `${BASE}?confirm=repair`);
  assert.equal(page.status, 200);
  assert.equal(page.body.includes("重置为默认并修复…"), false, "no fake CTA");

  const response = await post(origin, `${BASE}/repair`, { csrf: CSRF, confirm: REPAIR_CONFIRM_TEXT });
  assert.equal(response.status, 503);
  assert.match(response.body, /没有接线 Git 配置修复路径/);
  assert.equal(await dir.read(), CORRUPT, "nothing was written");
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "failure");
  assert.equal(events[0].detail, VAULT_GIT_REPAIR_CODES.NOT_WIRED);
});

test("HTTP: the repair codes and URLs are pinned (page, route and store agree)", () => {
  assert.equal(resolveActions().repair, `${BASE}/repair`);
  assert.equal(statusForCode(VAULT_GIT_REPAIR_CODES.NOT_NEEDED), 409);
  assert.equal(statusForCode(VAULT_GIT_REPAIR_CODES.CONFIRM_MISMATCH), 403);
  assert.equal(statusForCode(VAULT_GIT_REPAIR_CODES.ISOLATE_FAILED), 503);
  assert.equal(statusForCode(VAULT_GIT_REPAIR_CODES.NOT_WIRED), 503);
  assert.equal(VAULT_GIT_REPAIR_CODES.NOT_NEEDED, GIT_CONFIG_REPAIR_CODES.NOT_NEEDED, "the route reuses the store's own code");
  assert.equal(VAULT_GIT_REPAIR_CODES.ISOLATE_FAILED, GIT_CONFIG_REPAIR_CODES.ISOLATE_FAILED);
  assert.equal(REPAIR_CONFIRM_TEXT, "重置", "the prompt text the server compares against");
  assert.equal(REPAIR_AUDIT_ACTION, "admin.git-config.repair");
});
