// 定时授权 (timed authorization) — list page + `?id=` detail drawer.
//
// Prototype source of truth: `docs/admin-ui-proto/src/5-render.js` — `renderAuthz()` (list table,
// banners, 当前状态预览) and the shared drawer vocabulary of `6-app.js` (`dhead` / `.dsec` /
// `.kv` / `.danger-zone` / `.dz`); interaction rules in `docs/admin-ui-proto/README.md`
// ("定时授权" row of the 功能对照表, and 「Row operations / danger hierarchy」).
//
// No script (CSP `default-src 'none'`, D0 HOLD). Every prototype interaction is reproduced by
// server state:
//   * opening a row  -> `?id=<policyId>` renders the detail drawer (`?window=` is kept as an alias,
//     so the previous "window detail card" entry point still resolves);
//   * the ⋯ row menu -> `<details class="mn">` (never a scripted popover);
//   * switches       -> POST forms carrying the session CSRF;
//   * results        -> a `.result` line (the prototype shows a toast);
//   * danger actions -> a separate confirm page (`ui.confirmPage`, rendered by the route module).
// Nothing here renders an affordance that cannot work without script.
//
// Row/card primary link: the prototype row is `data-open="policy" data-id=…` and the click handler in
// `6-app.js` routes it to `#/authz/<id>` — the *editor* (`docs/admin-ui-proto/src/5-render.js:352`,
// `6-app.js:301`). The 查看详情 item in the ⋯ menu keeps the read-only detail drawer (`?id=`, the
// Admin-plane rule of `docs/admin/README.md`). The order matters beyond looks: an editor-discovery
// probe (the Admin layout browser gate) takes the page's *first* `?edit=`/`?id=` link, so the primary
// link has to be the editor and never a surface without the capability picker.
//
// Window data: the frozen #434 presentation model (`presentAccessPolicyWindow`) is the single
// source for the summary text, the constraint markers and the 7-day detail. `ctx.model`'s
// `windowSummary` / `timeline` / `inWindow` helpers still assume the prototype's *mock* shape
// (`weekly` as an array of `{ day, from, to }`), while a stored policy carries the schema's
// `{ mon: [["09:00", "18:00"]] }` record — reading them here would report every real policy as
// "每天全天", so this page derives the same markup from the presentation model instead.
import { pageBar, table, mcards, emptyState, banner, moreMenu, result, drawer, kv, esc, fut, ic } from "../ui.js";
import { fmtFull, idc, relTitle } from "../presentation/format.js";
import { presentAccessPolicyWindow, WINDOW_DAY_LABELS, WINDOW_SCOPE_DISCLAIMER } from "../access-policy-window-presentation.js";
import { t } from "../../i18n/context.js";
import { zonedParts } from "../presentation/model.js";
import { readSort, sortRows } from "../table-sort.js";

/** Weekday keys in display order (prototype `[1,2,3,4,5,6,0]` = 一…日). */
export const WEEK_DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

const FULL_DAY = Object.freeze({ start: "00:00", end: "24:00" });

/** The one presentation model every window surface on this page reads. */
export function windowPresentation(policy) {
  return presentAccessPolicyWindow(policy);
}

/** `HH:MM` / `24:00` boundary as a percentage of a day (prototype `toPct`). */
function toPct(value) {
  const [hours, minutes] = String(value ?? "").split(":").map(Number);
  if (!Number.isFinite(hours)) return 0;
  if (hours >= 24) return 100;
  return ((hours * 60 + (Number.isFinite(minutes) ? minutes : 0)) / 1440) * 100;
}

/** `mon` -> `mon` day key for a wall-clock instant in `zone`. */
function dayKeyOf(parts) {
  if (!parts) return null;
  return WEEK_DAYS[(Number(parts.day) + 6) % 7] ?? null;
}

/**
 * Prototype `inWindow()` — "is this policy inside its window right now?" evaluated in the
 * policy's own timezone. Honest tri-state: `ok === null` means the policy cannot be judged
 * (invalid timezone / unparsable window), and the caller must render 无法判定 rather than 允许.
 *
 * The absolute bounds are compared as instants (`startsAt` / `expiresAt` are stored as ISO
 * instants by the schema), the date ranges and the weekly grid as local wall-clock values.
 */
export function policyNowState(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  if (!local) return { ok: null, why: t("adm.authz.why.badZone") };
  const starts = win.details.startsAt;
  const expires = win.details.expiresAt;
  if (starts.present && !starts.valid) return { ok: null, why: t("adm.authz.why.badStart") };
  if (starts.present && now < Date.parse(starts.value)) return { ok: false, why: t("adm.authz.why.beforeStart") };
  if (expires.present && !expires.valid) return { ok: null, why: t("adm.authz.why.badEnd") };
  if (expires.present && now > Date.parse(expires.value)) return { ok: false, why: t("adm.authz.why.afterEnd") };
  const ranges = win.details.dateRanges;
  if (ranges.present && !ranges.valid) return { ok: null, why: t("adm.authz.why.badRanges") };
  if (ranges.present && !ranges.items.some((range) => local.date >= range.from && local.date <= range.to)) {
    return { ok: false, why: t("adm.authz.why.notInRanges") };
  }
  const day = win.details.days.find((item) => item.key === dayKeyOf(local)) ?? null;
  if (!day) return { ok: true, why: t("adm.authz.why.noWeekly") };
  if (day.state === "unparsable") return { ok: null, why: t("adm.authz.why.windowUnparsable") };
  if (day.state === "unspecified") return { ok: true, why: t("adm.authz.why.noWeekly") };
  if (day.state === "empty") return { ok: false, why: t("adm.authz.why.noIntervalsToday") };
  if (day.state === "all-day") return { ok: true, why: t("adm.authz.why.allDayToday") };
  const inside = day.intervals.some((item) => local.hm >= item.start && local.hm < item.end);
  return { ok: inside, why: inside ? t("adm.authz.why.inside", { text: day.text }) : t("adm.authz.why.outside", { text: day.text }) };
}

/** Now (policy timezone) as `MM-DD HH:mm`, for the preview verdict line. */
export function policyNowLabel(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  return local ? `${local.date.slice(5)} ${local.hm}` : new Date(now).toISOString().slice(0, 16).replace("T", " ");
}

/** Verdict colour for a tri-state `ok`. */
function verdictClass(ok) {
  return ok === true ? "ok" : ok === false ? "no" : "";
}

/** Prototype `timeline()` — 7 day rows, window bars, "now" marker (see the module note). */
export function policyTimelineHtml(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const zone = typeof policy?.timezone === "string" && win.timezoneValid ? policy.timezone : null;
  const local = zone ? zonedParts(now, zone) : null;
  const nowPct = local ? ((Number(local.h) * 60 + Number(local.mi)) / 1440) * 100 : 0;
  const todayKey = dayKeyOf(local);
  // An unreadable weekly grid must never be drawn as "all day": a malformed `weekly` field
  // keeps the rows empty and the summary says 无法解析时间窗口.
  const weeklyUsable = !win.unparsable?.reasons?.some((reason) => reason.field === "weekly");
  const rows = WEEK_DAYS.map((key) => {
    const day = win.details.days.find((item) => item.key === key) ?? null;
    let bars = [];
    if (!win.hasWeeklyConstraint && weeklyUsable) bars = [FULL_DAY];
    else if (day?.state === "all-day") bars = [FULL_DAY];
    else if (day?.state === "intervals") bars = day.intervals;
    const barsHtml = bars
      .filter((item) => toPct(item.end) > toPct(item.start))
      .map((item) => `<div class="w" style="left:${toPct(item.start)}%;width:${toPct(item.end) - toPct(item.start)}%" title="${esc(`${item.start}–${item.end}`)}"></div>`)
      .join("");
    const marker = key === todayKey ? `<div class="now" style="left:${nowPct}%" title="${esc(t("adm.authz.timeline.now"))}"></div>` : "";
    return `<span class="${key === todayKey ? "today" : ""}">${esc(WINDOW_DAY_LABELS[key].slice(1))}</span><div class="tr">${barsHtml}${marker}</div>`;
  }).join("");
  return `<div class="tl">${rows}<span></span><div class="ax"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>`;
}

/** 状态 · 模式 cell (prototype column 2). */
export function policyStatusCell(model, policy) {
  const enabled = policy.enabled !== false;
  const mode = model.mode(policy.mode);
  const status = enabled
    ? `<span class="st ok"><span class="dot"></span>${esc(t("adm.authz.status.enabled"))}</span>`
    : `<span class="st off"><span class="dot"></span>${esc(t("adm.authz.status.disabled"))}</span>`;
  return `${status}<div class="muted" style="font-size:13px" title="${esc(String(policy.mode ?? ""))}">${esc(t("adm.authz.outsideWindow", { mode: mode.n }))}</div>`;
}

/** 主体 cell — name first, kind + short id as the secondary line, orphan marked (prototype `subjectCell`). */
export function policySubjectsCell(model, policy) {
  const subjects = Array.isArray(policy.subjects) ? policy.subjects : [];
  if (!subjects.length) return `<div class="nm" style="gap:2px"><span class="muted">${esc(t("adm.authz.noSubjects"))}</span></div>`;
  const rows = subjects.map((subject) => {
    const view = model.subjectView(subject);
    const orphan = view.missing ? ` <span class="tag danger">${esc(t("adm.authz.orphanTag"))}</span>` : "";
    return `<span class="ell" title="${esc(subject)}"><span class="${view.missing ? "muted" : ""}">${esc(view.name)}</span> <span class="muted">${esc(view.kindLabel)}</span>${orphan}</span>`;
  }).join("");
  return `<div class="nm" style="gap:2px">${rows}</div>`;
}

/** 允许时间窗口 cell: summary, constraint markers, and the honest now verdict. */
export function policyWindowCell(policy, now = Date.now()) {
  const win = presentAccessPolicyWindow(policy);
  const marks = win.summary.markers.map((marker) => `<span class="tag">${esc(marker)}</span>`).join("");
  const state = policyNowState(policy, now);
  const verdict = policy.enabled === false
    ? ""
    : `<span style="color:${state.ok === true ? "var(--ok)" : state.ok === false ? "var(--amber)" : "var(--tx3)"}" title="${esc(state.why)}">${esc(state.ok === true ? t("adm.authz.nowAllowed") : state.ok === false ? t("adm.authz.nowRestricted") : t("adm.authz.undetermined"))}</span>`;
  return `<div class="nm"><span class="ell">${esc(win.summary.text)}</span><span class="sub2">${marks}${verdict}</span></div>`;
}

/** Row ⋯ menu — prototype `menuItems("policy", id)`, danger items routed through a confirm page. */
export function policyRowMenu({ base, policy, csrf, revision }) {
  const id = encodeURIComponent(policy.id);
  const enabled = policy.enabled !== false;
  return moreMenu([
    { href: `${base}?id=${id}`, label: t("adm.authz.menu.view"), icon: "eye" },
    { href: `${base}?edit=${id}`, label: t("adm.authz.menu.edit"), icon: "edit" },
    {
      action: `${base}/toggle`,
      label: enabled ? t("adm.authz.menu.disable") : t("adm.authz.menu.enable"),
      icon: enabled ? "pause" : "play",
      csrf,
      fields: { id: policy.id, enabled: enabled ? "false" : "true", expectedRevision: revision ?? "" },
    },
    { href: `${base}?copy=${id}`, label: t("adm.authz.menu.copy"), icon: "copy" },
    { href: `${base}?window=${id}`, label: t("adm.authz.menu.window"), icon: "cal" },
    { href: `${base}?confirm=delete&id=${id}`, label: t("adm.authz.menu.delete"), icon: "trash", danger: true },
  ]);
}

/** The 当前状态预览 section — a real POST form (no script) plus the verdict lines. */
function previewSection(ctx) {
  const { authz, model, csrf, query = {}, accessPolicyBase: base, now = Date.now(), preview = null } = ctx;
  const policies = Array.isArray(authz?.policies) ? authz.policies : [];
  const known = Array.isArray(ctx.subjects) ? ctx.subjects : [];
  const referenced = policies.flatMap((policy) => (Array.isArray(policy.subjects) ? policy.subjects : []));
  const options = [...new Set([...known, ...referenced])].sort();
  const selected = typeof preview?.subject === "string" ? preview.subject : String(query.subject ?? "");
  const option = (subject) => {
    const view = model.subjectView(subject);
    const on = subject === selected ? " selected" : "";
    return `<option value="${esc(subject)}"${on}>${esc(`${view.name} · ${view.kindLabel} · ${view.shortId}`)}</option>`;
  };
  // Prototype `renderAuthz` 当前状态预览: `<div class="card"><div style="display:flex;gap:8px;
  // flex-wrap:wrap"><select class="sel" …>…</select></div>…</div>`. The select must be submittable
  // without script, so it sits in a real `form.inline-form` around the same inner row; the 查看 button
  // is the no-JS submit a `<select>` cannot provide by itself and is marked `hide-when-scripted`: the
  // D0 client drops it once the select enhancement really ran, and `data-autosubmit` restores the
  // prototype's "pick and it submits" behaviour. Without script both stay and the form works.
  //
  // `form-block` is load-bearing (Q11): `form.inline-form` is `display:inline-flex` (shrink-to-fit), and
  // inside it a `width:100%` select has no definite width to resolve, so the row wrapped and the card
  // measured 132px where the prototype's is 92px. As a block, the inner flex row takes the card's own
  // width and stays one line — the button's 40px was a second LINE, not the button itself.
  const form = `<form class="inline-form form-block" method="post" action="${esc(`${base}/preview`)}" data-preview-form><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="view" value="list"><div style="display:flex;gap:8px;flex-wrap:wrap"><select class="sel" name="subject" style="max-width:420px" aria-label="${esc(t("adm.authz.preview.subjectAria"))}" data-autosubmit><option value="">${esc(t("adm.authz.preview.choose"))}</option>${options.map(option).join("")}</select><button class="btn" type="submit" data-enhance="hide-when-scripted">${esc(t("adm.authz.preview.view"))}</button></div></form>`;
  const detail = preview && selected ? previewVerdicts(preview, policies, selected, model, now) : `<p class="help" style="margin:8px 0 0">${esc(t("adm.authz.preview.hint"))}</p>`;
  return `<div class="sect" id="preview"><div class="sect-h"><h2>${esc(t("adm.authz.preview.title"))}</h2><span class="muted">${esc(t("adm.authz.preview.subtitle"))}</span></div><div class="card" style="padding:16px">${form}${detail}</div></div>`;
}

/** Verdicts for one subject: the runtime's own answer first, then the per-policy estimate. */
function previewVerdicts(preview, policies, subject, model, now) {
  const decision = preview?.decision ?? null;
  const lines = [];
  if (decision) {
    const allowed = decision.allowed === true;
    const reason = String(decision.reason ?? "");
    const mode = decision.mode ? ` · ${esc(t("adm.authz.preview.mode", { mode: model.mode(decision.mode).n }))}` : "";
    const matched = Array.isArray(decision.matchedPolicyIds) ? decision.matchedPolicyIds.length : 0;
    lines.push(t("adm.authz.preview.verdict", { icon: ic(allowed ? "checkc" : "ban"), cls: allowed ? "ok" : "no", decision: esc(allowed ? t("adm.authz.preview.allowed") : t("adm.authz.preview.denied")), mode, reason: esc(reason || "—"), matched: esc(String(matched)) }));
  }
  const matching = policies.filter((policy) => policy.enabled !== false && Array.isArray(policy.subjects) && policy.subjects.includes(subject));
  if (!matching.length) {
    lines.push(`<div class="verdict ok">${ic("checkc")}<span>${esc(t("adm.authz.preview.unrestricted"))}</span></div>`);
  } else {
    for (const policy of matching) {
      const state = policyNowState(policy, now);
      const label = state.ok === true ? t("adm.authz.preview.allowedNow") : state.ok === false ? t("adm.authz.preview.modeNow", { mode: model.mode(policy.mode).n }) : t("adm.authz.preview.notDecidable");
      const caps = (Array.isArray(policy.capabilities) ? policy.capabilities : []).map((key) => model.capName(key)).join(esc(t("adm.ui.listSeparator"))) || "—";
      lines.push(`<div class="verdict ${verdictClass(state.ok)}">${ic(state.ok === false ? "ban" : "checkc")}<span><b>${esc(policy.label)}</b> · ${esc(label)}（${esc(state.why)}）· ${esc(t("adm.authz.preview.impact"))} ${esc(caps)}</span></div>`);
    }
  }
  const meta = preview
    ? `<p class="help" style="margin:8px 0 0">${esc(t("adm.authz.preview.metaNow"))} <span class="mono">${esc(preview.now ?? "—")}</span> · ${esc(t("adm.authz.preview.metaZone"))} <span class="mono">${esc(preview.timezone ?? "—")}</span> · ${esc(t("adm.authz.preview.metaNextChange"))} <span class="mono">${esc(preview.nextChangeAt ?? "—")}</span> · ${esc(t("adm.authz.preview.metaNextAllowed"))} <span class="mono">${esc(preview.nextAllowedAt ?? "—")}</span></p>`
    : "";
  return `${lines.join("")}${meta}`;
}

/** The `?id=` detail drawer: fields, consequence banners, window detail, danger zone. */
function policyDrawer(ctx, policy) {
  const { model, csrf, accessPolicyBase: base, authz, now = Date.now() } = ctx;
  const mode = model.mode(policy.mode);
  const win = presentAccessPolicyWindow(policy);
  const state = policyNowState(policy, now);
  const enabled = policy.enabled !== false;
  const revision = authz?.revision ?? null;
  const subjects = Array.isArray(policy.subjects) ? policy.subjects : [];
  const orphans = subjects.filter((subject) => model.subjectView(subject).missing);
  const lastEnabledOrphanBanner = orphans.length
    ? banner(t("adm.authz.drawer.orphanBanner", { count: orphans.length, ids: orphans.map((subject) => `<span class="mono">${esc(model.subjectView(subject).shortId)}</span>`).join(esc(t("adm.ui.listSeparator"))) }), { tone: "amber" })
    : "";
  const revokeBanner = policy.mode === "revoke"
    ? banner(t("adm.authz.drawer.revokeBanner"), { tone: "amber" })
    : "";
  const fields = kv([
    [t("adm.authz.drawer.kv.id"), idc(policy.id, policy.id)],
    [t("adm.authz.drawer.kv.label"), esc(policy.label)],
    [t("adm.authz.drawer.kv.status"), `${enabled ? `<span class="st ok"><span class="dot"></span>${esc(t("adm.authz.status.enabled"))}` : `<span class="st off"><span class="dot"></span>${esc(t("adm.authz.status.disabled"))}`}</span>`],
    [t("adm.authz.drawer.kv.mode"), `${esc(mode.n)} <span class="mono muted">${esc(String(policy.mode ?? ""))}</span>`],
    [t("adm.authz.drawer.kv.timezone"), `<span class="mono">${esc(String(policy.timezone ?? "—"))}</span>`],
    [t("adm.authz.drawer.kv.revision"), revision === null ? `<span class="muted">${esc(t("adm.authz.notProvided"))}</span>` : `<span class="mono">${esc(String(revision))}</span>`],
    [t("adm.authz.drawer.kv.created"), esc(fmtFull(policy.createdAt))],
    [t("adm.authz.drawer.kv.updated"), `${relTitle(policy.updatedAt, now)} <span class="muted mono">${esc(fmtFull(policy.updatedAt))}</span>`],
  ]);
  const subjectList = subjects.length
    ? `<div class="selrow">${subjects.map((subject) => {
      const view = model.subjectView(subject);
      const orphan = view.missing ? ` <span class="tag danger">${esc(t("adm.authz.orphanTag"))}</span>` : "";
      return `<span class="pill" title="${esc(subject)}"><span class="kind">${esc(view.kindLabel)}</span>${esc(view.name)} <span class="mono muted">${esc(view.shortId)}</span>${orphan}</span>`;
    }).join("")}</div>`
    : `<p class="help" style="margin:0">${esc(t("adm.authz.noSubjects"))}</p>`;
  const marks = win.summary.markers.map((marker) => `<span class="tag" style="margin:4px 4px 0 0">${esc(marker)}</span>`).join("");
  const caps = (Array.isArray(policy.capabilities) ? policy.capabilities : []).map((key) => `<span class="tag ${key === "all" ? "amber" : ""}" title="${esc(key)}">${esc(model.capName(key))}</span>`).join("");
  const verdict = `<div class="verdict ${verdictClass(state.ok)}" style="margin-top:12px">${ic(state.ok === false ? "ban" : "checkc")}<span>${esc(t("adm.authz.drawer.now"))} ${esc(policyNowLabel(policy, now))} <span class="mono">${esc(String(policy.timezone ?? ""))}</span> <b>${esc(state.ok === true ? t("adm.authz.drawer.allowedAccess") : state.ok === false ? mode.n : t("adm.authz.undetermined"))}</b> · ${esc(state.why)}</span></div>`;
  const toggle = enabled
    ? `<form class="inline-form" method="post" action="${esc(`${base}/toggle`)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="id" value="${esc(policy.id)}"><input type="hidden" name="enabled" value="false"><input type="hidden" name="expectedRevision" value="${esc(revision ?? "")}"><button class="btn danger-o" type="submit">${esc(t("adm.authz.drawer.disableAction"))}</button></form>`
    : `<form class="inline-form" method="post" action="${esc(`${base}/toggle`)}"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="id" value="${esc(policy.id)}"><input type="hidden" name="enabled" value="true"><input type="hidden" name="expectedRevision" value="${esc(revision ?? "")}"><button class="btn" type="submit">${esc(t("adm.authz.status.enabled"))}</button></form>`;
  const dangerZone = `<div class="dsec"><h3>${esc(t("adm.accounts.dangerTitle"))}</h3><div class="danger-zone">
  <div class="dz"><div class="t"><b>${enabled ? esc(t("adm.authz.menu.disable")) : esc(t("adm.authz.menu.enable"))}</b>${enabled ? esc(t("adm.authz.drawer.disableDesc")) : esc(t("adm.authz.drawer.enableDesc"))}</div>${toggle}</div>
  <div class="dz"><div class="t"><b>${esc(t("adm.authz.drawer.deleteTitle"))}</b>${esc(t("adm.authz.drawer.deleteDesc"))}</div><a class="btn danger-o" href="${esc(`${base}?confirm=delete&id=${encodeURIComponent(policy.id)}`)}">${esc(t("adm.accounts.deleteAction"))}</a></div>
</div></div>`;
  const bodyHtml = `${lastEnabledOrphanBanner}${revokeBanner}
<div class="dsec"><h3>${esc(t("adm.authz.drawer.sectionPolicy"))}</h3>${fields}</div>
<div class="dsec"><h3>${esc(t("adm.authz.drawer.sectionSubjects"))} <span class="muted" style="font-weight:400">${subjects.length}</span></h3>${subjectList}</div>
<div class="dsec"><h3>${esc(t("adm.authz.drawer.sectionCaps"))}</h3><div class="tags">${caps || `<span class="muted">—</span>`}</div></div>
<div class="dsec"><h3>${esc(t("adm.authz.drawer.sectionWindow"))}</h3><div class="sumbox"><b>${esc(win.summary.text)}</b>${marks ? `<div>${marks}</div>` : ""}<div class="muted" style="margin-top:4px">${esc(WINDOW_SCOPE_DISCLAIMER)}</div></div><div style="margin-top:16px">${policyTimelineHtml(policy, now)}</div>${verdict}</div>
${dangerZone}`;
  const footHtml = `<a class="btn primary" href="${esc(`${base}?edit=${encodeURIComponent(policy.id)}`)}">${esc(t("adm.authz.drawer.edit"))}</a><a class="btn ghost" href="${esc(base)}">${esc(t("adm.ui.close"))}</a>`;
  return drawer({
    title: policy.label,
    subtitle: t("adm.authz.drawer.subtitle", { status: enabled ? t("adm.authz.status.enabled") : t("adm.authz.status.disabled"), mode: mode.n }),
    closeHref: base,
    bodyHtml,
    footHtml,
  });
}

/** Message for `?done=<action>` — a fixed map, so a crafted query can never echo text back. */
const DONE_MESSAGE_KEYS = Object.freeze({
  create: "adm.authz.done.create",
  update: "adm.authz.done.update",
  toggle: "adm.authz.done.toggle",
  delete: "adm.authz.done.delete",
  repair: "adm.authz.done.repair",
});

/** The 定时授权 tab: list + banners + 当前状态预览 (+ the `?id=` drawer). */
export function renderAuthzPage(ctx) {
  const { model, authz, csrf, query = {}, accessPolicyBase: base, now = Date.now(), preview = null } = ctx;
  const policies = Array.isArray(authz?.policies) ? authz.policies : [];
  const revision = authz?.revision ?? null;
  const broken = authz?.status === "broken";
  const orphans = Array.isArray(authz?.orphaned) ? authz.orphaned : [];
  const runtime = ctx.runtimeState ?? null;
  const masterOn = runtime ? runtime.enabled === true : authz?.enabled === true;

  // Sorting is server state (`table-sort.js`). No column is pre-selected: the list keeps the store's
  // own order until the operator clicks a header (the #406 probe follows the first editor link, so a
  // re-ordered list would hand it a different policy).
  const sort = readSort(query, ["policy", "status", "subjects", "caps", "window"], null);
  const listed = sortRows(policies, sort, {
    policy: (policy) => policy.label || policy.id || null,
    status: (policy) => (policy.enabled !== false ? 1 : 0),
    subjects: (policy) => (Array.isArray(policy.subjects) ? policy.subjects.length : 0),
    caps: (policy) => (Array.isArray(policy.capabilities) ? policy.capabilities.length : 0),
    window: (policy) => presentAccessPolicyWindow(policy).summary.text || null,
  });
  const columns = [[t("adm.authz.col.policy"), "22%", "", "policy"], [t("adm.authz.col.status"), "12%", "", "status"], [t("adm.authz.col.subjects"), "22%", "", "subjects"], [t("adm.authz.col.caps"), "16%", "", "caps"], [t("adm.authz.col.window"), "24%", "", "window"], ["", "", "act"]];
  const rows = listed.map((policy) => `<tr class="click ${policy.enabled !== false ? "" : "dim"}">
<td><a class="cell-link block" href="${esc(`${base}?edit=${encodeURIComponent(policy.id)}`)}"><div class="nm"><b>${esc(policy.label)}</b><span class="sub2">${idc(policy.id)}<span>${esc(t("adm.authz.row.updatedAt", { time: relTitle(policy.updatedAt, now) }))}</span></span></div></a></td>
<td>${policyStatusCell(model, policy)}</td>
<td>${policySubjectsCell(model, policy)}</td>
<td><div class="tags">${model.capTags(policy.capabilities)}</div></td>
<td>${policyWindowCell(policy, now)}</td>
<td class="act">${policyRowMenu({ base, policy, csrf, revision })}</td></tr>`);
  const cards = listed.map((policy) => {
    const win = presentAccessPolicyWindow(policy);
    const subjects = (Array.isArray(policy.subjects) ? policy.subjects : []).map((subject) => model.subjectView(subject).name);
    return `<div class="mc"><div class="b"><div class="nm"><a class="cell-link block" href="${esc(`${base}?edit=${encodeURIComponent(policy.id)}`)}"><b>${esc(policy.label)}</b></a><span class="sub2">${esc(t("adm.authz.drawer.subtitle", { status: policy.enabled !== false ? t("adm.authz.status.enabled") : t("adm.authz.status.disabled"), mode: model.mode(policy.mode).n }))}</span></div><span class="tx2" style="font-size:13px">${esc(win.summary.text)}</span><div class="meta">${subjects.map((name) => `<span>${esc(name)}</span>`).join("")}</div></div>${policyRowMenu({ base, policy, csrf, revision })}</div>`;
  });
  const empty = emptyState(
    "cal",
    policies.length ? t("adm.authz.empty.noMatch") : t("adm.authz.empty.none"),
    t("adm.authz.empty.hint"),
    broken ? "" : `<a class="btn primary" href="${esc(`${base}?new=1`)}">${ic("plus")}${esc(t("adm.authz.new"))}</a>`,
  );

  const newCta = broken
    ? `<span class="btn primary" aria-disabled="true" title="${esc(t("adm.authz.newDisabledTitle"))}">${ic("plus")}<span class="hide-m">${esc(t("adm.authz.new"))}</span></span>`
    : `<a class="btn primary" href="${esc(`${base}?new=1`)}">${ic("plus")}<span class="hide-m">${esc(t("adm.authz.new"))}</span></a>`;
  // The prototype's master switch is scripted and marked 规划中 (Stage 5): it is rendered as a
  // non-interactive state indicator with the planned marker — never as a fake CTA. Its *state* is
  // real (the runtime summary), so the banner tone and the label are honest. The banner is built
  // directly (not through `banner()`), because the prototype puts the switch next to the text as a
  // sibling of the flex-1 text block.
  const masterSwitch = `<div class="futonly bm" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="muted" style="font-size:13px">${esc(t("adm.authz.master.label"))}</span><span class="switch ${masterOn ? "on" : ""}" role="img" aria-label="${esc(t("adm.authz.master.aria"))}" title="${esc(t("adm.authz.master.title", { state: masterOn ? t("adm.authz.master.on") : t("adm.authz.master.off") }))}"></span>${fut("Stage 5")}</div>`;
  const masterBanner = `<div class="banner ${masterOn ? "acc" : ""}">${ic("shield")}<div style="flex:1">${t("adm.authz.master.banner")}<details style="margin-top:4px"><summary class="muted" style="cursor:pointer">${esc(t("adm.authz.master.details"))}</summary><span class="muted">${t("adm.authz.master.detailsBody", { revision: esc(revision === null ? t("adm.authz.notProvided") : String(revision)) })}</span></details></div>${masterSwitch}</div>`;
  const brokenBanner = broken
    ? banner(`${t("adm.authz.banner.broken", { error: authz?.error ? `（${esc(String(authz.error).slice(0, 200))}）` : "" })}${t("adm.authz.banner.brokenForm", { action: esc(`${base}/repair`), csrf: esc(csrf || ""), document: esc(ctx.repairDocument ?? "") })}`, { tone: "danger" })
    : "";
  const orphanBanner = orphans.length
    ? banner(t("adm.authz.banner.orphans", { count: orphans.length, ids: orphans.map((subject) => `<span class="mono" title="${esc(subject)}">${esc(model.subjectView(subject).shortId)}</span>`).join(esc(t("adm.ui.listSeparator"))) }), { tone: "amber" })
    : "";
  const conflict = ctx.conflict
    ? banner(t("adm.authz.banner.conflict"), { tone: "danger" })
    : "";
  const doneKey = typeof query.done === "string" ? DONE_MESSAGE_KEYS[query.done] : null;
  const done = doneKey ? t(doneKey) : null;
  const notice = [done ? result(true, esc(done)) : "", ctx.failure ? result(false, esc(String(ctx.failure))) : ""].join("");

  const wanted = typeof query.id === "string" && query.id.trim()
    ? query.id.trim()
    : typeof query.window === "string" && query.window.trim() ? query.window.trim() : "";
  const selected = wanted ? policies.find((policy) => policy.id === wanted) ?? null : null;
  const missingDrawer = wanted && !selected
    ? drawer({
      title: t("adm.authz.missingTitle"),
      closeHref: base,
      bodyHtml: `<div class="dsec">${emptyState("cal", t("adm.authz.missingEmptyTitle"), t("adm.authz.missingBody"), `<a class="btn" href="${esc(base)}">${esc(t("adm.authz.backToList"))}</a>`)}</div>`,
    })
    : "";
  const detailPanel = selected ? policyDrawer(ctx, selected) : missingDrawer;

  const content = `${pageBar({ title: t("adm.nav.accessPolicy"), count: policies.length, actions: newCta })}<div class="content scroll"><div class="page wide">
${notice}
${masterBanner}
${conflict}
${brokenBanner}
${orphanBanner}
${table(columns, rows, empty, { ...sort, base })}${mcards(cards)}
${previewSection(ctx)}
</div></div>`;
  return { content, detailPanel };
}
