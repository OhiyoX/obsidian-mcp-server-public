// AuthZ Wave C / C2 — Auth Center "定时授权" (timed authorization) tab wiring.
//
// Contract: `scratch/authz/INTERFACE.md` §10.4/§10.6 and the C2 BRIEF §1.1.
// The B4 service (`./access-policy.js`) owns validation, the CAS write path and
// persistence; the B4 view (`./access-policy-view.js`) owns the HTML fragment.
// This module only wires both to a real Express router using the Auth Center's
// existing admin session + CSRF guards.
//
// Hard rules carried over from the frozen contract:
//  - the Admin plane is never gated by the policy it manages: nothing here calls
//    `runtime.evaluate`. Only the read-only `previewForSubject` touches
//    `runtime.explain`, and only through the B4 service;
//  - every write goes through `requireAdmin` + `requireCsrf` with the *existing*
//    session cookie and `csrf` field names, so there is no second auth scheme;
//  - error responses map frozen codes to 409/404/503/400 and never echo the
//    submitted policy JSON, a credential secret or a token;
//  - subject pickers come from the caller-supplied provider credential snapshot
//    (`snapshotSubjects`) plus the configured-env synthetic record.
//
// `view` is the Auth Center page shell supplied by `createAuthAdminRouter`:
// `{ layout(title, body), nav(activeTab, accessPolicyBase) }`. The B4 view
// functions are imported directly because they are pure and framework-free; a
// runtime injection would only add indirection.

import { ACCESS_POLICY_CODES } from "../access-policy/errors.js";
import { ACCESS_POLICY_ADMIN_CODES, snapshotSubjects } from "./access-policy.js";
import { escapeHtml, renderAccessPolicyTab } from "./access-policy-view.js";

/** Public default base URL, frozen by the C2 BRIEF §1.1. */
export const DEFAULT_BASE = "/admin/auth/access-policy";
/** The Auth Center router is mounted here in `server.js`. */
export const DEFAULT_MOUNT_PATH = "/admin/auth";

// A schema `details.path` (e.g. `policies[0].label`) is safe to show as a
// field hint; anything else is dropped so a message can never smuggle a value.
const SAFE_DETAIL = /^[A-Za-z0-9_.:\[\]-]{1,80}$/;

const CODE_HINTS = Object.freeze({
  [ACCESS_POLICY_CODES.INVALID_DOCUMENT]: "策略文档格式不正确，请检查提交的字段。",
  [ACCESS_POLICY_CODES.INVALID_POLICY]: "策略记录不合法，请检查模式、能力、时区或时间窗口。",
  [ACCESS_POLICY_CODES.UNSUPPORTED_SCHEMA]: "不支持的策略 schema 版本。",
  [ACCESS_POLICY_CODES.LIMIT_EXCEEDED]: "策略数量或文件大小超过上限。",
  [ACCESS_POLICY_CODES.UNKNOWN_SUBJECT]: "存在未知或非法的 subject；主体必须来自当前凭据快照或 configured-env。",
  [ACCESS_POLICY_CODES.UNKNOWN_CAPABILITY]: "存在未知 capability，请从能力 catalog 中选择。",
  [ACCESS_POLICY_CODES.INVALID_TIMEZONE]: "时区不是服务端已知的 IANA 时区。",
  [ACCESS_POLICY_CODES.INVALID_WINDOW]: "时间窗口不合法；不支持跨午夜，请拆成两条。",
  [ACCESS_POLICY_CODES.REVOKE_REQUIRES_ALL]: "revoke 模式必须且只能使用 all 能力（principal-wide）。",
  [ACCESS_POLICY_CODES.STORE_IO]: "策略存储写入失败，请稍后重试。",
});

const STATUS_BY_CODE = Object.freeze({
  [ACCESS_POLICY_CODES.STALE_REVISION]: 409,
  [ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID]: 404,
  [ACCESS_POLICY_ADMIN_CODES.STORE_UNAVAILABLE]: 503,
});

/**
 * Resolve the public action URLs (used in the rendered forms/links) plus the
 * router-relative base used to register the routes. `base` defaults to
 * `<mountPath>/access-policy`; `routeBase` strips `mountPath` because the Auth
 * Center router is mounted with `app.use(mountPath, router)`.
 */
export function resolveActions(actions = {}, mountPath = DEFAULT_MOUNT_PATH) {
  const base = String(actions.base ?? `${mountPath}/access-policy`).replace(/\/+$/, "") || DEFAULT_BASE;
  const routeBase = base.startsWith(`${mountPath}/`) ? base.slice(mountPath.length) : base;
  return Object.freeze({
    base,
    routeBase,
    create: actions.create ?? `${base}/create`,
    update: actions.update ?? `${base}/update`,
    toggle: actions.toggle ?? `${base}/toggle`,
    delete: actions.delete ?? `${base}/delete`,
    preview: actions.preview ?? `${base}/preview`,
    repair: actions.repair ?? `${base}/repair`,
  });
}

function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 400;
}

function hintFor(result) {
  const code = String(result?.code ?? "");
  const hint = CODE_HINTS[code] ?? "提交被拒绝，请检查表单字段后重试。";
  const detail = typeof result?.detail === "string" && SAFE_DETAIL.test(result.detail) ? `（字段：${result.detail}）` : "";
  return `${hint}${detail}`;
}

function shell(view, session, base, body, title = "Obsidian MCP · 授权管理", extra = {}) {
  // W4–W8: unified left/bottom nav shell (no horizontal .tabs chrome).
  if (typeof view.renderAuthShell === "function") {
    return view.renderAuthShell({
      activeTab: "access-policy",
      accessPolicyBase: base,
      vaultGitBase: extra.vaultGitBase || null,
      session,
      content: body,
      theme: extra.theme || "dark",
      // The request's own snapshot (sidebar counts, theme) — never a module-level cache from an
      // earlier request; the shell seam merges the route's own counts over it.
      catalog: extra.catalog || null,
      navCounts: extra.navCounts || {},
      navAttention: extra.navAttention || {},
      detailPanel: extra.detailPanel || "",
    });
  }
  const logout = `<form class="inline" method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(session?.csrf ?? "")}"><button class="btn secondary" type="submit">退出</button></form>`;
  const header = `<header class="topbar"><div><h1>Obsidian MCP</h1><p class="subtitle">定时授权</p></div><div class="actions"><a class="btn secondary" href="/admin/auth">返回授权管理</a>${logout}</div></header>`;
  return view.layout(title, `${header}${view.nav("access-policy", base)}${body}`);
}

// Provider snapshot -> known subjects. Read-only; never evaluates a policy.
async function loadSubjects(provider, configuredApiKeyEnabled) {
  if (!provider || typeof provider.authorizationSnapshot !== "function") {
    return snapshotSubjects(null, { configuredApiKeyEnabled });
  }
  return snapshotSubjects(await provider.authorizationSnapshot(), { configuredApiKeyEnabled });
}

function renderTab({ listing, subjects, csrfToken, actions, preview = null, editing = null, windowPolicy = null, capabilityQuery = "", draft = null, weeklyPreset = "", confirm = "", deleteId = "" }) {
  const status = listing.status ?? "ready";
  return renderAccessPolicyTab({
    policies: listing.policies ?? [],
    revision: listing.revision ?? null,
    status,
    orphaned: listing.orphaned ?? [],
    preview,
    editing,
    windowPolicy,
    capabilityQuery,
    csrfToken,
    subjects,
    actions,
    broken: status === "broken" ? { code: listing.errorCode ?? null } : null,
    draft,
    weeklyPreset,
    confirm,
    deleteId,
  });
}

function sendFailure(req, res, view, urls, result) {
  const code = String(result?.code ?? "");
  const status = statusForCode(code);
  const title = status === 409
    ? "策略已被他人修改"
    : status === 404 ? "策略不存在" : status === 503 ? "策略存储不可用" : "策略提交被拒绝";
  const message = status === 409
    ? "该策略在你提交前已被修改（revision 冲突）。为避免覆盖他人的修改，本次提交未生效。请刷新后重试。"
    : hintFor(result);
  const body = `<section class="card login"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="muted">错误码 <code>${escapeHtml(code || "unknown")}</code></p><p><a class="btn secondary" href="${escapeHtml(urls.base)}">返回定时授权</a></p></section>`;
  res.status(status).send(shell(view, req.adminSession, urls.base, body, title, { catalog: req.adminCatalog ?? null }));
}

function complete(req, res, view, urls, result) {
  if (result?.ok) {
    res.redirect(303, urls.base);
    return;
  }
  sendFailure(req, res, view, urls, result);
}

/**
 * `registerAccessPolicyRoutes(router, { admin, view, requireAdmin, requireCsrf, actions, provider, configuredApiKeyEnabled, mountPath })`.
 *
 * Registers `GET {base}` (tab page) and `POST {base}/{create|update|toggle|delete|preview|repair}`
 * on the Auth Center router. Returns `{ base, actions }`, or `null` when no
 * access-policy admin service is injected (zero behavior difference).
 */
export function registerAccessPolicyRoutes(router, {
  admin,
  view,
  requireAdmin,
  requireCsrf,
  actions = {},
  provider = null,
  configuredApiKeyEnabled = false,
  mountPath = DEFAULT_MOUNT_PATH,
  vaultGitBase = null,
} = {}) {
  if (!admin) return null;
  const hasV2Shell = typeof view?.renderAuthShell === "function";
  const hasLegacyShell = typeof view?.layout === "function" && typeof view?.nav === "function";
  if (!hasV2Shell && !hasLegacyShell) {
    throw new TypeError("registerAccessPolicyRoutes requires view.renderAuthShell (or legacy view.layout + view.nav)");
  }
  const urls = resolveActions(actions, mountPath);
  const { routeBase } = urls;

  // #406: `?edit=<id>` opens the edit panel as its own card (never inside a table cell) and
  // `?capq=` is its server-side capability filter. Both are read-only: the id must exist in the
  // listing the service just returned, so a crafted id renders nothing extra and leaks nothing.
  function editSelection(req, listing) {
    const wanted = typeof req.query?.edit === "string" ? req.query.edit.trim() : "";
    if (!wanted) return { editing: null, capabilityQuery: "" };
    const editing = (Array.isArray(listing?.policies) ? listing.policies : []).find((policy) => policy.id === wanted) ?? null;
    if (!editing) return { editing: null, capabilityQuery: "" };
    return { editing, capabilityQuery: typeof req.query?.capq === "string" ? req.query.capq.slice(0, 120) : "" };
  }

  // #434: `?window=<id>` opens the standalone window detail card (the #406 table-external card
  // pattern). Read-only like `?edit=`: the id must exist in the listing the service just returned,
  // so a crafted id renders nothing extra and leaks nothing. No write, no store call beyond the
  // listing read the tab page already performs.
  function windowSelection(req, listing) {
    const wanted = typeof req.query?.window === "string" ? req.query.window.trim() : "";
    if (!wanted) return { windowPolicy: null };
    const windowPolicy = (Array.isArray(listing?.policies) ? listing.policies : []).find((policy) => policy.id === wanted) ?? null;
    return { windowPolicy };
  }

  function buildDraft(req, listing) {
    const isNew = req.query?.new === "1" || req.query?.new === "true";
    const copyId = typeof req.query?.copy === "string" ? req.query.copy.trim() : "";
    let draft = null;
    if (copyId) {
      const source = (Array.isArray(listing?.policies) ? listing.policies : []).find((policy) => policy.id === copyId) ?? null;
      if (source) {
        draft = {
          label: `${source.label || "策略"}（副本）`,
          mode: source.mode,
          enabled: source.enabled,
          timezone: source.timezone,
          startsAt: source.startsAt ?? "",
          expiresAt: source.expiresAt ?? "",
          subjects: Array.isArray(source.subjects) ? [...source.subjects] : [],
          capabilities: Array.isArray(source.capabilities) ? [...source.capabilities] : [],
          weekly: source.weekly,
          dateRanges: source.dateRanges,
        };
      }
    } else if (isNew) {
      draft = {};
    }
    return draft;
  }

  async function tabPage(req, res, next, preview = null) {
    try {
      const subjects = await loadSubjects(provider, configuredApiKeyEnabled);
      const listing = await admin.listPolicies({ subjects });
      const weeklyPreset = typeof req.query?.weeklyPreset === "string" ? req.query.weeklyPreset.slice(0, 40) : "";
      const confirm = typeof req.query?.confirm === "string" ? req.query.confirm.trim() : "";
      const deleteId = typeof req.query?.id === "string" && confirm === "delete" ? req.query.id.trim() : "";
      const draft = buildDraft(req, listing);
      const fragment = renderTab({
        listing,
        subjects,
        csrfToken: req.adminSession.csrf,
        actions: urls,
        preview,
        draft,
        weeklyPreset,
        confirm,
        deleteId,
        ...editSelection(req, listing),
        ...windowSelection(req, listing),
      });
      res.send(shell(view, req.adminSession, urls.base, fragment, undefined, {
        vaultGitBase,
        // The request's own snapshot carries the sidebar counts; `authz` is this module's fact and is
        // merged over it by the shell seam.
        catalog: req.adminCatalog ?? null,
        navCounts: { authz: Array.isArray(listing?.policies) ? listing.policies.length : null },
      }));
    } catch (error) {
      next(error);
    }
  }

  router.get(routeBase, requireAdmin, (req, res, next) => tabPage(req, res, next));

  router.post(`${routeBase}/create`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      complete(req, res, view, urls, await admin.createPolicy(req.body, req.body?.expectedRevision));
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/update`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await admin.updatePolicy(String(req.body?.id ?? ""), req.body, req.body?.expectedRevision);
      complete(req, res, view, urls, result);
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/toggle`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await admin.setEnabled(String(req.body?.id ?? ""), req.body?.enabled, req.body?.expectedRevision);
      complete(req, res, view, urls, result);
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/delete`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await admin.deletePolicy(String(req.body?.id ?? ""), req.body?.expectedRevision);
      complete(req, res, view, urls, result);
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/preview`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const preview = await admin.previewForSubject(String(req.body?.subject ?? ""));
      await tabPage(req, res, next, preview);
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/repair`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await admin.repairFromCandidate(req.body?.document);
      complete(req, res, view, urls, result);
    } catch (error) {
      next(error);
    }
  });

  return { base: urls.base, actions: urls };
}
