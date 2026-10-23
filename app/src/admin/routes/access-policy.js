// 定时授权 (access-policy) route module — the lane's replacement for the legacy shim.
//
// Owned surface: `GET {base}` (list, `?id=` drawer, `?edit=`/`?new=`/`?copy=` editor, `?confirm=delete`
// confirm page) plus the write endpoints `POST {base}/{create,update,toggle,delete,preview,repair}`.
// Service semantics are unchanged and remain the authority: `createPolicy` / `updatePolicy` (incl.
// `setEnabled`) / `deletePolicy` / `previewForSubject` / `repairFromCandidate`, the store CAS
// (`expectedRevision`) and the schema validation all run exactly as before — this module only
// decodes the form, renders the prototype's markup (see `pages/authz.js`, `pages/authz-editor.js`)
// and maps a rejection to a status code plus an honest message.
//
// Hard rules kept from the frozen contract (`scratch/authz/INTERFACE.md` §10.4/§10.6):
//   * every write goes through `requireAdmin` + `requireCsrf` with the *existing* session cookie and
//     the `csrf` field name — no second auth scheme, no new endpoint class;
//   * the Admin plane is never gated by the policy it manages: nothing here calls `runtime.evaluate`
//     (only the read-only `previewForSubject` reaches `runtime.explain`, through the service);
//   * a stale CAS is never last-write-wins: the store decides, we surface 409 and keep the submitted
//     draft on screen while still carrying the *stale* revision, so a resubmit is rejected again;
//   * a broken store still renders the repair surface (the store read never throws into the page);
//   * no policy JSON, credential secret or token is echoed back except the operator's own submitted
//     repair document (returned to the textarea they typed it in) — never into a URL or a log.
//
// No script (D0 HOLD): results are `.result` lines, danger actions go through a separate confirm
// page (`ui.confirmPage`), and the two GET filters (`?capq=` / `?subjq=`) sit *above* the POST form
// because a nested `<form>` is not a form.
import { buildCatalog } from "../catalog.js";
import { ACCESS_POLICY_CODES } from "../../access-policy/errors.js";
import { ACCESS_POLICY_ADMIN_CODES, orphanedSubjects, snapshotSubjects } from "../access-policy.js";
import { capabilityCatalog } from "../capabilities.js";
import { clean } from "../http.js";
import { confirmPage } from "../ui.js";
import { esc } from "../presentation/format.js";
import { zonedParts } from "../presentation/model.js";
import { renderAuthzPage } from "../pages/authz.js";
import { renderAuthzEditorPage, resolveWeeklyPreset } from "../pages/authz-editor.js";

/** Public default base URL, frozen by the C2 BRIEF §1.1. */
export const DEFAULT_BASE = "/admin/auth/access-policy";
/** The Auth Center router is mounted here in `server.js`. */
export const DEFAULT_MOUNT_PATH = "/admin/auth";

const WEEK_DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

// A schema `details.path` (e.g. `policies[0].label`) is safe to show as a field hint; anything else
// is dropped so a message can never smuggle a value.
const SAFE_DETAIL = /^[A-Za-z0-9_.:\[\]-]{1,80}$/;

const CODE_HINTS = Object.freeze({
  [ACCESS_POLICY_CODES.INVALID_DOCUMENT]: "策略文档格式不正确，请检查提交的字段。",
  [ACCESS_POLICY_CODES.INVALID_POLICY]: "策略记录不合法，请检查模式、能力、时区或时间窗口。",
  [ACCESS_POLICY_CODES.UNSUPPORTED_SCHEMA]: "不支持的策略 schema 版本。",
  [ACCESS_POLICY_CODES.LIMIT_EXCEEDED]: "策略数量或窗口段数超过上限。",
  [ACCESS_POLICY_CODES.UNKNOWN_SUBJECT]: "存在未知或非法的 subject；主体必须来自当前凭据快照或 configured-env。",
  [ACCESS_POLICY_CODES.UNKNOWN_CAPABILITY]: "存在未知 capability，请从能力 catalog 中选择。",
  [ACCESS_POLICY_CODES.INVALID_TIMEZONE]: "时区不是服务端已知的 IANA 时区。",
  [ACCESS_POLICY_CODES.INVALID_WINDOW]: "时间窗口不合法；不支持跨午夜，请拆成两段。",
  [ACCESS_POLICY_CODES.REVOKE_REQUIRES_ALL]: "revoke 模式必须且只能使用 all 能力（principal-wide）。",
  [ACCESS_POLICY_CODES.STALE_REVISION]: "该策略在你提交前已被修改（revision 冲突）。为避免覆盖他人的修改，本次提交未生效。",
  [ACCESS_POLICY_CODES.STORE_IO]: "策略存储写入失败，请稍后重试。",
  [ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID]: "该策略不存在或已被删除。",
  [ACCESS_POLICY_ADMIN_CODES.STORE_UNAVAILABLE]: "策略存储不可用；请先用修复面恢复存储。",
});

const STATUS_BY_CODE = Object.freeze({
  [ACCESS_POLICY_CODES.STALE_REVISION]: 409,
  [ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID]: 404,
  [ACCESS_POLICY_ADMIN_CODES.STORE_UNAVAILABLE]: 503,
});

/** Prototype page for `?done=<action>`; a fixed map so a crafted query cannot echo text back. */
const DONE_MESSAGES = Object.freeze({
  create: "策略已创建。",
  update: "策略已保存。",
  toggle: "策略状态已更新。",
  delete: "策略已删除。",
  repair: "策略存储已修复。",
});

/**
 * Resolve the public action URLs (used in the rendered forms/links) plus the router-relative base
 * used to register the routes. `base` defaults to `<mountPath>/access-policy`; `routeBase` strips
 * `mountPath` because the Auth Center router is mounted with `app.use(mountPath, router)`.
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

function isStale(result) {
  return String(result?.code ?? "") === ACCESS_POLICY_CODES.STALE_REVISION;
}

// ------------------------------------------------------------------ form decoding

/** The last value of a repeated field (a checkbox following its hidden `false` partner). */
function lastValue(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/**
 * A repeated checkbox group *or* the legacy text encoding (`"scope:obsidian.read tool:x"`) the
 * previous form and the existing browser gates post. Both arrive here, and the service's own
 * `coerceList` is what used to split the text: whitespace and commas are separators in both, and no
 * subject id or capability key may contain whitespace, so splitting here cannot invent an entry.
 */
function fieldList(body, name) {
  const raw = body?.[name];
  if (Array.isArray(raw)) return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [];
  return [...new Set(text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function coerceBool(value, fallback = null) {
  const raw = lastValue(value);
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (raw === true || raw === "true" || raw === "on" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "off" || raw === "0") return false;
  return fallback;
}

/** `mon 09:00-18:00` lines -> the schema's `{ mon: [["09:00","18:00"]] }` (the service's own grammar). */
export function parseWeeklyText(text) {
  const weekly = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([A-Za-z]{3})\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(line);
    if (!match) return null; // malformed: never guessed, the service fails closed on the raw value
    const day = match[1].toLowerCase();
    if (!WEEK_DAYS.includes(day)) return null;
    (weekly[day] ??= []).push([match[2], match[3]]);
  }
  return weekly;
}

/** `2026-10-01..2026-10-07` lines -> `[{ from, to }]` (the service's own grammar). */
export function parseDateRangesText(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const parts = line.split(/\s*\.\.\s*/);
    return { from: parts[0], to: parts[1] ?? parts[0] };
  });
}

/** Structured per-weekday fields (`w_mon_from_1` …) -> the `weekly` record. */
export function weeklyFromFields(body) {
  const weekly = {};
  for (const day of WEEK_DAYS) {
    const slots = new Map();
    for (const [key, value] of Object.entries(body ?? {})) {
      const match = new RegExp(`^w_${day}_(from|to)_(\\d+)$`).exec(key);
      if (!match) continue;
      const slot = slots.get(match[2]) ?? { from: "", to: "" };
      slot[match[1]] = clean(lastValue(value), 8) ?? "";
      slots.set(match[2], slot);
    }
    const intervals = [...slots.keys()].sort((a, b) => Number(a) - Number(b))
      .map((index) => slots.get(index))
      .filter((slot) => slot.from || slot.to)
      .map((slot) => [slot.from, slot.to]);
    if (intervals.length) weekly[day] = intervals;
  }
  return weekly;
}

/** Structured date fields (`range_from_1` …) -> `[{ from, to }]`. */
export function dateRangesFromFields(body) {
  const slots = new Map();
  for (const [key, value] of Object.entries(body ?? {})) {
    const match = /^range_(from|to)_(\d+)$/.exec(key);
    if (!match) continue;
    const slot = slots.get(match[2]) ?? { from: "", to: "" };
    slot[match[1]] = clean(lastValue(value), 10) ?? "";
    slots.set(match[2], slot);
  }
  return [...slots.keys()].sort((a, b) => Number(a) - Number(b))
    .map((index) => slots.get(index))
    .filter((slot) => slot.from || slot.to)
    .map((slot) => ({ from: slot.from, to: slot.to }));
}

const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * `datetime-local` wall clock -> ISO instant, interpreted in the policy's timezone (the prototype's
 * rule: "起止时间用 datetime-local，按策略时区解释，旁边显示存储的 UTC 值"). Anything that already
 * carries a zone/offset, or an unparsable value, is passed through untouched so the schema — not this
 * helper — decides validity.
 */
export function wallClockToInstant(value, zone) {
  const raw = String(value ?? "").trim();
  if (!raw || !LOCAL_INPUT.test(raw)) return raw;
  try {
    const wall = Date.parse(`${raw.length === 16 ? raw : raw.slice(0, 16)}:00Z`);
    if (!Number.isFinite(wall)) return raw;
    let guess = wall;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = zonedParts(new Date(guess).toISOString(), zone);
      if (!parts) return raw;
      const asUtc = Date.parse(`${parts.date}T${parts.hm}:00Z`);
      if (!Number.isFinite(asUtc)) return raw;
      const delta = wall - asUtc;
      if (delta === 0) break;
      guess += delta;
    }
    return new Date(guess).toISOString();
  } catch {
    return raw; // unknown timezone: the schema reports INVALID_TIMEZONE
  }
}

/**
 * Decode one submitted policy form into a draft the service understands.
 *
 * The service owns every default and every validity rule, so this decoder keeps the submitted shape
 * and only translates what the browser cannot express: the structured weekly/date grids, and
 * `datetime-local` bounds that must be read in the policy's timezone. A `revoke` policy is forced to
 * `["all"]` because that is the schema's own invariant (the picker renders it locked as well).
 */
export function decodeDraft(body = {}) {
  const draft = { ...body };
  for (const key of ["csrf", "expectedRevision", "id", "confirm", "confirmed", "view", "new", "copy", "weeklyPreset"]) {
    delete draft[key];
  }
  const timezone = clean(draft.timezone, 80)?.trim() ?? "";
  if (draft.timezone !== undefined) draft.timezone = timezone;
  if (draft.enabled !== undefined) draft.enabled = coerceBool(draft.enabled, null);
  if (draft.label !== undefined) draft.label = clean(draft.label, 120)?.trim() ?? "";
  if (draft.mode !== undefined) draft.mode = String(draft.mode) === "revoke" ? "revoke" : draft.mode;
  if (draft.subjects !== undefined) draft.subjects = fieldList(body, "subjects");
  if (draft.capabilities !== undefined) {
    draft.capabilities = Array.isArray(draft.capabilities) || typeof draft.capabilities === "string"
      ? fieldList(body, "capabilities")
      : draft.capabilities;
  }
  for (const key of Object.keys(draft)) {
    if (/^w_(mon|tue|wed|thu|fri|sat|sun)_(from|to)_\d+$/.test(key) || /^range_(from|to)_\d+$/.test(key)) delete draft[key];
  }
  const structuredWeekly = weeklyFromFields(body);
  if (Object.keys(structuredWeekly).length) draft.weekly = structuredWeekly;
  else if (typeof body.weekly === "string" && !/^[a-z]{3}\s/.test(body.weekly.trim()) && body.weekly.trim().startsWith("{")) {
    draft.weekly = body.weekly; // raw JSON text: the service parses/validates it
  } else if (typeof body.weekly === "string") {
    const parsed = parseWeeklyText(body.weekly);
    draft.weekly = parsed ?? body.weekly;
  }
  const structuredRanges = dateRangesFromFields(body);
  if (structuredRanges.length) draft.dateRanges = structuredRanges;
  else if (typeof body.dateRanges === "string" && body.dateRanges.trim()) draft.dateRanges = parseDateRangesText(body.dateRanges);
  for (const key of ["startsAt", "expiresAt"]) {
    if (typeof draft[key] === "string" && draft[key]) draft[key] = wallClockToInstant(draft[key], timezone);
  }
  if (draft.mode === "revoke") draft.capabilities = ["all"];
  return draft;
}

// ------------------------------------------------------------------ context

function shellFor(view, req, { base, content, detailPanel = "", theme, navCounts, navAttention, vaultGitBase = null }) {
  if (typeof view?.renderAuthShell === "function") {
    // `catalog` is the documented seam the router's view wrapper reads (`opts.catalog || lastCatalog`):
    // passing it here keeps the sidebar counts/attention dots and the theme correct even when this
    // route module answers a request the tab dispatcher never built a catalog for.
    return view.renderAuthShell({
      activeTab: "access-policy",
      accessPolicyBase: base,
      vaultGitBase,
      session: req.adminSession,
      request: req,
      content,
      detailPanel,
      theme,
      navCounts,
      navAttention,
      catalog: { theme, navCounts, navAttention },
    });
  }
  if (typeof view?.layout === "function") {
    const logout = `<form class="inline-form" method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${esc(req.adminSession?.csrf ?? "")}"><button class="btn ghost" type="submit">退出</button></form>`;
    const header = `<header class="bar"><h1>定时授权</h1><span class="grow"></span><a class="btn ghost" href="/admin/auth">返回授权管理</a>${logout}</header>`;
    return view.layout("Obsidian MCP · 授权管理", `<div class="app"><main class="main">${header}${content}</main></div>${detailPanel}`);
  }
  throw new TypeError("registerAccessPolicyRoutes requires view.renderAuthShell (or view.layout)");
}

// ------------------------------------------------------------------ registration

/**
 * `registerAccessPolicyRoutes(router, { admin, view, requireAdmin, requireCsrf, provider,
 * configuredApiKeyEnabled, actions, mountPath, vaultGitBase })`.
 *
 * Returns `{ base, actions }`, or `null` when no access-policy admin service is injected (zero
 * behavior difference: the Admin plane simply does not offer the surface).
 */
export function registerAccessPolicyRoutes(router, {
  admin,
  view,
  requireAdmin,
  requireCsrf,
  actions = {},
  provider = null,
  configuredApiKeyEnabled = false,
  // The sidebar shows the whole Admin inventory, so this module must build the SAME catalog the tab
  // routes do. It used to pass only three dependencies, and `buildCatalog` degrades a missing service
  // to an empty list — which is why 发布文档 / Vault 与 Git read 0 on this page while every other tab was
  // correct (NAS 2026-10-21). Never rely on that degradation for a surface that displays counts.
  listVaults = null,
  publishService = null,
  vaultGitAdmin = null,
  mountPath = DEFAULT_MOUNT_PATH,
  vaultGitBase = null,
} = {}) {
  if (!admin) return null;
  const urls = resolveActions(actions, mountPath);
  const { base, routeBase } = urls;

  // ---------------------------------------------------------------- page state

  async function readPage(req, query) {
    const catalog = await buildCatalog({
      deps: { provider, accessPolicyAdmin: admin, configuredApiKeyEnabled, listVaults, publishService, vaultGitAdmin },
      req,
      query,
    });
    const subjects = snapshotSubjects(catalog.snapshot, { configuredApiKeyEnabled });
    const policies = Array.isArray(catalog.authz?.policies) ? catalog.authz.policies : [];
    const orphaned = orphanedSubjects(policies, subjects);
    let runtime = null;
    try {
      runtime = typeof provider?.accessRuntime?.summary === "function" ? provider.accessRuntime.summary() : null;
    } catch {
      runtime = null; // a runtime that cannot summarize is "未提供", never a fabricated state
    }
    return {
      ...catalog,
      authz: { ...catalog.authz, orphaned, policies, count: policies.length },
      subjects,
      runtimeState: runtime ? { enabled: runtime.enabled === true, status: runtime.status } : null,
      capabilities: catalog.capabilities ?? capabilityCatalog(),
      csrf: req.adminSession?.csrf ?? "",
      session: req.adminSession,
      accessPolicyBase: base,
      vaultGitBase,
    };
  }

  function findPolicy(ctx, id) {
    return (ctx.authz?.policies ?? []).find((policy) => policy.id === String(id ?? "")) ?? null;
  }

  /** Delete confirmation — prototype `delPolicy()`: type the policy label, then a red confirm. */
  function deleteConfirm(ctx, policy) {
    return confirmPage({
      title: `删除策略「${policy.label}」？`,
      bodyHtml: `相关主体（${(Array.isArray(policy.subjects) ? policy.subjects : []).map((subject) => esc(ctx.model.subjectView(subject).name)).join("、") || "—"}）将不再受时间限制。此操作不能撤销。`,
      listItems: [
        `<span class="mono">${esc(policy.id)}</span>`,
        `提交时携带修订号 <span class="mono">${esc(String(ctx.authz?.revision ?? "—"))}</span>，若他人已修改将被拒绝`,
      ],
      typed: policy.label,
      ok: "删除策略",
      tone: "danger",
      action: urls.delete,
      csrf: ctx.csrf,
      fields: { id: policy.id, expectedRevision: ctx.authz?.revision ?? "" },
      backHref: base,
    });
  }

  /** Disable confirmation — prototype `onMenu("policy","toggle")`: 停用 asks, 启用 does not. */
  function toggleConfirm(ctx, policy) {
    return confirmPage({
      title: `停用「${policy.label}」？`,
      bodyHtml: "停用后该策略不再限制任何主体，相关凭据将按原有权限全天可用。",
      ok: "停用",
      tone: "primary",
      action: urls.toggle,
      csrf: ctx.csrf,
      fields: { id: policy.id, enabled: "false", expectedRevision: ctx.authz?.revision ?? "", confirmed: "1" },
      backHref: base,
    });
  }

  /** Repair confirmation — prototype `authz-repair`: the damaged file is backed up first. */
  function repairConfirm(ctx, document) {
    return confirmPage({
      title: "用粘贴的文档覆盖策略存储？",
      bodyHtml: "当前损坏的文件会先备份。覆盖后所有策略按新文档生效。",
      typed: "覆盖",
      ok: "覆盖修复",
      tone: "danger",
      action: urls.repair,
      csrf: ctx.csrf,
      fields: { document },
      backHref: base,
    });
  }

  /** Which page the request asks for. `query` is the GET query or a POST form's view request. */
  function selectPage(ctx, query, extra = {}) {
    const pageCtx = { ...ctx, query, ...extra };
    const confirm = String(query.confirm ?? "");
    if (confirm === "delete" && query.id) {
      const policy = findPolicy(ctx, query.id);
      const list = renderAuthzPage({ ...pageCtx, query: {} });
      if (!policy) {
        return { status: 404, content: renderAuthzPage({ ...pageCtx, query: {}, failure: "策略不存在或已被删除。" }).content, detailPanel: "" };
      }
      return { status: extra.status ?? 200, content: list.content, detailPanel: deleteConfirm(pageCtx, policy) };
    }
    const wantsEditor = Boolean(query.edit || query.new || query.copy);
    if (wantsEditor) {
      const source = query.copy ? findPolicy(ctx, query.copy) : query.edit ? findPolicy(ctx, query.edit) : null;
      if ((query.copy || query.edit) && !source) {
        return { status: 404, content: renderAuthzPage({ ...pageCtx, query: {}, failure: "策略不存在或已被删除。" }).content, detailPanel: "" };
      }
      const preset = resolveWeeklyPreset(query.weeklyPreset);
      // No-JS draft edits (prototype `6-app.js:311/353/354`): the editor's day chips, 为已选日期再加
      // 一个时段 and 添加日期区间 are scripted toggles in the prototype; here each is a GET round trip
      // over the same state, so the editor stays fully usable with scripting disabled. A day toggled
      // ON gets the prototype's own default (09:00–18:00), the extra slot the prototype's own
      // 19:00–22:00, and a new date range today → +7d.
      const dayKey = WEEK_DAYS.includes(String(query.day)) ? String(query.day) : null;
      const addSlot = String(query.addSlot ?? "") === "1";
      const addRange = String(query.addRange ?? "") === "1";
      const applyDraftEdits = (draft) => {
        if (!dayKey && !addSlot && !addRange) return draft;
        const weekly = { ...(draft.weekly && typeof draft.weekly === "object" ? draft.weekly : {}) };
        if (dayKey) {
          if (Array.isArray(weekly[dayKey]) && weekly[dayKey].length) delete weekly[dayKey];
          else weekly[dayKey] = [["09:00", "18:00"]];
        }
        if (addSlot) {
          for (const day of WEEK_DAYS) {
            if (!Array.isArray(weekly[day]) || !weekly[day].length) continue;
            weekly[day] = [...weekly[day], ["19:00", "22:00"]];
          }
        }
        const dateRanges = Array.isArray(draft.dateRanges) ? [...draft.dateRanges] : [];
        if (addRange) {
          const today = new Date();
          const week = new Date(today.getTime() + 7 * 24 * 3600 * 1000);
          dateRanges.push({ from: today.toISOString().slice(0, 10), to: week.toISOString().slice(0, 10) });
        }
        return { ...draft, weekly, dateRanges };
      };
      // `extra.draft` means this render is a re-render of a *submitted* form (validation failure or
      // CAS conflict): the operator's own values win over the stored policy, and the revision they
      // loaded with is kept so a resubmit is rejected instead of overwriting.
      const derived = applyDraftEdits(source
        ? (query.copy
          ? { ...source, id: undefined, createdAt: undefined, updatedAt: undefined, label: `${source.label}（副本）`, ...(preset ? { weekly: preset } : {}) }
          : { ...source, ...(preset ? { weekly: preset } : {}) })
        : { label: "", mode: "suspend", enabled: true, timezone: "Asia/Shanghai", startsAt: "", expiresAt: "", weekly: preset ?? {}, dateRanges: [], subjects: [], capabilities: [] });
      const rendered = renderAuthzEditorPage({
        ...pageCtx,
        draft: extra.draft ?? derived,
        policyId: extra.draft ? (extra.policyId ?? null) : (query.copy ? null : query.edit ?? null),
        expectedRevision: extra.expectedRevision ?? ctx.authz?.revision ?? null,
      });
      return { status: extra.status ?? 200, ...rendered };
    }
    return { status: extra.status ?? 200, ...renderAuthzPage(pageCtx) };
  }

  async function sendPage(req, res, { query = req.query ?? {}, extra = {}, status = null, detailPanel = null } = {}) {
    const ctx = await readPage(req, query);
    const page = selectPage(ctx, query, extra);
    const body = detailPanel === null ? page.detailPanel : detailPanel;
    res.status(status ?? page.status ?? 200).send(shellFor(view, req, {
      base,
      vaultGitBase,
      content: page.content,
      detailPanel: body,
      theme: ctx.theme,
      navCounts: ctx.navCounts,
      navAttention: ctx.navAttention,
    }));
  }

  /**
   * A rejected write. Stale CAS keeps the submitted draft (create/update) or re-renders the list,
   * always with the *stale* revision still in the form, so a resubmit cannot silently overwrite the
   * other admin's change.
   */
  async function respondFailure(req, res, { result: outcome, draft = null, id = null, endpoint = "" }) {
    const status = statusForCode(outcome?.code);
    const message = hintFor(outcome);
    const stale = isStale(outcome);
    if ((endpoint === "create" || endpoint === "update") && draft) {
      await sendPage(req, res, {
        query: endpoint === "update" && id ? { edit: id } : { new: "1" },
        extra: { failure: message, conflict: stale, draft, policyId: endpoint === "update" && id ? id : null, expectedRevision: req.body?.expectedRevision ?? null },
        status,
      });
      return;
    }
    await sendPage(req, res, { extra: { failure: message, conflict: stale }, status });
  }

  // ---------------------------------------------------------------- GET

  router.get(routeBase, requireAdmin, async (req, res, next) => {
    try {
      await sendPage(req, res, { extra: { repairDocument: null } });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Read-only preview for the live editor pane (lane L3, D0 progressive enhancement).
   *
   * `GET {base}/preview?preview=1&<draft form fields>` answers the editor's right-hand
   * 生效预览 for a draft that has *not* been saved: the same `decodeDraft` decoding the POST
   * write path uses, the same `renderAuthzEditorPage` (hence the same `presentAccessPolicyWindow`
   * summary, `policyTimelineHtml` timeline and `policyNowState` verdict) and the same
   * `previewForSubject`-free read model. The enhancement script only adopts the rendered
   * `.ped-side` node, so the 「现在（…）允许/拒绝」 verdict and 「对主体的影响」 are always the
   * server's answer — the browser never computes one.
   *
   * Why a separate path instead of `?preview=1` on `{base}`: the list/edit GET already owns that
   * URL (`selectPage`), and this lane may only *add* an endpoint, never change existing semantics.
   *
   * Properties that keep this from being a new authority:
   *   * `requireAdmin` only — no CSRF field is needed because nothing is written (the POST
   *     `/preview` that reaches `runtime.explain` keeps its CSRF/`requireCsrf` protection);
   *   * the response is a fragment of the *editor page* the operator can already open, so it
   *     exposes exactly the revision/subject vocabulary that page already renders;
   *   * the draft travels in the query string, so the router's own `Cache-Control: no-store`
   *     applies and the value never reaches a log or a stored page;
   *   * no policy JSON or credential secret is echoed: only the operator's own submitted draft is
   *     rendered back, escaped by the page module like every other value.
   */
  router.get(`${routeBase}/preview`, requireAdmin, async (req, res, next) => {
    try {
      const query = req.query ?? {};
      // The draft decodes exactly like the POST body: same helper, same coercions, same defaults.
      const draft = decodeDraft(query);
      const asked = typeof query.edit === "string" ? query.edit : "";
      const ctx = await readPage(req, query);
      // An id that no longer exists renders a *new*-policy preview instead of leaking a 404 page;
      // the form's own action is a copy/new policy in that case.
      const policyId = asked && findPolicy(ctx, asked) ? asked : null;
      if (policyId) draft.id = policyId;
      const rendered = renderAuthzEditorPage({
        ...ctx,
        draft,
        policyId,
        expectedRevision: null,
      });
      res.status(200).type("text/html; charset=utf-8").send(rendered.content);
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------- writes

  router.post(`${routeBase}/create`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const draft = decodeDraft(req.body);
      const outcome = await admin.createPolicy(draft, req.body?.expectedRevision);
      if (outcome?.ok) {
        res.redirect(303, `${base}?done=create`);
        return;
      }
      await respondFailure(req, res, { result: outcome, draft, endpoint: "create" });
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/update`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const id = String(req.body?.id ?? "");
      const draft = decodeDraft(req.body);
      if (!id) {
        await respondFailure(req, res, { result: { code: ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID }, draft, endpoint: "update" });
        return;
      }
      const outcome = await admin.updatePolicy(id, draft, req.body?.expectedRevision);
      if (outcome?.ok) {
        res.redirect(303, `${base}?done=update`);
        return;
      }
      await respondFailure(req, res, { result: outcome, draft, id, endpoint: "update" });
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/toggle`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const id = String(req.body?.id ?? "");
      const enabled = coerceBool(req.body?.enabled, null);
      if (enabled === null) {
        await respondFailure(req, res, { result: { code: ACCESS_POLICY_CODES.INVALID_POLICY, detail: "enabled" }, endpoint: "toggle" });
        return;
      }
      // Prototype rule: 停用 needs a confirmation, 启用 applies directly.
      if (enabled === false && String(req.body?.confirmed ?? "") !== "1") {
        const ctx = await readPage(req, req.query ?? {});
        const policy = findPolicy(ctx, id);
        if (!policy) {
          await respondFailure(req, res, { result: { code: ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID }, endpoint: "toggle" });
          return;
        }
        res.status(200).send(shellFor(view, req, {
          base,
          vaultGitBase,
          content: renderAuthzPage({ ...ctx, query: {} }).content,
          detailPanel: toggleConfirm(ctx, policy),
          theme: ctx.theme,
          navCounts: ctx.navCounts,
          navAttention: ctx.navAttention,
        }));
        return;
      }
      const outcome = await admin.setEnabled(id, enabled, req.body?.expectedRevision);
      if (outcome?.ok) {
        res.redirect(303, `${base}?done=toggle`);
        return;
      }
      await respondFailure(req, res, { result: outcome, endpoint: "toggle" });
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/delete`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const id = String(req.body?.id ?? "");
      const ctx = await readPage(req, req.query ?? {});
      const policy = findPolicy(ctx, id);
      if (!policy) {
        await respondFailure(req, res, { result: { code: ACCESS_POLICY_ADMIN_CODES.UNKNOWN_POLICY_ID }, endpoint: "delete" });
        return;
      }
      // Type-to-confirm (prototype `delPolicy`), verified server-side — never by a scripted button.
      if (String(req.body?.confirm ?? "") !== policy.label) {
        res.status(400).send(shellFor(view, req, {
          base,
          vaultGitBase,
          content: renderAuthzPage({ ...ctx, query: {}, failure: "确认文字与策略名称不一致，未删除任何内容。" }).content,
          detailPanel: deleteConfirm(ctx, policy),
          theme: ctx.theme,
          navCounts: ctx.navCounts,
          navAttention: ctx.navAttention,
        }));
        return;
      }
      const outcome = await admin.deletePolicy(id, req.body?.expectedRevision);
      if (outcome?.ok) {
        res.redirect(303, `${base}?done=delete`);
        return;
      }
      await respondFailure(req, res, { result: outcome, endpoint: "delete" });
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/preview`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const subject = clean(req.body?.subject, 200) ?? "";
      const ctx = await readPage(req, req.query ?? {});
      const referenced = (ctx.authz.policies ?? []).flatMap((policy) => (Array.isArray(policy.subjects) ? policy.subjects : []));
      const known = new Set([...ctx.subjects, ...referenced]);
      const query = String(req.body?.view ?? "list") === "editor"
        ? (req.body?.edit ? { edit: String(req.body.edit) } : { new: "1" })
        : {};
      if (!subject || !known.has(subject)) {
        await sendPage(req, res, { query, extra: { failure: "该主体不在当前凭据快照中，无法试算。" } });
        return;
      }
      const preview = await admin.previewForSubject(subject);
      await sendPage(req, res, { query, extra: { preview } });
    } catch (error) {
      next(error);
    }
  });

  router.post(`${routeBase}/repair`, requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const document = typeof req.body?.document === "string" ? req.body.document : "";
      if (String(req.body?.confirm ?? "") !== "覆盖") {
        const ctx = await readPage(req, req.query ?? {});
        res.status(200).send(shellFor(view, req, {
          base,
          vaultGitBase,
          content: renderAuthzPage({ ...ctx, query: {}, repairDocument: document }).content,
          detailPanel: repairConfirm(ctx, document),
          theme: ctx.theme,
          navCounts: ctx.navCounts,
          navAttention: ctx.navAttention,
        }));
        return;
      }
      const outcome = await admin.repairFromCandidate(document);
      if (outcome?.ok) {
        res.redirect(303, `${base}?done=repair`);
        return;
      }
      await sendPage(req, res, { extra: { failure: hintFor(outcome), repairDocument: document }, status: statusForCode(outcome?.code) });
    } catch (error) {
      next(error);
    }
  });

  return { base: urls.base, actions: urls };
}
