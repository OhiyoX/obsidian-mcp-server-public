// 定时授权 (access-policy) route module — the legacy surface, frozen.
//
// Owned surface: `GET {base}` (list, `?id=` drawer, `?edit=` read-only view). The seven legacy write
// endpoints (`POST {base}/{create,update,toggle,delete,preview,repair,subjects}`) are still registered
// so an old bookmark or form answers honestly,
// but every one of them refuses with 409 `access_policy_frozen` (design §7 step 2 + step 5, ruling R6 for
// `repair`): the per-Vault document decides now, and an accepted legacy edit would be stored and never
// apply. See `pages/authz.js` (`LEGACY_POLICY_FROZEN_CODE` / `LEGACY_POLICY_REPLACEMENT`) for the
// read-only face of the same fact.
//
// Hard rules kept from the frozen contract (`scratch/authz/INTERFACE.md` §10.4/§10.6):
//   * every POST still goes through `requireAdmin` + `requireCsrf` with the *existing* session cookie
//     and the `csrf` field name — a frozen endpoint is not an unauthenticated oracle, and no second
//     auth scheme appeared;
//   * the Admin plane is never gated by the policy it manages: nothing here calls `runtime.evaluate`;
//   * a broken store still renders the page (the store read never throws into it), now without the
//     repair form the freeze takes away;
//   * no policy JSON, credential secret or token is echoed back — never into a URL or a log.
//
// The seventh write, `POST {base}/subjects` (「应用已有规则」 from a subject drawer), is frozen with
// them: adding a subject to a legacy policy is a legacy edit like any other, and accepting it would
// store a rule that never applies. The drawer now shows the stored rules read-only and points at the
// per-Vault page; Task 6 gives it the constraint model.
//
// No script (D0 HOLD): every result is server-rendered markup.
import { buildCatalog } from "../catalog.js";
import { orphanedSubjects, snapshotSubjects } from "../access-policy.js";
import { capabilityCatalog } from "../capabilities.js";
import { clean } from "../http.js";
import { esc } from "../presentation/format.js";
import { zonedParts } from "../presentation/model.js";
import { renderAuthzPage, LEGACY_POLICY_FROZEN_CODE, LEGACY_POLICY_REPLACEMENT } from "../pages/authz.js";
import { renderAuthzEditorPage } from "../pages/authz-editor.js";
import { t } from "../../i18n/context.js";

export { LEGACY_POLICY_FROZEN_CODE };

/** Public default base URL, frozen by the C2 BRIEF §1.1. */
export const DEFAULT_BASE = "/admin/auth/access-policy";
/** The Auth Center router is mounted here in `server.js`. */
export const DEFAULT_MOUNT_PATH = "/admin/auth";

const WEEK_DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

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
    const logout = `<form class="inline-form" method="post" action="/admin/auth/logout"><input type="hidden" name="csrf" value="${esc(req.adminSession?.csrf ?? "")}"><button class="btn ghost" type="submit">${esc(t("adm.authz.logout"))}</button></form>`;
    const header = `<header class="bar"><h1>${esc(t("adm.nav.accessPolicy"))}</h1><span class="grow"></span><a class="btn ghost" href="/admin/auth">${esc(t("adm.back.admin"))}</a>${logout}</header>`;
    return view.layout(t("adm.doc.title"), `<div class="app"><main class="main">${header}${content}</main></div>${detailPanel}`);
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
  authorizationMode = null,
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
      // `legacy | shadow | enforce`, or null when no authorization runtime was injected. The frozen
      // banner states it, because only `enforce` answers from the per-Vault model.
      authorizationMode,
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

  /**
   * Which page the request asks for.
   *
   * Frozen surfaces only: the list, the `?id=` drawer and the `?edit=` read-only view. The four
   * write-side entry points are gone with the writes — `?confirm=delete` (the type-to-confirm page),
   * `?new=` / `?copy=` (a draft the operator could never save) and the editor's draft round trips
   * (`?day=` / `?addSlot=` / `?addRange=` / `?weeklyPreset=`) — so a bookmarked one lands on the list
   * and its banner, not on a control that can only fail.
   */
  function selectPage(ctx, query, extra = {}) {
    const pageCtx = { ...ctx, query, ...extra };
    if (query.edit) {
      const source = findPolicy(ctx, query.edit);
      if (!source) {
        return { status: 404, content: renderAuthzPage({ ...pageCtx, query: {}, failure: t("adm.authz.policyMissing") }).content, detailPanel: "" };
      }
      const rendered = renderAuthzEditorPage({
        ...pageCtx,
        draft: source,
        policyId: source.id,
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

  // ---------------------------------------------------------------- GET

  router.get(routeBase, requireAdmin, async (req, res, next) => {
    try {
      await sendPage(req, res);
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------- writes (frozen)

  /**
   * Every legacy write is refused before it reaches the service (design §7 step 2 + step 5).
   *
   * The durable per-Vault document decides now (Tasks 1-2), so an accepted legacy edit could only
   * ever be a lie: it would be stored and never apply — the anti-goal of §4. `repair` is refused for
   * the same reason even though it is not a policy edit (ruling R6): rewriting the frozen store would
   * resurrect editing. All seven answer the same code with a 409, and the body names where the request
   * *can* go instead.
   *
   * `requireAdmin` + `requireCsrf` stay in front: a frozen endpoint must not become an
   * unauthenticated oracle, and a request without a session or CSRF token must still fail as before.
   */
  function refuseFrozenWrite(req, res) {
    res.status(409).json({
      error: LEGACY_POLICY_FROZEN_CODE,
      message: t("adm.authz.frozen.refusal"),
      movedTo: LEGACY_POLICY_REPLACEMENT,
    });
  }

  // `subjects` is the attach-from-drawer write: the same legacy edit reached from another page.
  for (const endpoint of ["create", "update", "toggle", "delete", "preview", "repair", "subjects"]) {
    router.post(`${routeBase}/${endpoint}`, requireAdmin, requireCsrf, refuseFrozenWrite);
  }

  return { base: urls.base, actions: urls };
}
