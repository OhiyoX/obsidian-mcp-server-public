// Lane W4-vaults — structure/behaviour tests for the rebuilt "Vault 与 Git" page.
//
// Contract: `docs/admin/README.md` (page returns `{content, detailPanel}`, no-JS, data only from the
// model, unknown renders as `—`) and the prototype page it ports
// (`docs/admin-ui-proto/src/5-render.js:456-473`, drawer `src/6-app.js:219-362`).
//
// The suite has three layers:
//   1. structure — the list table, the `?id=` drawer, the capability block, the planned features;
//   2. negative controls — removing a required element or the escaping must make the same checks red;
//   3. a real HTTP router over a deterministic stub service — CSRF, CAS status codes and the
//      POST renders a `.result`. Pure string tests alone do not prove the route contract.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { GIT_CONFIG_LIMITS } from "../../src/git-config/schema.js";
import { renderVaultsPage } from "../../src/admin/pages/vaults.js";
import { renderAuthShell } from "../../src/admin/pages/shell.js";
import {
  VAULT_GIT_CODES,
  failureNotice,
  registerVaultGitRoutes,
  resolveActions,
  statusForCode,
} from "../../src/admin/routes/vault-git.js";
import { VAULT_GIT_CODES as SERVICE_CODES } from "../../src/admin/vault-git-routes.js";
import { listenFetchSafeOrigin } from "../../scripts/fetch-safe-listen.mjs";

// D0 (approved 2026-10-18) script policy, in one place:
//   * a fragment (a page module's content) renders no script at all;
//   * an authenticated document renders exactly one same-origin, whitelisted enhancement module;
//   * neither may contain an inline handler or a javascript: URL.
const D0_MODULE_SCRIPT = /^<script type="module" src="\/admin\/auth\/assets\/[a-z-]+\.js"><\/script>$/i;
function assertScriptPolicy(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>(?:<\/script>)?/gi)].map((match) => match[0]);
  if (scripts.length > 0) {
    assert.equal(scripts.length, 1, "no script beyond the one whitelisted same-origin module");
    assert.match(scripts[0], D0_MODULE_SCRIPT, "the single script is the whitelisted same-origin module");
  }
  assert.doesNotMatch(html, /[\s"']on(?:click|change|input|submit|load|error|mouseover|focus|blur|toggle|keydown|keyup)\s*=/i, "no inline event handlers");
  assert.doesNotMatch(html, /javascript:/i, "no javascript: URLs");
}



const CSRF = "csrf-token-for-tests";
const BASE = "/admin/auth/vault-git";
const ACTIONS = Object.freeze({
  base: BASE,
  save: `${BASE}/save`,
  refresh: `${BASE}/refresh`,
  verify: `${BASE}/verify`,
  admission: `${BASE}/admission`,
});

// ------------------------------------------------------------------ fixtures --

function record(overrides = {}) {
  return {
    enabled: true, autoCommit: true, autoPush: true, autoCommitSweep: true,
    debounceSeconds: 30, maxDelaySeconds: 300, sweepIntervalSeconds: 900,
    remote: "origin", branch: "main", updatedAt: "2026-10-13T10:00:00.000Z",
    ...overrides,
  };
}

function vault(overrides = {}) {
  return {
    id: "vault",
    name: "主库",
    primary: true,
    writable: true,
    root: "/data/vaults/vault",
    canonicalRoot: "/data/vaults/vault",
    editable: true,
    admission: { admission: "approved", status: "ready", reason: null, generation: 3, servable: true },
    capabilities: [
      { key: "notes", available: true, reason: null },
      { key: "git", available: true, reason: null },
      { key: "semantic", available: false, reason: "embedding provider is not configured" },
      { key: "webCatalog", available: false, reason: "web plane capability" },
    ],
    git: {
      state: "ready",
      repository: "ready",
      configSource: "persisted",
      configError: null,
      config: record(),
      pending: { count: 2, paths: ["notes/a.md", "notes/b.md"], authors: [{ agent: "cursor", model: "composer" }], since: "2026-10-17T09:00:00.000Z" },
      dirty: true,
      timers: { commit: true, maxDelay: true, sweep: true },
      lastSweep: { at: "2026-10-17T08:00:00.000Z", committed: true, hash: "a1c9e07", pushed: true, reason: "sweep" },
      push: { lastOutcome: { at: "2026-10-17T08:00:05.000Z", pushed: true, failureClass: "none", remote: "origin", branch: "main", exitCode: 0, summary: "ok" }, consecutiveFailures: 0 },
    },
    ...overrides,
  };
}

function secondary(overrides = {}) {
  return {
    id: "research",
    name: "研究库",
    primary: false,
    writable: true,
    root: "/data/vaults/research",
    canonicalRoot: null,
    editable: true,
    admission: { admission: "pending", status: "unavailable", reason: null, generation: null, servable: false },
    capabilities: [{ key: "notes", available: true, reason: null }, { key: "git", available: false, reason: null }],
    git: {
      state: "repository-missing",
      repository: "missing",
      configSource: "default-disabled",
      configError: null,
      config: record({ enabled: false, autoCommit: false, autoPush: false, autoCommitSweep: false, remote: "origin", branch: "", updatedAt: null }),
      pending: { count: 0, paths: [], authors: [], since: null },
      dirty: null, timers: null, lastSweep: null,
      push: { lastOutcome: null, consecutiveFailures: 0 },
    },
    ...overrides,
  };
}

function model(overrides = {}) {
  return {
    vaults: [vault(), secondary()],
    revision: 7,
    status: "ready",
    broken: null,
    defaultVaultId: "vault",
    notice: null,
    admission: { initialized: true },
    ...overrides,
  };
}

function ctx(input = model(), query = {}) {
  return { vaultGit: { wired: true, model: input, error: null }, csrf: CSRF, actions: ACTIONS, query };
}

function render(input = model(), query = {}) {
  const page = renderVaultsPage(ctx(input, query));
  return { ...page, html: page.content + page.detailPanel };
}

// --------------------------------------------------------------- assertions --

/** Everything the list page must have. Both the positive test and the negative control use it. */
function checkList(html, input = model()) {
  assert.match(html, /<h1>Vault 与 Git<span class="cnt">2<\/span><\/h1>/, "page bar title + vault count");
  for (const header of ["Vault", "Git 状态", "同步方式", "远端 / 分支", "能力"]) {
    assert.ok(html.includes(`<th>${header}</th>`), `column ${header}`);
  }
  assert.ok(html.includes('<th class="act"></th>'), "row-action column");
  assert.ok(html.includes('<col style="width:20%">') && html.includes('<col style="width:24%">'), "prototype column widths");
  assert.ok(html.includes('<table class="tbl">') && html.includes('<div class="tw hide-m">'), "prototype table shell");
  assert.ok(html.includes('<div class="mcards">') && html.includes('<div class="mc">'), "mobile cards mirror the table");
  assert.ok(html.includes('class="lede"'), "page lede");
  assert.ok(html.includes("自动提交 · 自动推送 · 每 15 分钟兜底"), "同步方式 cell");
  assert.ok(html.includes("origin/main"), "远端 / 分支 cell");
  assert.ok(html.includes("2 / 4 可用"), "能力 cell counts the descriptor's capabilities");
  assert.ok(html.includes('<span class="st amber" data-pending-count="2" title="作者 cursor / composer · 最早待提交 2026-10-17T09:00:00.000Z · 有未提交改动"><span class="dot"></span>2 个待提交</span>'), "the fixture's non-empty pending batch is the list status (prototype gitState, 5-render.js:169)");
  assert.ok(html.includes('<span class="st off"><span class="dot"></span>未初始化 Git 仓库</span>'), "missing repository state");
  assert.ok(html.includes(`<form class="inline-form" method="post" action="${ACTIONS.refresh}">`), "页头刷新 is a POST form");
  assert.ok(html.includes('规划中 · #437'), "扫描新 Vault keeps the planned marker");
  assert.ok(html.includes("从 GitHub 仓库添加 Vault") && html.includes("<button class=\"btn\" disabled>添加…</button>"), "GitHub-backed futbox keeps a disabled CTA");
  assert.ok(html.includes('class="sect futonly"'), "planned blocks stay behind .futonly");
  assert.ok(html.includes('<details class="mn">'), "row menu is a details element (no script)");
  assert.ok(html.includes(`href="${BASE}?id=vault"`), "row entry point is the ?id= drawer");
  assert.ok(html.includes(`<form method="post" action="${ACTIONS.verify}">`), "row menu offers 验证 (POST)");
  assert.ok(html.includes("Vault 准入"), "the W2 admission surface survives");
  assert.equal(html.includes('<td class="cellt">0 / '), false, "an unavailable count is never rendered as 0");
  for (const v of input.vaults) {
    assert.ok(html.includes(`?id=${v.id}`), `each vault links its drawer (${v.id})`);
  }
}

/** Everything the `?id=` drawer must have. */
function checkDrawer(html) {
  assert.ok(html.includes('<aside class="drawer on" id="vault-drawer-vault" role="dialog"'), "drawer is the ?id= state");
  assert.ok(html.includes(`<a class="ibtn" href="${BASE}" aria-label="关闭">`), "drawer closes back to the list");
  // The prototype's own kv inventory (`6-app.js:271-278`), compared in both directions by the
  // parity gate: no `角色` row (identity is the header badge).
  for (const key of ["Git 仓库", "最近推送", "待提交", "目录", "配置来源", "上次验证", "定时任务"]) {
    assert.ok(html.includes(`<div class="k">${key}</div>`), `状态 kv row ${key}`);
  }
  assert.equal(html.includes('<div class="k">角色</div>'), false, "the prototype has no 角色 kv row");
  assert.ok(html.includes('<span class="mono muted">vault</span><span class="kind">主库</span>'), "identity is the header badge, like the prototype");
  assert.ok(html.includes('<div class="help mono">repository ready · HEAD —'), "HEAD is reported as missing, not invented");
  assert.ok(html.includes("领先 — / 落后 —"), "ahead/behind is reported as missing");
  assert.ok(html.includes("Git 同步设置"), "settings section");
  for (const [key, label] of [["enabled", "为此 Vault 启用 Git"], ["autoCommit", "自动提交"], ["autoPush", "自动推送"], ["autoCommitSweep", "周期兜底提交"]]) {
    assert.ok(html.includes(`<b>${label}</b> <span class="sub">${key}</span>`), `switch row ${key}`);
  }
  assert.ok(html.includes('<button class="switch on" type="submit"'), "a switch is a real submit button");
  assert.ok(html.includes(`<form class="inline-form" method="post" action="${ACTIONS.save}">`), "switch forms post to save");
  assert.ok(html.includes('<input type="hidden" name="enabled" value="false">'), "switching posts the inverted value");
  assert.ok(html.includes(`<form method="post" action="${ACTIONS.save}" id="git-settings-vault">`), "保存设置 form");
  assert.ok(html.includes('name="expectedRevision" value="7"'), "CAS revision is rendered into every write");
  for (const [key, , min, max] of [["debounceSeconds", "", GIT_CONFIG_LIMITS.debounceSecondsMin, GIT_CONFIG_LIMITS.debounceSecondsMax], ["maxDelaySeconds", "", GIT_CONFIG_LIMITS.maxDelaySecondsMin, GIT_CONFIG_LIMITS.maxDelaySecondsMax], ["sweepIntervalSeconds", "", GIT_CONFIG_LIMITS.sweepIntervalSecondsMin, GIT_CONFIG_LIMITS.sweepIntervalSecondsMax]]) {
    assert.ok(html.includes(`name="${key}" min="${min}" max="${max}"`), `number field ${key} uses the schema bounds`);
  }
  assert.ok(html.includes('name="remote" maxlength="128" value="origin"'), "remote field");
  assert.ok(html.includes('name="branch" maxlength="240" value="main"'), "branch field");
  assert.ok(html.includes('type="submit" form="git-verify-vault"'), "验证 posts through its own form");
  assert.ok(html.includes('<form method="post" action="/admin/auth/vault-git/verify" id="git-verify-vault">'), "verify form");
  assert.ok(html.includes('<div class="caps">') && html.includes('class="cap off"'), "capability chips with the dashed unwired state");
  assert.ok(html.includes("· 语义检索：本机未配置向量服务，检索仍按关键词工作"), "Chinese reason for an unwired capability");
  assert.ok(html.includes("embedding provider is not configured"), "raw reason stays in 技术细节");
  assert.ok(html.includes("技术细节"), "technical details are folded, not dropped");
  assert.ok(html.includes("规划中 · #437"), "抽屉「运行时」keeps the planned marker");
}

/** No-JS + escaping checks. */
function checkNoScript(html) {
  assertScriptPolicy(html);
  assert.equal(/\son[a-z]+=/i.test(html), false, "no inline event handler");
  assert.equal(/data-act=|data-menu=|data-open=/.test(html), false, "no JS hooks");
  for (const [, body] of html.matchAll(/<form\b[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/g)) {
    assert.ok(body.includes('name="csrf"'), "every POST form carries the CSRF field");
  }
}

// ------------------------------------------------------------------- tests --

test("list page: prototype columns, cell shapes, planned features and admission surface", () => {
  const { content, detailPanel, html } = render();
  assert.equal(detailPanel, "", "no drawer without ?id=");
  assert.match(content, /^<header class="bar">/, "the page owns its own .bar");
  checkList(html);
  checkNoScript(html);
});

test("list page: the pending batch is the status reading (prototype gitState), never [object Object]", () => {
  // #400/#435: the pending count has to be readable on the list surface, not only in the drawer,
  // and the structured author fact must never be stringified. The prototype replaces the clean pill
  // with `N 个待提交` (5-render.js:169).
  const dirty = vault();
  assert.equal(dirty.git.pending.count, 2, "the shared fixture carries a real batch");
  const list = render(model({ vaults: [dirty, secondary()] }));
  assert.ok(list.html.includes('<span class="dot"></span>2 个待提交</span>'), "the prototype's own reading");
  assert.ok(list.html.includes('data-pending-count="2"'), "the count stays machine-readable");
  assert.ok(list.html.includes('title="作者 cursor / composer · 最早待提交 2026-10-17T09:00:00.000Z · 有未提交改动"'), "the pill carries the pending facts");
  assert.equal(list.html.includes('[object Object]'), false, "the author object is rendered as a fact, not stringified");
  assert.equal(list.html.includes('已同步'), false, "a dirty batch is not also reported as 已同步");

  // A degraded §16.2 runtime token is never hidden by the count: it keeps its pill, the reading
  // becomes its suffix.
  const failing = vault({ git: { ...dirty.git, state: "push-failing" } });
  const degraded = render(model({ vaults: [failing, secondary()] }));
  assert.ok(degraded.html.includes('<span class="st amber"><span class="dot"></span>推送失败</span>'), "the runtime state survives");
  assert.ok(degraded.html.includes('· 2 个待提交'), "and still carries the pending reading");

  // A clean batch renders the prototype's clean pill and no reading at all (a zero is not a fact
  // the prototype prints).
  const clean = vault({ git: { ...dirty.git, pending: { count: 0, paths: [], authors: [], since: null }, dirty: false } });
  const cleanList = render(model({ vaults: [clean, secondary()] }));
  assert.ok(cleanList.html.includes('<span class="st ok"><span class="dot"></span>已同步</span>'), "clean vault keeps the 已同步 pill");
  assert.equal(/\d+\s*个待提交/.test(cleanList.html), false, "a zero batch prints no reading");

  // A runtime that says nothing about the batch renders no reading either - never "0 个待提交".
  const silent = vault({ git: { ...dirty.git, pending: null, dirty: null } });
  const silentList = render(model({ vaults: [silent, secondary()] }));
  assert.ok(silentList.html.includes('<span class="st ok"><span class="dot"></span>已同步</span>'), "the state pill still renders");
  assert.equal(/\d+\s*个待提交/.test(silentList.html), false, "a silent runtime is not a zero");
});

test("empty inventory: the prototype empty state, not a fabricated table", () => {
  const { html } = render(model({ vaults: [] }));
  assert.ok(html.includes('<div class="empty"><div class="ic">'), "empty state");
  assert.ok(html.includes("<b>没有可用的 Vault</b>"), "empty title");
  assert.ok(html.includes("检查部署配置中的 Vault 列表"), "empty description");
  assert.ok(html.includes('<h1>Vault 与 Git<span class="cnt">0</span></h1>'), "a real count of 0 is shown (the prototype renders it too)");
});

test("drawer: 状态 kv, 4 switches + 3 numbers + 2 texts, save/verify, capabilities", () => {
  const { detailPanel, html } = render(model(), { id: "vault" });
  assert.notEqual(detailPanel, "", "?id= renders the drawer");
  checkDrawer(html);
  checkNoScript(html);
});

test("drawer: a read-only vault is marked in the header, and the kv inventory stays the prototype's", () => {
  const readOnly = render(model({ vaults: [vault({ writable: false }), secondary()] }), { id: "vault" });
  assert.ok(readOnly.detailPanel.includes('<span class="kind">只读</span>'), "the exception fact keeps a badge");
  assert.ok(readOnly.detailPanel.includes('<span class="kind">主库</span>'), "the primary badge is unchanged");
  assert.equal(readOnly.detailPanel.includes('<div class="k">角色</div>'), false, "no invented kv row");
  // The writable default is not badged (the prototype badges the marker, not the norm).
  assert.equal(render(model(), { id: "vault" }).detailPanel.includes('>只读<'), false, "a writable vault carries no 只读 badge");
});

test("drawer: an unknown ?id= renders the honest 不存在 state instead of an empty drawer", () => {
  const { detailPanel } = render(model(), { id: "ghost" });
  assert.ok(detailPanel.includes("Vault 不存在或已移除"), "missing vault copy");
  assert.ok(detailPanel.includes('href="/admin/auth/vault-git"'), "still closable");
  assert.equal(detailPanel.includes("git-settings-"), false, "no form for a vault that does not exist");
});

test("unknown facts stay unknown: no 0 / 正常, disabled controls when the store is unreadable", () => {
  const brokenModel = model({
    status: "broken",
    broken: { errorCode: "git_config_invalid_document" },
    vaults: [vault({ editable: false }), secondary({ editable: false })],
  });
  const list = render(brokenModel);
  assert.ok(list.html.includes('<div class="banner danger">'), "broken store banner");
  assert.ok(list.html.includes("Git 配置存储不可用"), "broken store headline");
  assert.ok(list.html.includes("git_config_invalid_document"), "the frozen store code is shown");
  assert.equal(list.html.includes("data-act=\"git-repair\""), false, "no invented repair route");

  const drawer = render(brokenModel, { id: "vault" });
  assert.ok(drawer.detailPanel.includes('<button class="switch on" type="button" disabled'), "switches are disabled, not fake");
  assert.ok(drawer.detailPanel.includes('<button class="btn primary" type="submit" disabled>保存设置</button>'), "保存设置 is disabled");
  assert.equal(/value="undefined"|value="null"/.test(drawer.html), false, "missing values never leak as undefined/null");

  const unresolvable = render(model({ vaults: [vault({ git: { ...vault().git, config: null, configError: { name: "InvalidRecord", message: "bad baseline" } } })] }), { id: "vault" });
  assert.ok(unresolvable.detailPanel.includes("bad baseline"), "configError is surfaced");
  assert.equal(unresolvable.detailPanel.includes('value="0"'), false, "an unreadable config is not rendered as 0");
});

test("hostile model strings are escaped (names, paths, remotes)", () => {
  const hostile = model({
    vaults: [vault({
      name: "<script>alert(1)</script>",
      root: "/data/<img onerror=x>",
      git: { ...vault().git, config: record({ remote: "ori&quot;gin", branch: "main<script>" }) },
    })],
  });
  const { html } = render(hostile, { id: "vault" });
  assert.equal(html.includes("<script>alert(1)</script>"), false, "name is escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "name is escaped, not dropped");
  assert.ok(html.includes("&lt;img onerror=x&gt;"), "root is escaped");
  assert.equal(/value="main<script>"/.test(html), false, "branch is escaped");
});

test("negative control: dropping a required element or the escaping turns the same checks red", () => {
  const { html, content } = render();
  checkList(html, model());

  const noRemoteColumn = html.replace("<th>远端 / 分支</th>", "<th>远端</th>");
  assert.throws(() => checkList(noRemoteColumn, model()), /远端 \/ 分支/);

  const noCsrf = html.replaceAll(`name="csrf" value="${CSRF}"`, 'name="token" value=""');
  assert.throws(() => checkNoScript(noCsrf), /CSRF/);

  const noDrawer = render(model(), { id: "vault" });
  const brokenDrawer = noDrawer.detailPanel.replace("Git 同步设置", "同步设置");
  assert.throws(() => checkDrawer(brokenDrawer), /settings section/);

  const unescaped = render(model({ vaults: [vault({ name: "<script>alert(1)</script>" })] }), { id: "vault" });
  assert.ok(unescaped.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the escaping baseline holds");
  assert.throws(() => {
    assert.equal(unescaped.html.replace("&lt;script&gt;", "<script>").includes("<script>"), false, "name is escaped");
  }, /name is escaped/);

  assert.ok(content.includes("<header"), "the positive baseline still renders");
});

test("the route module pins the service's frozen result codes", () => {
  assert.deepEqual(VAULT_GIT_CODES, {
    UNKNOWN_VAULT: SERVICE_CODES.UNKNOWN_VAULT,
    INVALID_FIELDS: SERVICE_CODES.INVALID_FIELDS,
    REGISTRY_UNAVAILABLE: SERVICE_CODES.REGISTRY_UNAVAILABLE,
  }, "the page module's codes are the service's codes");
  assert.equal(resolveActions().base, BASE);
  assert.equal(resolveActions().routeBase, "/vault-git");
  assert.equal(resolveActions({}, "/admin/auth", { admission: true }).admission, `${BASE}/admission`);
  assert.equal(resolveActions({}, "/admin/auth").admission, null, "no admissions URL without the W2 trigger");
  assert.equal(statusForCode("git_config_stale_revision"), 409);
  assert.equal(statusForCode(SERVICE_CODES.UNKNOWN_VAULT), 404);
  assert.match(failureNotice({ code: "git_config_stale_revision" }).message, /revision 冲突/);
  assert.match(failureNotice({ code: SERVICE_CODES.INVALID_FIELDS, detail: "expectedRevision" }).message, /expectedRevision/);
  assert.equal(failureNotice({ code: "unknown", detail: "<script>" }).message.includes("<script>"), false, "submitted content is never echoed");
});

// ---------------------------------------------------- real router (HTTP) ----

function stubAdmin(overrides = {}) {
  const calls = [];
  const state = { revision: 7, notice: null };
  const admissions = [];
  const admin = {
    calls,
    admissions,
    async admissionAction(operation, body) {
      admissions.push({ operation, body: { ...body } });
      if (overrides.admission) return overrides.admission(operation, body);
      return { ok: true, notice: "准入操作已完成。" };
    },
    async model() {
      return model({ revision: state.revision, notice: state.notice });
    },
    async save(body) {
      calls.push({ method: "save", body });
      if (overrides.save) return overrides.save(body);
      state.revision += 1;
      return { ok: true, vaultId: body.vaultId, revision: state.revision };
    },
    async refreshInventory() {
      calls.push({ method: "refresh" });
      if (overrides.refresh) return overrides.refresh();
      return { ok: true, notice: "Vault 清单已刷新（registry revision 3）。" };
    },
    async verify(vaultId) {
      calls.push({ method: "verify", vaultId });
      if (overrides.verify) return overrides.verify(vaultId);
      return { ok: true, notice: `已重新读取 ${vaultId} 的配置` };
    },
  };
  return admin;
}

async function startServer(t, admin) {
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
  });
  app.use("/admin/auth", router);
  const server = http.createServer(app);
  const origin = await listenFetchSafeOrigin(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin, registered };
}

async function get(origin, path) {
  const response = await fetch(`${origin}${path}`, { redirect: "manual" });
  return { status: response.status, body: await response.text() };
}

async function post(origin, path, form) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: await response.text() };
}

test("HTTP: GET renders the page and the ?id= drawer from the service model", async (t) => {
  const { origin, registered } = await startServer(t, stubAdmin());
  assert.equal(registered.base, BASE);

  const list = await get(origin, BASE);
  assert.equal(list.status, 200);
  checkList(list.body);
  checkNoScript(list.body);
  assert.equal(list.body.includes('<aside class="drawer on"'), false, "the drawer is closed without ?id=");

  const drawer = await get(origin, `${BASE}?id=vault`);
  assert.equal(drawer.status, 200);
  checkDrawer(drawer.body);
});

test("HTTP: POST without the CSRF field is refused and no write reaches the service", async (t) => {
  const admin = stubAdmin();
  const { origin } = await startServer(t, admin);
  const response = await post(origin, `${BASE}/save`, { vaultId: "vault", enabled: "false" });
  assert.equal(response.status, 403);
  assert.equal(admin.calls.length, 0, "no service call without CSRF");
});

test("HTTP: a save writes the patch with the CAS revision and renders a .result", async (t) => {
  const admin = stubAdmin();
  const { origin } = await startServer(t, admin);
  const response = await post(origin, `${BASE}/save`, { csrf: CSRF, vaultId: "vault", expectedRevision: "7", autoPush: "false" });
  assert.equal(response.status, 200);
  assert.deepEqual({ ...admin.calls[0], body: { ...admin.calls[0].body } }, { method: "save", body: { csrf: CSRF, vaultId: "vault", expectedRevision: "7", autoPush: "false" } });
  assert.ok(response.body.includes('<div class="result ok" role="status">'), "success renders .result ok");
  assert.ok(response.body.includes("Git 设置已保存"), "result text");
  assert.ok(response.body.includes('name="expectedRevision" value="8"'), "the page is re-read with the new revision");
  assert.ok(response.body.includes('<aside class="drawer on" id="vault-drawer-vault"'), "the write keeps the submitted vault's drawer open");
});

test("HTTP: a stale revision is a 409 conflict that shows the current revision", async (t) => {
  const admin = stubAdmin({ save: () => ({ ok: false, code: "git_config_stale_revision", current: { revision: 9 } }) });
  const { origin } = await startServer(t, admin);
  const response = await post(origin, `${BASE}/save`, { csrf: CSRF, vaultId: "vault", expectedRevision: "7", autoPush: "false" });
  assert.equal(response.status, 409);
  assert.ok(response.body.includes('<div class="result err" role="status">'), "conflict renders .result err");
  assert.match(response.body, /revision 冲突/);
  assert.ok(response.body.includes('name="expectedRevision" value="7"'), "the reloaded page shows the revision the model now holds");
});

test("HTTP: refresh and verify answer with the service notice; unknown vault is a 404", async (t) => {
  const admin = stubAdmin({ verify: (vaultId) => (vaultId === "ghost" ? { ok: false, code: SERVICE_CODES.UNKNOWN_VAULT } : { ok: true, notice: `已重新读取 ${vaultId} 的配置` }) });
  const { origin } = await startServer(t, admin);

  const refresh = await post(origin, `${BASE}/refresh`, { csrf: CSRF });
  assert.equal(refresh.status, 200);
  assert.ok(refresh.body.includes("Vault 清单已刷新（registry revision 3）。"), "the service's own notice is rendered");

  const verify = await post(origin, `${BASE}/verify`, { csrf: CSRF, vaultId: "vault" });
  assert.equal(verify.status, 200);
  assert.deepEqual(admin.calls.at(-1), { method: "verify", vaultId: "vault" });
  assert.ok(verify.body.includes("已重新读取 vault 的配置"));
  assert.ok(verify.body.includes('<aside class="drawer on" id="vault-drawer-vault"'), "verify keeps the drawer open");

  const missing = await post(origin, `${BASE}/verify`, { csrf: CSRF, vaultId: "ghost" });
  assert.equal(missing.status, 404);
  assert.ok(missing.body.includes('<div class="result err" role="status">'));
  assert.match(missing.body, /Vault 不存在或已从清单中移除/);
});

test("HTTP: a save without a CAS token against an unreadable store fails closed with 503", async (t) => {
  const admin = stubAdmin();
  const brokenModel = model({ status: "broken", broken: { errorCode: "git_config_invalid_document" }, revision: null });
  admin.model = async () => brokenModel;
  const { origin } = await startServer(t, admin);
  const response = await post(origin, `${BASE}/save`, { csrf: CSRF, vaultId: "vault", enabled: "false" });
  assert.equal(response.status, 503, "the store is the reason, not the missing field");
  assert.ok(response.body.includes("不可写（fail closed）"), "fail-closed wording");
  assert.equal(admin.calls.length, 0, "no write is attempted against an unreadable store");
});

test("HTTP: admission writes are refused without CSRF and accepted with it", async (t) => {
  const admin = stubAdmin();
  const { origin, registered } = await startServer(t, admin);
  assert.equal(registered.actions.admission, `${BASE}/admission`, "the admissions URL exists with the W2 trigger");

  const refused = await post(origin, `${BASE}/admission/approve`, { vaultId: "research" });
  assert.equal(refused.status, 403);
  assert.equal(admin.admissions.length, 0);

  const accepted = await post(origin, `${BASE}/admission/approve`, { csrf: CSRF, vaultId: "research" });
  assert.equal(accepted.status, 200);
  assert.deepEqual(admin.admissions[0], { operation: "approve", body: { csrf: CSRF, vaultId: "research" } });
  assert.ok(accepted.body.includes("准入操作已完成。"));

  const page = await get(origin, BASE);
  assert.ok(page.body.includes(`${BASE}/admission/approve`), "the page renders the admissions controls from the trigger");
});

test("HTTP: without the service the route is not registered at all", async (t) => {
  const app = express();
  const router = express.Router();
  const registered = registerVaultGitRoutes(router, { admin: null, view: { renderAuthShell: () => "" } });
  assert.equal(registered, null);
  app.use("/admin/auth", router);
  const server = http.createServer(app);
  const origin = await listenFetchSafeOrigin(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await get(origin, BASE);
  assert.equal(response.status, 404, "no tab means no route");
});

test("HTTP: without the admission trigger the page renders no admissions form", async (t) => {
  const admin = stubAdmin();
  delete admin.admissionAction;
  const { origin } = await startServer(t, admin);
  const page = await get(origin, BASE);
  assert.equal(page.status, 200);
  assert.equal(page.body.includes("Vault 准入"), false, "no dead admissions form");
  assert.equal(page.body.includes(`${BASE}/admission/`), false);
});
