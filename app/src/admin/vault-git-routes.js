// Wave E / E2 — Auth Center "Vault 与 Git" tab: routes, POST, CAS and validation.
//
// Contract authority: `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置`
//  - §17 / §17.1  Admin UX + action boundary (save config / refresh inventory /
//                 verify repo+config only: no repo creation, no credential
//                 editing, never a credential-bearing remote URL in a response);
//  - §17.2        reuse the existing Admin session + CSRF, add no lower-protected
//                 endpoint;
//  - §15 / §15.2  GitConfig record shape, hard bounds and the plain-git-name rule;
//  - §15.3        CAS: a stale revision is an explicit conflict, never
//                 last-write-wins;
//  - §15.4        primary record-less -> env-default, secondary -> default-disabled
//                 (the inheritance matrix is A5's, not re-implemented here);
//  - §16.2        the five Git states come from the runtime, never invented;
//  - §16.3        after a successful save the runtime re-reads the config and
//                 reconciles its timers;
//  - §30 E2, §38.3, §39  the slice and its test surface;
//  - §42 SEC-MV04 no secrets: validation is delegated to the A5 schema and every
//                 response echoes a frozen code plus a *static* hint only.
//
// This lane owns exactly one new source file, so it holds two layers:
//   - `createVaultGitAdmin(...)`  — assembles the E1 view-model from the injected
//     A2 registry, A5 store and A6/B4 runtimes, and owns the POST-side validation,
//     CAS write and §16.3 reload reconcile;
//   - `registerVaultGitRoutes(...)` — the thin HTTP layer over the Auth Center's
//     existing `requireAdmin` + `requireCsrf` guards and E1's pure renderer.
//
// Hard rules:
//  - the Admin plane is never gated by anything it manages (no policy evaluation,
//    no config read that could refuse the request);
//  - every write goes through `requireAdmin` + `requireCsrf` with the *existing*
//    session cookie and `csrf` field name: one auth scheme, no new endpoint class;
//  - config validation adds no second rule set — the request is narrowed to the
//    canonical record fields and the A5 schema decides bounds, URLs, credential
//    shapes, `-` prefixes and unknown keys;
//  - a runtime failure never 500s the page: a vault whose runtime throws is
//    rendered without runtime facts instead of taking the whole tab down.

import { GIT_CONFIG_CODES, resolveEffectiveGitConfig } from "../git-config/schema.js";
import { GIT_RUNTIME_STATES } from "../git-runtime/support.js";
import { CAPABILITY_KEYS } from "../vault-runtime/descriptor.js";
import { escapeHtml, renderVaultGitTab } from "./vault-git-view.js";
import { ADMISSION_CODES, registerVaultAdmissionRoutes } from "./vault-admission-admin.js";

/** The Auth Center nav id / tab token for this page. */
export const DEFAULT_TAB = "vault-git";
/** The Auth Center router is mounted here in `server.js`. */
export const DEFAULT_MOUNT_PATH = "/admin/auth";

/** Codes this layer adds on top of the A5 store codes. */
export const VAULT_GIT_CODES = Object.freeze({
  UNKNOWN_VAULT: "vault_git_unknown_vault",
  INVALID_FIELDS: "vault_git_invalid_fields",
  REGISTRY_UNAVAILABLE: "vault_git_registry_unavailable",
});

// Only a frozen field path may be shown as a hint; anything else is dropped so a
// response can never echo submitted content.
const SAFE_DETAIL = /^[A-Za-z0-9_.:[\]]{1,80}$/;
// The canonical A5 record fields a form may submit, and the form's own controls.
const RECORD_FIELDS = Object.freeze([
  "enabled", "autoCommit", "autoPush", "autoCommitSweep",
  "debounceSeconds", "maxDelaySeconds", "sweepIntervalSeconds", "remote", "branch",
]);
const BOOLEAN_FIELDS = Object.freeze(["enabled", "autoCommit", "autoPush", "autoCommitSweep"]);
const NUMBER_FIELDS = Object.freeze(["debounceSeconds", "maxDelaySeconds", "sweepIntervalSeconds"]);
const TEXT_FIELDS = Object.freeze(["remote", "branch"]);
const CONTROL_FIELDS = new Set(["csrf", "vaultId", "expectedRevision"]);

const CODE_HINTS = Object.freeze({
  [GIT_CONFIG_CODES.INVALID_RECORD]: "配置字段不合法：布尔项只能是 true/false，数字项必须是整数，remote/branch 只能是普通 git 名称（不得是 URL、不得含凭据、不得以 - 开头）。",
  [GIT_CONFIG_CODES.INVALID_VAULT_ID]: "Vault ID 不合法。",
  [GIT_CONFIG_CODES.LIMIT_EXCEEDED]: "配置数值越界或记录数超过上限，请按表单给出的上下界修改。",
  [GIT_CONFIG_CODES.UNSUPPORTED_SCHEMA]: "存储文档 schema 版本不受支持。",
  [GIT_CONFIG_CODES.INVALID_DOCUMENT]: "存储文档格式不正确。",
  [VAULT_GIT_CODES.INVALID_FIELDS]: "提交被拒绝：表单包含未知字段、非法的布尔/数值字面量，或缺少 CAS revision。",
  [VAULT_GIT_CODES.REGISTRY_UNAVAILABLE]: "Vault registry 刷新失败，请查看服务日志后重试。",
});

const STATUS_BY_CODE = Object.freeze({
  [ADMISSION_CODES.REFUSED]: 403,
  [GIT_CONFIG_CODES.STALE_REVISION]: 409,
  [GIT_CONFIG_CODES.STORE_IO]: 503,
  [VAULT_GIT_CODES.UNKNOWN_VAULT]: 404,
  [VAULT_GIT_CODES.REGISTRY_UNAVAILABLE]: 503,
});

function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 400;
}

function hintFor(result) {
  const code = String(result?.code ?? "");
  const hint = CODE_HINTS[code] ?? "提交被拒绝，请检查表单字段后重试。";
  const detail = typeof result?.detail === "string" && SAFE_DETAIL.test(result.detail) ? `（字段：${result.detail}）` : "";
  return `${hint}${detail}`;
}

/**
 * Resolve the public action URLs plus the router-relative base. `base` defaults to
 * `<mountPath>/vault-git`; `routeBase` strips `mountPath` because the Auth Center
 * router is mounted with `app.use(mountPath, router)`. E1's `DEFAULT_ACTIONS`
 * placeholders are always replaced by these real routes.
 */
export function resolveActions(actions = {}, mountPath = DEFAULT_MOUNT_PATH) {
  const base = String(actions.base ?? `${mountPath}/${DEFAULT_TAB}`).replace(/\/+$/, "") || `${mountPath}/${DEFAULT_TAB}`;
  const routeBase = base.startsWith(`${mountPath}/`) ? base.slice(mountPath.length) : base;
  return Object.freeze({
    base,
    routeBase,
    save: actions.save ?? `${base}/save`,
    refresh: actions.refresh ?? `${base}/refresh`,
    verify: actions.verify ?? `${base}/verify`,
  });
}

// ------------------------------------------------------------------ service --

function freezeConfig(effective) {
  return Object.freeze({
    enabled: effective.enabled,
    autoCommit: effective.autoCommit,
    autoPush: effective.autoPush,
    autoCommitSweep: effective.autoCommitSweep,
    debounceSeconds: effective.debounceSeconds,
    maxDelaySeconds: effective.maxDelaySeconds,
    sweepIntervalSeconds: effective.sweepIntervalSeconds,
    remote: effective.remote,
    branch: effective.branch,
    updatedAt: effective.updatedAt ?? null,
  });
}

/** `CAPABILITY_KEYS` order, so the rendered capability list is canonical. */
function capabilityList(descriptor) {
  const capabilities = descriptor?.capabilities;
  if (!capabilities || typeof capabilities !== "object") return [];
  return CAPABILITY_KEYS
    .filter((key) => Object.hasOwn(capabilities, key))
    .map((key) => ({
      key,
      available: capabilities[key]?.available === true,
      reason: typeof capabilities[key]?.reason === "string" ? capabilities[key].reason : null,
    }));
}

/**
 * The POST body, narrowed to the canonical record fields.
 *
 * Returns `{ ok: true, vaultId, expectedRevision, patch }` or
 * `{ ok: false, code, detail? }`. `detail` is picked from this module's frozen
 * field names only, never from caller input. A non-integer numeric literal is
 * passed through unchanged so the A5 schema rejects it with its own code — this
 * layer never decides bounds or name shapes (`-` prefix, URL, credential).
 */
function parseForm(body) {
  const source = body !== null && typeof body === "object" ? body : {};
  for (const key of Object.keys(source)) {
    if (!RECORD_FIELDS.includes(key) && !CONTROL_FIELDS.has(key)) {
      return { ok: false, code: VAULT_GIT_CODES.INVALID_FIELDS, detail: "unknown_field" };
    }
  }
  const vaultId = typeof source.vaultId === "string" ? source.vaultId : "";
  if (vaultId === "") return { ok: false, code: VAULT_GIT_CODES.UNKNOWN_VAULT };
  const rawRevision = typeof source.expectedRevision === "string" ? source.expectedRevision : "";
  if (!/^\d+$/.test(rawRevision)) return { ok: false, code: VAULT_GIT_CODES.INVALID_FIELDS, detail: "expectedRevision" };

  const patch = {};
  for (const key of BOOLEAN_FIELDS) {
    if (source[key] === undefined) continue;
    // Hidden+checkbox may post both; last value wins.
    const raw = Array.isArray(source[key]) ? source[key][source[key].length - 1] : source[key];
    if (raw !== "true" && raw !== "false") return { ok: false, code: VAULT_GIT_CODES.INVALID_FIELDS, detail: key };
    patch[key] = raw === "true";
  }
  for (const key of NUMBER_FIELDS) {
    if (source[key] === undefined) continue;
    const raw = source[key];
    patch[key] = typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
  for (const key of TEXT_FIELDS) {
    if (source[key] === undefined) continue;
    patch[key] = source[key];
  }
  return { ok: true, vaultId, expectedRevision: Number(rawRevision), patch };
}

/**
 * `createVaultGitAdmin({ registry, store, runtimeFor, envDefaults, logger })`.
 *
 * `registry` is the A2 canonical registry (`list`/`snapshot`/`refresh`); `store`
 * is the A5 GitConfig store (`snapshot`/`upsertVault`); `runtimeFor(vaultId)`
 * returns the A6/B4 runtime for that Vault or `null`; `envDefaults()` returns the
 * deployment's `GIT_*` baseline for the §15.4 inheritance matrix (this module
 * never reads `config.js` or `process.env`).
 *
 * Returns `{ model, save, refreshInventory, verify }`.
 */
export function createVaultGitAdmin({ registry, store, runtimeFor = () => null, envDefaults = () => ({}), logger = null } = {}) {
  if (!registry || typeof registry.list !== "function" || typeof registry.snapshot !== "function") {
    throw new TypeError("createVaultGitAdmin requires the A2 registry (list/snapshot)");
  }
  if (!store || typeof store.snapshot !== "function" || typeof store.upsertVault !== "function") {
    throw new TypeError("createVaultGitAdmin requires the A5 GitConfig store (snapshot/upsertVault)");
  }

  function isKnownVault(vaultId) {
    return typeof vaultId === "string" && registry.list().some((vault) => vault?.id === vaultId);
  }

  function safeStatus(runtime) {
    if (!runtime || typeof runtime.status !== "function") return null;
    try {
      return runtime.status();
    } catch (error) {
      logger?.warn?.(`vault-git: runtime status failed: ${error?.message ?? error}`);
      return null;
    }
  }

  /** §16.3: the runtime re-reads the config and reconciles its timers. */
  async function reconcile(vaultId) {
    const runtime = runtimeFor(vaultId);
    if (!runtime || typeof runtime.reloadConfig !== "function") return null;
    try {
      return await runtime.reloadConfig();
    } catch (error) {
      // The write is already durable; a failed reconcile must not be reported as a
      // failed save. The runtime reconciles again on the next start/reload.
      logger?.warn?.(`vault-git: config reload failed for ${vaultId}: ${error?.message ?? error}`);
      return null;
    }
  }

  function toVault(descriptor, record, editable) {
    let config = null;
    let configSource = null;
    let resolutionError = null;
    try {
      const effective = resolveEffectiveGitConfig({
        vaultId: descriptor.id,
        primary: descriptor.primary === true,
        record,
        envDefaults: envDefaults(),
      });
      config = freezeConfig(effective);
      configSource = effective.source;
    } catch (error) {
      resolutionError = { name: error?.name ?? "Error", message: error?.message ?? String(error) };
    }
    const status = registry.refusesGit?.(descriptor.id) ? null : safeStatus(runtimeFor(descriptor.id));
    const pending = status?.pending ?? null;
    const paths = Array.isArray(pending?.paths) ? pending.paths : [];
    return {
      id: descriptor.id,
      name: descriptor.name,
      primary: descriptor.primary === true,
      writable: descriptor.writable === true,
      root: typeof descriptor.root === "string" ? descriptor.root : null,
      canonicalRoot: typeof descriptor.canonicalRoot === "string" ? descriptor.canonicalRoot : null,
      editable,
      admission: descriptor.admission ?? null,
      capabilities: capabilityList(descriptor),
      git: {
        // A missing runtime is reported as unknown, never guessed into a state.
        state: typeof status?.state === "string" ? status.state : (resolutionError ? GIT_RUNTIME_STATES.CONFIG_INVALID : null),
        repository: typeof status?.repository === "string" ? status.repository : null,
        configSource,
        configError: status?.configError ?? resolutionError,
        config,
        pending: {
          count: paths.length,
          paths,
          authors: Array.isArray(pending?.authors) ? pending.authors : [],
          since: pending?.pendingSince ?? null,
        },
        dirty: typeof status?.dirty === "boolean" ? status.dirty : null,
        timers: status?.timers ?? null,
        lastSweep: status?.lastSweep ?? null,
        push: status?.push ?? null,
      },
    };
  }

  async function model({ notice = null } = {}) {
    const storeSnapshot = store.snapshot();
    const records = storeSnapshot.status === "ready" ? storeSnapshot.vaults : {};
    // A broken store fails closed: every form is disabled and the repair card is
    // rendered instead of letting an operator submit a write that cannot land.
    const editable = storeSnapshot.status === "ready";
    const vaults = registry.list().map((descriptor) => toVault(descriptor, records[descriptor.id] ?? null, editable && !registry.refusesGit?.(descriptor.id)));
    const primary = vaults.find((vault) => vault.primary === true);
    return {
      vaults,
      revision: storeSnapshot.revision,
      status: storeSnapshot.status,
      broken: storeSnapshot.status === "broken" ? { errorCode: storeSnapshot.errorCode ?? null } : null,
      defaultVaultId: primary?.id ?? null,
      notice,
      admission: registry.admissionModel?.() ?? null,
    };
  }

  async function save(body) {
    const parsed = parseForm(body);
    if (!parsed.ok) return parsed;
    if (!isKnownVault(parsed.vaultId)) return { ok: false, code: VAULT_GIT_CODES.UNKNOWN_VAULT };
    if (registry.refusesGit?.(parsed.vaultId)) return { ok: false, code: ADMISSION_CODES.REFUSED };
    // A broken store fails closed with one honest code: the store's own corruption
    // code would be reported as a client error, but the operator cannot fix it from
    // this form. CAS/stale semantics only apply to a readable store.
    if (store.snapshot()?.status !== "ready") return { ok: false, code: GIT_CONFIG_CODES.STORE_IO };
    const result = await store.upsertVault(parsed.vaultId, parsed.patch, { expectedRevision: parsed.expectedRevision });
    if (!result?.ok) return { ok: false, code: result?.code ?? GIT_CONFIG_CODES.STORE_IO };
    await reconcile(parsed.vaultId);
    return { ok: true, vaultId: parsed.vaultId, revision: result.revision };
  }

  async function refreshInventory() {
    if (typeof registry.refresh !== "function") return { ok: false, code: VAULT_GIT_CODES.REGISTRY_UNAVAILABLE };
    try {
      const result = await registry.refresh();
      if (result?.status === "coalesced") return { ok: true, httpStatus: 202, notice: "统一刷新已合并；等待当前轮次完成。" };
    } catch (error) {
      logger?.warn?.(`vault-git: registry refresh failed: ${error?.message ?? error}`);
      return { ok: false, code: VAULT_GIT_CODES.REGISTRY_UNAVAILABLE };
    }
    const revision = registry.snapshot()?.revision;
    return { ok: true, notice: `Vault 清单已刷新（registry revision ${revision ?? "—"}）。未创建任何 repo，也未改动凭据。` };
  }

  /** §17.1 read-only verification: re-read config + probe repo presence. */
  async function verify(vaultId) {
    if (!isKnownVault(vaultId)) return { ok: false, code: VAULT_GIT_CODES.UNKNOWN_VAULT };
    if (registry.refusesGit?.(vaultId)) return { ok: false, code: ADMISSION_CODES.REFUSED };
    const runtime = runtimeFor(vaultId);
    if (!runtime || typeof runtime.status !== "function") {
      return { ok: true, notice: `${vaultId} 没有 Git 运行时；本页不创建 repo，也不改动配置。` };
    }
    await reconcile(vaultId);
    const status = safeStatus(runtime);
    return {
      ok: true,
      notice: `已重新读取 ${vaultId} 的配置并探测仓库：状态 ${status?.state ?? "unknown"} · repository=${status?.repository ?? "unknown"}。`,
    };
  }

  return Object.freeze({ model, save, refreshInventory, verify });
}

// ------------------------------------------------------------------- routes --

function shell(view, session, base, body, title = "Obsidian MCP · 授权管理", extra = {}) {
  // W4–W8: unified left/bottom nav shell (no horizontal .tabs chrome).
  if (typeof view.renderAuthShell === "function") {
    return view.renderAuthShell({
      activeTab: "vault-git",
      vaultGitBase: base,
      accessPolicyBase: extra.accessPolicyBase || null,
      session,
      content: body,
      theme: extra.theme || "dark",
      navCounts: extra.navCounts || {},
      navAttention: extra.navAttention || {},
      detailPanel: extra.detailPanel || "",
    });
  }
  const logout = `<form class="inline" method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(session?.csrf ?? "")}"><button class="btn secondary" type="submit">退出</button></form>`;
  const header = `<header class="topbar"><div><h1>Obsidian MCP</h1><p class="subtitle">Vault 与 Git</p></div><div class="actions"><a class="btn secondary" href="/admin/auth">返回授权管理</a>${logout}</div></header>`;
  return view.layout(title, `${header}${view.nav(DEFAULT_TAB, base)}${body}`);
}

function sendFailure(req, res, view, urls, result) {
  const code = String(result?.code ?? "");
  const status = statusForCode(code);
  const title = status === 409
    ? "配置已被他人修改"
    : status === 404 ? "Vault 不存在" : status === 503 ? "Git 配置存储或 registry 不可用" : "配置提交被拒绝";
  const message = status === 409
    ? "该 Vault 的 Git 配置在你提交前已被修改（revision 冲突）。为避免覆盖他人的修改，本次提交未生效。请刷新后重试。"
    : hintFor(result);
  const body = `<section class="card login"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="muted">错误码 <code>${escapeHtml(code || "unknown")}</code></p><p><a class="btn secondary" href="${escapeHtml(urls.base)}">返回 Vault 与 Git</a></p></section>`;
  res.status(status).send(shell(view, req.adminSession, urls.base, body, title));
}

/**
 * `registerVaultGitRoutes(router, { admin, view, requireAdmin, requireCsrf, actions, mountPath })`.
 *
 * Registers `GET {base}` and `POST {base}/{save|refresh|verify}` on the Auth
 * Center router using its existing session + CSRF guards. Returns
 * `{ base, actions }`, or `null` when no per-vault Git admin service is injected
 * (then the tab is absent and no route is registered — zero behavior difference).
 */
export function registerVaultGitRoutes(router, {
  admin,
  view,
  requireAdmin,
  requireCsrf,
  actions = {},
  mountPath = DEFAULT_MOUNT_PATH,
  accessPolicyBase = null,
} = {}) {
  if (!admin) return null;
  const hasV2Shell = typeof view?.renderAuthShell === "function";
  const hasLegacyShell = typeof view?.layout === "function" && typeof view?.nav === "function";
  if (!hasV2Shell && !hasLegacyShell) {
    throw new TypeError("registerVaultGitRoutes requires view.renderAuthShell (or legacy view.layout + view.nav)");
  }
  const urls = resolveActions(actions, mountPath);
  const { routeBase } = urls;

  async function tabPage(req, res, next, notice = null) {
    try {
      const model = await admin.model({ notice });
      const selectedId = typeof req.query?.id === "string" ? req.query.id.trim() : null;
      const confirm = typeof req.query?.confirm === "string" ? req.query.confirm.trim() : "";
      const fragment = renderVaultGitTab({
        ...model,
        csrfToken: req.adminSession?.csrf ?? "",
        actions: urls,
        selectedId,
        confirmRepair: confirm === "repair",
      });
      res.send(shell(view, req.adminSession, urls.base, fragment, undefined, {
        accessPolicyBase,
        navCounts: { vaults: Array.isArray(model?.vaults) ? model.vaults.length : null },
      }));
    } catch (error) {
      next(error);
    }
  }

  router.get(routeBase, requireAdmin, (req, res, next) => tabPage(req, res, next));
  registerVaultAdmissionRoutes(router, { admin, routeBase, requireAdmin, requireCsrf, tabPage,
    sendFailure: (req, res, result) => sendFailure(req, res, view, urls, result) });

  router.post(`${routeBase}/save`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await admin.save(req.body);
      if (result?.ok) {
        res.redirect(303, urls.base);
        return;
      }
      sendFailure(req, res, view, urls, result);
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/refresh`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const result = await admin.refreshInventory();
      if (!result?.ok) {
        sendFailure(req, res, view, urls, result);
        return;
      }
      res.status(result.httpStatus ?? 200);
      await tabPage(req, res, next, result.notice ?? null);
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/verify`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const vaultId = typeof req.body?.vaultId === "string" ? req.body.vaultId : "";
      const result = await admin.verify(vaultId);
      if (!result?.ok) {
        sendFailure(req, res, view, urls, result);
        return;
      }
      await tabPage(req, res, next, result.notice ?? null);
    } catch (error) {
      next(error);
    }
  });

  return { base: urls.base, actions: urls };
}
