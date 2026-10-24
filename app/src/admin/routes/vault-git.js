// Vault 与 Git routes — owned by lane W4-vaults (greenfield Admin plane).
//
// The page is `pages/vaults.js` (an SSR port of `docs/admin-ui-proto/src/5-render.js:456-473` and
// the Vault drawer in `src/6-app.js:219-362`); this module is only the HTTP layer over the *existing*
// service contract `createVaultGitAdmin(...).{model,save,refreshInventory,verify}`
// (`src/admin/vault-git-routes.js`, kept as the service/validation layer) plus the W2 admission
// trigger (`vault-admission-admin.js`).
//
// What did not change (docs/admin/README.md + `DEVELOPMENT - MCP 多库…` §17):
//   * the endpoints and their guards: `GET <base>` and `POST <base>/{save,refresh,verify}` +
//     `<base>/admission/{initialize,approve,revoke}`, all behind the Auth Center's own `requireAdmin`
//     + `requireCsrf` (no new endpoint class, no lower protection);
//   * `expectedRevision` CAS on every save — a stale revision stays an explicit conflict (409), never
//     last-write-wins;
//   * the action boundary: no repo creation, no credential editing, no credential-bearing remote URL
//     in a response, and only frozen codes/field names are echoed (never submitted content);
//   * the Admin plane is never gated by what it manages: a broken Git config store still renders the
//     page read-only and fails writes closed;
//   * `registerVaultGitRoutes` still returns `{ base, actions }` (or `null` when the service is
//     absent), so the tab and every route disappear together.
//
// Added in the repair slice (owner decision 2026-10-18): `POST <base>/repair`, the real action behind
// the prototype's 重置为默认并修复… button (`docs/admin-ui-proto/src/5-render.js:468`,
// `src/6-app.js:351`). It is the ONLY route that can act on a broken store, and it acts on nothing
// else:
//   * a store that is readable right now is refused with 409 (healthy configuration is never
//     overwritten); the state is re-read per request, never taken from the submitted page;
//   * the corrupt file is isolated (renamed, never deleted) and only then is an empty A5 document
//     committed through the store's own write path; an isolation failure is a 503 with zero writes;
//   * the type-to-confirm text is checked **on the server**; the confirm page's browser state is
//     never the gate;
//   * success and refusal both leave one audit entry (`admin.git-config.repair`), carrying a frozen
//     code or the isolation path — never the stored document, never a credential;
//   * the route exists only when a store with `repair()` is injected. Without that wiring the page
//     renders no repair CTA at all (no fake CTA) and the URL answers 503 without touching anything.
//
// No script (CSP `default-src 'none'`): a write is a real POST form, the result is a `.result` line
// rendered together with the page (the prototype's toast), and the drawer is the `?id=` GET state.
import { GIT_CONFIG_CODES } from "../../git-config/schema.js";
import { GIT_CONFIG_REPAIR_CODES as STORE_REPAIR_CODES } from "../../git-config/store.js";
import { REPAIR_CONFIRM_TEXT, renderVaultsPage } from "../pages/vaults.js";
import { source } from "../http.js";
import { ADMISSION_CODES, registerVaultAdmissionRoutes } from "../vault-admission-admin.js";

/** The Auth Center nav id / tab token for this page. */
export const DEFAULT_TAB = "vault-git";
/** The Auth Center router is mounted here in `server.js`. */
export const DEFAULT_MOUNT_PATH = "/admin/auth";

/**
 * The codes `createVaultGitAdmin` reports through HTTP. The values are the frozen strings of the
 * service module `vault-git-routes.js`; the new plane imports no legacy view code, and
 * `app/test/admin-redo/vaults.test.js` pins these values against that module so they cannot drift.
 */
export const VAULT_GIT_CODES = Object.freeze({
  UNKNOWN_VAULT: "vault_git_unknown_vault",
  INVALID_FIELDS: "vault_git_invalid_fields",
  REGISTRY_UNAVAILABLE: "vault_git_registry_unavailable",
});

/**
 * Repair-only codes. The store's own codes are imported, not copied, so a rename cannot drift; the
 * two `vault_git_repair_*` values are this layer's own and describe an HTTP-level refusal.
 */
export const VAULT_GIT_REPAIR_CODES = Object.freeze({
  NOT_NEEDED: STORE_REPAIR_CODES.NOT_NEEDED,
  ISOLATE_FAILED: STORE_REPAIR_CODES.ISOLATE_FAILED,
  CONFIRM_MISMATCH: "vault_git_repair_confirm_mismatch",
  NOT_WIRED: "vault_git_repair_not_wired",
});

/** The audit action of both outcomes; the credential type stays the Admin session's. */
export const REPAIR_AUDIT_ACTION = "admin.git-config.repair";

/** The result line each successful write renders (the prototype shows a toast). */
const SUCCESS_NOTICE = Object.freeze({
  save: "Git 设置已保存；运行时已重新读取配置并重排定时器。",
  refresh: "Vault 清单已刷新（未创建任何目录，也未改动任何凭据）。",
  verify: "已重新读取配置并探测仓库；结果见抽屉「状态」。",
});

/** Frozen hints by code — static text only, so a response can never echo submitted content. */
const CODE_HINTS = Object.freeze({
  [GIT_CONFIG_CODES.INVALID_RECORD]: "配置字段不合法：布尔项只能是 true/false，数字项必须是整数，remote/branch 只能是普通 git 名称（不得是 URL、不得含凭据、不得以 - 开头）。",
  [GIT_CONFIG_CODES.INVALID_VAULT_ID]: "Vault ID 不合法。",
  [GIT_CONFIG_CODES.LIMIT_EXCEEDED]: "配置数值越界或记录数超过上限，请按表单给出的上下界修改。",
  [GIT_CONFIG_CODES.UNSUPPORTED_SCHEMA]: "存储文档 schema 版本不受支持。",
  [GIT_CONFIG_CODES.INVALID_DOCUMENT]: "存储文档格式不正确。",
  [GIT_CONFIG_CODES.STALE_REVISION]: "该 Vault 的 Git 配置在你提交前已被修改（revision 冲突）。为避免覆盖他人的修改，本次提交未生效；页面已重新读取最新版本，请确认后重试。",
  [GIT_CONFIG_CODES.STORE_IO]: "Git 配置存储当前不可写（fail closed）。没有改动任何设置；请先按部署排查说明修复存储文件。",
  [VAULT_GIT_CODES.INVALID_FIELDS]: "提交被拒绝：表单包含未知字段、非法的布尔/数值字面量，或缺少 CAS revision。",
  [VAULT_GIT_CODES.UNKNOWN_VAULT]: "Vault 不存在或已从清单中移除。",
  [VAULT_GIT_CODES.REGISTRY_UNAVAILABLE]: "Vault registry 刷新失败，请查看服务日志后重试。",
  [ADMISSION_CODES.REFUSED]: "该 Vault 的准入决定不是当前有效的 servable 版本：Git 写操作被拒绝。",
  [ADMISSION_CODES.INVALID]: "准入请求不合法（字段或状态不允许该操作）。",
  [ADMISSION_CODES.UNAVAILABLE]: "准入服务不可用或统一刷新未提交，请查看服务日志后重试。",
  [VAULT_GIT_REPAIR_CODES.NOT_NEEDED]: "Git 配置存储当前可读，不需要修复：本次没有写入任何内容。若磁盘文件已被外部修复，存储已直接采用该文档。",
  [VAULT_GIT_REPAIR_CODES.ISOLATE_FAILED]: "无法隔离损坏的配置文件（文件不存在或目录不可写）：未写入任何内容，存储保持原状。请按部署排查说明处理。",
  [VAULT_GIT_REPAIR_CODES.CONFIRM_MISMATCH]: `确认文本不匹配：请在确认页输入「${REPAIR_CONFIRM_TEXT}」后再提交。没有改动任何文件。`,
  [VAULT_GIT_REPAIR_CODES.NOT_WIRED]: "此部署没有接线 Git 配置修复路径（服务层未注入 store/provider）：修复请求被拒绝，未写入任何内容。",
});

const STATUS_BY_CODE = Object.freeze({
  [GIT_CONFIG_CODES.STALE_REVISION]: 409,
  [GIT_CONFIG_CODES.STORE_IO]: 503,
  [VAULT_GIT_CODES.UNKNOWN_VAULT]: 404,
  [VAULT_GIT_CODES.REGISTRY_UNAVAILABLE]: 503,
  [ADMISSION_CODES.REFUSED]: 403,
  [ADMISSION_CODES.UNAVAILABLE]: 503,
  [VAULT_GIT_REPAIR_CODES.NOT_NEEDED]: 409,
  [VAULT_GIT_REPAIR_CODES.ISOLATE_FAILED]: 503,
  [VAULT_GIT_REPAIR_CODES.CONFIRM_MISMATCH]: 403,
  [VAULT_GIT_REPAIR_CODES.NOT_WIRED]: 503,
});

/** A frozen field path may be named as a hint; anything else is dropped. */
const SAFE_DETAIL = /^[A-Za-z0-9_.:[\]]{1,80}$/;

export function statusForCode(code) {
  return STATUS_BY_CODE[code] ?? 400;
}

/** The operator-facing error text for a service result: frozen hint + optional frozen field path. */
export function failureNotice(result) {
  const code = String(result?.code ?? "");
  const hint = CODE_HINTS[code] ?? "提交被拒绝，请检查表单字段后重试。";
  const detail = typeof result?.detail === "string" && SAFE_DETAIL.test(result.detail) ? `（字段：${result.detail}）` : "";
  return { tone: "err", message: `${hint}${detail}`, code };
}

/**
 * Public action URLs plus the router-relative base. `base` defaults to `<mountPath>/vault-git`;
 * `routeBase` strips `mountPath` because the Auth Center router is mounted with
 * `app.use(mountPath, router)`. `admission` is `null` unless the injected admin exposes the W2
 * admission trigger, so the page can never render a dead admissions form.
 */
export function resolveActions(actions = {}, mountPath = DEFAULT_MOUNT_PATH, { admission = false } = {}) {
  const fallback = `${mountPath}/${DEFAULT_TAB}`;
  const base = String(actions.base ?? fallback).replace(/\/+$/, "") || fallback;
  const routeBase = base.startsWith(`${mountPath}/`) ? base.slice(mountPath.length) : base;
  return Object.freeze({
    base,
    routeBase,
    save: actions.save ?? `${base}/save`,
    refresh: actions.refresh ?? `${base}/refresh`,
    verify: actions.verify ?? `${base}/verify`,
    // Always resolved: the page decides whether to render it, the route whether it can act.
    repair: actions.repair ?? `${base}/repair`,
    admission: actions.admission ?? (admission ? `${base}/admission` : null),
  });
}

/**
 * `registerVaultGitRoutes(router, { admin, view, requireAdmin, requireCsrf, actions, mountPath })`.
 *
 * Returns `{ base, actions }`, or `null` when no per-Vault Git admin service is injected (then the
 * tab is absent and no route is registered — zero behaviour difference).
 */
export function registerVaultGitRoutes(router, {
  admin,
  view,
  requireAdmin,
  requireCsrf,
  actions = {},
  mountPath = DEFAULT_MOUNT_PATH,
  accessPolicyBase = null,
  provider = null,
  gitConfigStore = null,
} = {}) {
  if (!admin) return null;
  const hasV2Shell = typeof view?.renderAuthShell === "function";
  const hasLegacyShell = typeof view?.layout === "function" && typeof view?.nav === "function";
  if (!hasV2Shell && !hasLegacyShell) {
    throw new TypeError("registerVaultGitRoutes requires view.renderAuthShell (or legacy view.layout + view.nav)");
  }
  const urls = resolveActions(actions, mountPath, { admission: typeof admin.admissionAction === "function" });
  const { routeBase } = urls;
  // The repair route acts on the A5 store itself, so it is only real when that store is injected. An
  // unwired deployment keeps the honest read-only page and never offers a CTA it cannot honour.
  const repairStore = gitConfigStore && typeof gitConfigStore.repair === "function" ? gitConfigStore : null;
  const repairWired = repairStore !== null;
  const auditRepair = (req, event) => {
    // Frozen action/code/path facts only: the stored document and any credential never enter here.
    provider?.recordAudit?.({ action: REPAIR_AUDIT_ACTION, credentialType: "admin-session", source: source(req), ...event });
  };

  /**
   * Render the page for one request. Every response (GET, successful write, refused write) is the
   * same page with a fresh model, so a refused CAS always shows the revision that is now current —
   * the operator never has to guess, and no separate error page can drift from the page contract.
   */
  function render(req, model, { notice = null, status = 200, query = req.query || {} } = {}) {
    const page = renderVaultsPage({
      vaultGit: { wired: true, model, error: null },
      csrf: req.adminSession?.csrf ?? "",
      actions: urls,
      query,
      notice,
      repairWired,
    });
    const options = {
      activeTab: DEFAULT_TAB,
      vaultGitBase: urls.base,
      accessPolicyBase,
      session: req.adminSession,
      request: req,
      content: page.content,
      detailPanel: page.detailPanel,
      navCounts: { vaults: Array.isArray(model?.vaults) ? model.vaults.length : null },
      // The request's own catalog (theme, sidebar counts, attention dots) — never a module-level
      // cache, which would show another session's snapshot on a cold first hit (#399 review R4).
      catalog: req.adminCatalog || null,
    };
    const body = typeof view.renderAuthShell === "function"
      ? view.renderAuthShell(options)
      : view.layout("Obsidian MCP · 授权管理", view.nav(DEFAULT_TAB, urls.base) + page.content);
    return { status, body };
  }

  async function reply(req, res, { notice = null, status = 200, id = null } = {}) {
    const model = await admin.model({ notice: null });
    const text = notice ?? (typeof model?.notice === "string" ? model.notice : null);
    // A write answers on the page with the submitted vault's drawer open (the prototype keeps the
    // drawer and shows a toast); the id is only ever used to *select* a row, never rendered.
    const query = id === null ? req.query || {} : { ...(req.query || {}), id };
    const rendered = render(req, model, { notice: text, status, query });
    res.status(rendered.status).send(rendered.body);
  }

  /** Run one service call and answer with the page + the honest result line. */
  async function write(req, res, { action, run }) {
    const result = await run(req);
    const id = typeof req.body?.vaultId === "string" ? req.body.vaultId : null;
    if (result && result.ok === false) {
      await reply(req, res, { status: statusForCode(result.code), notice: failureNotice(result), id: action === "refresh" ? null : id });
      return;
    }
    const notice = typeof result?.notice === "string" ? result.notice : SUCCESS_NOTICE[action];
    await reply(req, res, { status: result?.httpStatus ?? 200, notice, id: action === "refresh" ? null : id });
  }

  const guard = (handler) => (req, res, next) => {
    handler(req, res, next).catch(next);
  };

  router.get(routeBase, requireAdmin, guard(async (req, res) => {
    await reply(req, res);
  }));

  /**
   * `POST <base>/repair` — the only action that may touch a broken store.
   *
   * Order matters and is the security contract: re-read the store (never trust the submitted page),
   * refuse a readable store (409), check the confirm text on the server (403), then let the store
   * isolate + reset (503 on any IO refusal). Every outcome is audited exactly once.
   */
  router.post(`${routeBase}/repair`, requireAdmin, requireCsrf, guard(async (req, res) => {
    const refuse = async (code, detail, extra = "") => {
      auditRepair(req, { outcome: "failure", detail });
      const notice = failureNotice({ code });
      // `extra` is used for one thing only: the isolation path of the rare write-then-rollback-failed
      // case, so the preserved content is never lost track of. It is rendered through the page's
      // escaping/scrubbing like every other notice.
      await reply(req, res, { status: statusForCode(code), notice: extra ? { ...notice, message: `${notice.message}${extra}` } : notice });
    };
    if (!repairWired) {
      await refuse(VAULT_GIT_REPAIR_CODES.NOT_WIRED, VAULT_GIT_REPAIR_CODES.NOT_WIRED);
      return;
    }
    let readable = null;
    try {
      readable = await repairStore.read();
    } catch {
      readable = null;
    }
    if (readable?.status === "ready" || repairStore.snapshot?.().status === "ready") {
      await refuse(VAULT_GIT_REPAIR_CODES.NOT_NEEDED, VAULT_GIT_REPAIR_CODES.NOT_NEEDED);
      return;
    }
    const confirm = typeof req.body?.confirm === "string" ? req.body.confirm.trim() : "";
    if (confirm !== REPAIR_CONFIRM_TEXT) {
      await refuse(VAULT_GIT_REPAIR_CODES.CONFIRM_MISMATCH, VAULT_GIT_REPAIR_CODES.CONFIRM_MISMATCH);
      return;
    }
    let result;
    try {
      result = await repairStore.repair();
    } catch {
      result = { ok: false, code: GIT_CONFIG_CODES.STORE_IO };
    }
    if (!result?.ok) {
      const code = result?.code ?? GIT_CONFIG_CODES.STORE_IO;
      const stranded = typeof result?.isolatedPath === "string" ? result.isolatedPath : null;
      await refuse(code, String(code), stranded === null ? "" : ` 原损坏文件已移到 ${stranded}（内容未丢）。`);
      return;
    }
    auditRepair(req, { outcome: "success", detail: "reset_to_defaults" });
    // §16.3: the reset dropped *every* vault's record, so every bound runtime has to re-read the
    // config (the same reconcile `save` performs). Runtimes are only reachable through the service,
    // so this uses its documented read-only `verify` (reload + status probe). A runtime that refuses
    // or throws never re-opens the repair: the store is already durable, and the page reports the
    // state it actually has.
    let reconciled = 0;
    try {
      const fresh = await admin.model({ notice: null });
      for (const vault of Array.isArray(fresh?.vaults) ? fresh.vaults : []) {
        if ((await admin.verify(vault?.id ?? ""))?.ok) reconciled += 1;
      }
    } catch { /* best effort: the repair itself already succeeded */ }
    const isolated = typeof result.isolatedPath === "string" ? result.isolatedPath : null;
    const where = isolated === null ? "损坏文件已隔离。" : `损坏文件已隔离为 ${isolated}（未删除，可随时找回）。`;
    const runtime = reconciled > 0 ? `运行时已重新读取配置（${reconciled} 个 Vault）。` : "运行时在下次配置重读时对齐。";
    await reply(req, res, {
      notice: {
        tone: "ok",
        message: `Git 配置存储已修复：${where}配置已重置为默认（各 Vault 回退为默认设置，不自动提交）；${runtime}`,
      },
    });
  }));

  registerVaultAdmissionRoutes(router, {
    admin,
    routeBase,
    requireAdmin,
    requireCsrf,
    // `tabPage` re-renders the same page; it must keep the status the admission helper already
    // chose (202 for a coalesced decision = "saved, the round is still running"), so the status is
    // read back from the response instead of being reset to 200 by the page render.
    tabPage: (req, res, next, notice) => reply(req, res, { notice: typeof notice === "string" ? notice : null, status: res.statusCode }).catch(next),
    // The legacy admission wrapper calls this without awaiting; answer explicitly and never leave
    // the response open on an internal failure.
    sendFailure: (req, res, result) => {
      reply(req, res, { status: statusForCode(result?.code), notice: failureNotice(result) })
        .catch(() => res.status(500).end());
    },
  });

  const writes = [
    {
      action: "save",
      path: "/save",
      run: async (req) => {
        const body = req.body ?? {};
        // No CAS token can only come from a page that had no readable revision (an unreadable
        // store disables the form). Report the store, not a field: the operator cannot fix a
        // missing revision, and the write is refused either way.
        if (!/^\d+$/.test(String(body.expectedRevision ?? ""))) {
          const current = await admin.model({});
          if (current?.status && current.status !== "ready") return { ok: false, code: GIT_CONFIG_CODES.STORE_IO };
        }
        return admin.save(body);
      },
    },
    { action: "refresh", path: "/refresh", run: () => admin.refreshInventory() },
    { action: "verify", path: "/verify", run: (req) => admin.verify(typeof req.body?.vaultId === "string" ? req.body.vaultId : "") },
  ];
  for (const write_ of writes) {
    router.post(`${routeBase}${write_.path}`, requireAdmin, requireCsrf, guard(async (req, res) => {
      await write(req, res, write_);
    }));
  }

  return { base: urls.base, actions: urls };
}
