// 定时授权 — policy editor (prototype `docs/admin-ui-proto/src/5-render.js renderPolicyEditor()`
// + the `6-app.js` save/confirm rules). Reached at `?edit=<id>`, `?new=1` and `?copy=<id>`.
//
// No script (CSP `default-src 'none'`, D0 HOLD). The prototype editor is interactive (day chips,
// capability accordions, live preview); the SSR form keeps every *field, value and warning* and
// replaces each interaction by server state:
//   * day chips / "add a slot"  -> a fixed structured grid of 每周窗口 rows (one per weekday, up to
//     the number of stored intervals), where an empty row means "no constraint that day";
//   * 工作日 9–18 / 每天 / 清空 -> GET links that reload the form with `?weeklyPreset=` prefill;
//   * capability & subject search -> GET round trips (`?capq=` / `?subjq=`) above the form, because
//     a GET form may not be nested inside the POST form the browser has to submit;
//   * capability groups -> the prototype's `<details class="cap-g">` + `<summary class="cap-h">` +
//     `<div class="cap-b">` around **native** `<input type="checkbox">` rows (open when the group
//     holds a stored selection); the revoke lock renders the same shell with one locked row;
//   * subject choices -> prototype chips (`.chips` + `label.chip`), each wrapping a native
//     `<input type="checkbox" name="subjects">` while keeping the prototype row's `.nm`/`.sub2`
//     structure — the prototype paints the row with a scripted checkbox, so a chip that carries its
//     own checkbox is the honest no-script form of that control (and the choice stays a real field);
//   * the 状态 switch -> a real checkbox in a `.chk` row (a dead scripted switch would be a lie);
//   * the live preview -> the same preview computed server-side from the loaded draft, with an
//     explicit note that unsaved typing is not reflected.
// `revoke` keeps the prototype's capability lock: the picker renders `all` locked and the route
// forces `["all"]`, which the service validates again.
import { pageBar, searchBox, searchForm, banner, result, esc, ic, switchControl } from "../ui.js";
import { idc } from "../presentation/format.js";
import { presentAccessPolicyWindow, WINDOW_DAY_LABELS } from "../access-policy-window-presentation.js";
import { zonedParts } from "../presentation/model.js";
import { KIND_LABEL, MODE } from "../presentation/vocab.js";
import { policyNowLabel, policyNowState, policyTimelineHtml, WEEK_DAYS } from "./authz.js";

/** `HH:MM` suggestions for the weekly boundaries (every 30 minutes), plus the `24:00` end of day. */
const TIME_OPTIONS = Object.freeze([
  ...Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`),
  "24:00",
]);

/** Zones offered by the prototype's timezone `<select>` (a datalist here: no script). */
export const COMMON_TIMEZONES = Object.freeze([
  "UTC", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore",
  "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles",
]);

/** `weeklyPreset` spellings, including the ones the previous form linked to. */
export const WEEKLY_PRESETS = Object.freeze({
  work: { mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]], thu: [["09:00", "18:00"]], fri: [["09:00", "18:00"]] },
  // Seven explicit all-day intervals. The service defaults a MISSING `weekly` to work hours, so the
  // preset cannot simply omit the field; the editor collapses these rows visually instead.
  all: { mon: [["00:00", "24:00"]], tue: [["00:00", "24:00"]], wed: [["00:00", "24:00"]], thu: [["00:00", "24:00"]], fri: [["00:00", "24:00"]], sat: [["00:00", "24:00"]], sun: [["00:00", "24:00"]] },
  clear: {},
});

export function resolveWeeklyPreset(name) {
  const key = String(name ?? "");
  if (key === "workdays") return WEEKLY_PRESETS.work;
  if (key === "everyday") return WEEKLY_PRESETS.all;
  return Object.prototype.hasOwnProperty.call(WEEKLY_PRESETS, key) ? WEEKLY_PRESETS[key] : null;
}

/** Stored intervals for one weekday, as `[[from, to], …]` (raw policy `weekly` record). */
export function weeklyIntervals(policy, day) {
  const weekly = policy?.weekly;
  const list = weekly && typeof weekly === "object" && !Array.isArray(weekly) && Array.isArray(weekly[day]) ? weekly[day] : [];
  return list.filter(Array.isArray).map((pair) => [String(pair[0] ?? ""), String(pair[1] ?? "")]);
}

/** Stored date ranges, as `[{ from, to }, …]`. */
export function dateRangeRows(policy) {
  const list = Array.isArray(policy?.dateRanges) ? policy.dateRanges : [];
  return list.filter((range) => range && typeof range === "object").map((range) => ({ from: String(range.from ?? ""), to: String(range.to ?? "") }));
}

/** ISO instant -> `datetime-local` wall clock in the policy's timezone (prototype `utc()` inverse). */
function localInputValue(iso, zone) {
  if (!iso) return "";
  const parts = zone ? zonedParts(iso, zone) : null;
  if (!parts) return "";
  return `${parts.date}T${parts.hm}`;
}

/** The UTC echo under each bound (prototype `utc()`): the value the schema will really store. */
function utcEcho(iso) {
  return iso ? `<span class="mono">${esc(iso)}</span>` : "未提供";
}

function enabledControl(policy) {
  const on = policy?.enabled !== false;
  // Prototype `renderPolicyEditor` 状态 row: `<div style="display:flex;align-items:center;gap:8px;
  // height:32px"><button class="switch on"></button><span class="tx2">保存后立即生效</span></div>`.
  // The plane renders the same box with a real checkbox under it (`ui.switchControl`), so the field
  // exists and toggles without script, and the sentence next to it is the prototype's own.
  return `<div style="display:flex;align-items:center;gap:8px;height:32px">${switchControl({ on, name: "enabled", title: "启用" })}<span class="tx2" style="font-size:13px">${on ? "保存后立即生效" : "保存但不生效"}</span></div>`;
}

/** 窗口外的处理方式 — prototype `.mode` cards, as real radios (no script ⇒ no `.on` toggling). */
function modeControl(mode) {
  const card = (key) => {
    const item = MODE[key];
    const on = mode === key ? "on" : "";
    // `rv` mirrors the prototype's `.on.rv` (danger fill for 撤销); the inline align-items is gone because
    // ADMIN_SSR_CSS now owns the card layout (`.mode .chk`).
    const rv = key === "revoke" ? " rv" : "";
    return `<label class="chk ${on}${rv}"><input type="radio" name="mode" value="${key}"${mode === key ? " checked" : ""}><span><b><span class="radio"></span>${esc(item.n)} <span class="mono" style="color:var(--tx4);font-weight:400">${key}</span></b><span class="d">${esc(item.d)}</span></span></label>`;
  };
  return `<div class="mode">${card("suspend")}${card("revoke")}</div>`;
}

/** Capability picker: prototype `.picker` + `.cap-g` groups, `<details>` instead of a scripted accordion. */
function capabilityPicker({ mode, selected, groups, query, search = "", hidden = {}, formId = "" }) {
  const picked = new Set(Array.isArray(selected) ? selected : []);
  const needle = String(query ?? "").trim();
  // Prototype `renderPolicyEditor`: with nothing selected it opens ONE group (`S.capOpen.add("scope")`
  // when the draft has no capabilities at all), so the editor never presents six closed boxes.
  const defaultOpen = picked.size === 0;
  const lower = needle.toLowerCase();
  // Prototype: the filter is the FIRST child of the panel (`.picker > .search`), not a toolbar of
  // its own (`5-render.js`: `<div class="picker"><label class="search">...<input data-capq>...</label>`).
  const filter = searchBox({ placeholder: "搜索能力，例如 写入、git、write_note", value: needle, name: "capq", hidden, label: "搜索能力", action: search, hint: false, formId });
  if (mode === "revoke") {
    return `<div class="picker">${filter}<details class="cap-g" open><summary class="cap-h open">${ic("chev", "chev")}<b>全部能力</b><span class="mono" style="color:var(--tx4)">all</span><span class="grow"></span><span class="tag acc">已选 1</span><span>1 项</span></summary><div class="cap-b"><label class="chk"><input type="checkbox" checked disabled><span><b>全部能力</b><span class="d">revoke 模式固定为 all（principal-wide），服务端再次校验</span></span></label><input type="hidden" name="capabilities" value="all"></div></details></div>`;
  }
  const sections = (Array.isArray(groups) ? groups : []).map((group) => {
    // RETURN-3 P1: the filter narrows the catalogue, never the selection — a stored token outside
    // the filter stays rendered and checked, so the next save cannot silently drop it.
    const items = group.items.filter((item) => picked.has(item.key)
      || item.key.toLowerCase().includes(lower)
      || String(item.name ?? "").toLowerCase().includes(lower));
    if (!items.length) return "";
    const ordered = [...items].sort((left, right) => Number(picked.has(right.key)) - Number(picked.has(left.key)) || left.key.localeCompare(right.key));
    const selectedCount = items.filter((item) => picked.has(item.key)).length;
    const open = selectedCount > 0 || (defaultOpen && group.group === "scope") ? " open" : "";
    const rows = ordered.map((item) => `<label class="chk"><input type="checkbox" name="capabilities" value="${esc(item.key)}"${picked.has(item.key) ? " checked" : ""}><span>${esc(item.name)} <span class="mono">${esc(item.key)}</span></span></label>`).join("");
    return `<details class="cap-g"${open}><summary class="cap-h${open}">${ic("chev", "chev")}<b>${esc(group.label)}</b><span class="mono" style="color:var(--tx4)">${esc(group.group)}</span><span class="grow"></span>${selectedCount ? `<span class="tag acc">已选 ${selectedCount}</span>` : ""}<span>${items.length} 项</span></summary><div class="cap-b">${rows}</div></details>`;
  }).join("");
  // Prototype `renderPolicyEditor`: the panel is `<div class="picker">` + the search + the groups.
  // The count line the plane used to render above them (`已选 N 项；其中 M 项…`) does not exist in
  // the prototype; the selection count already sits in each group header (`.tag.acc 已选 N`).
  return `<div class="picker">${filter}${sections || `<div class="empty" style="padding:24px"><b>没有匹配的能力</b><span>清空关键词后重试</span></div>`}</div>`;
}

/**
 * Subject picker — the prototype's `.picker` rows (`.pick` + `.nm`/`.sub2`) rendered as chips.
 *
 * The prototype paints one `.pick` row per subject and wires it with a scripted checkbox; without
 * script the choice has to *be* a real `<input type="checkbox">`, and the coordinator's ruling is
 * that its shell is the prototype's chip vocabulary (`.chips` > `label.chip`). Both class sets are
 * the prototype's own, and the row keeps the prototype's `.nm`/`.sub2` structure (the Admin layout
 * parity gate derives those as required elements of this page). The filter narrows the *list*, never
 * the selection, and an unknown subject stays visible and checkable (advisory, not a save blocker).
 */
function subjectPicker({ known, draftSubjects, view, query, search = "", hidden = {}, formId = "" }) {
  const picked = new Set(Array.isArray(draftSubjects) ? draftSubjects : []);
  const knownSet = new Set(known);
  const orphans = [...picked].filter((subject) => !knownSet.has(subject));
  const needle = String(query ?? "").trim().toLowerCase();
  // Same rule as the capability filter (RETURN-3 P1): the filter narrows the *list*, never the
  // selection — a checked subject outside the filter stays rendered and checked.
  const matches = (subject) => {
    if (!needle || picked.has(subject)) return true;
    const item = view(subject);
    return [subject, item.name, item.sub, item.shortId].some((value) => String(value ?? "").toLowerCase().includes(needle));
  };
  const group = (kind, list) => {
    if (!list.length) return "";
    const rows = [...list].sort().map((subject) => {
      const item = view(subject);
      const italic = item.unnamed || item.missing ? "font-style:italic;font-weight:400" : "";
      const subline = item.sub ? `${esc(item.sub)} · ` : "";
      const title = [item.kindLabel, item.sub, subject].filter(Boolean).join(" · ");
      return `<label class="pick" title="${esc(title)}"><input type="checkbox" name="subjects" value="${esc(subject)}"${picked.has(subject) ? " checked" : ""}><div class="nm"><b style="${italic}">${esc(item.name)}</b><span class="sub2">${subline}<span class="mono">${esc(item.shortId)}</span></span></div>${item.missing ? `<span class="tag danger">孤立</span>` : `<span class="kind">${esc(item.kindLabel)}</span>`}</label>`;
    }).join("");
    // Prototype `renderPolicyEditor` 主体 panel: one `.pick-g` header per kind, then the `.pick` rows
    // of that kind directly inside `.pick-list` (no `.chips` wrapper — that wrapper was an earlier
    // lane's addition and is the one shape difference the parity gate reported here). The checkbox
    // inside each row is the real field (no-JS contract).
    return `<div class="pick-g"><span>${esc(kind)}</span><span>${list.length}</span></div>${rows}`;
  };
  const byKind = (prefix) => [...knownSet].filter((subject) => subject.startsWith(`${prefix}:`) && matches(subject));
  const body = [
    group(KIND_LABEL["api-key"], byKind("api-key")),
    group(KIND_LABEL["oauth-client"], byKind("oauth-client")),
    group(KIND_LABEL["oauth-user"], byKind("oauth-user")),
    orphans.length ? group("已不在快照中的主体", orphans.filter(matches)) : "",
  ].join("");
  const empty = needle
    ? `<div class="empty" style="padding:24px"><b>没有匹配的主体</b><span>清空关键词后重试</span></div>`
    : `<div class="empty" style="padding:24px"><b>没有可用的主体</b><span>当前凭据快照里没有 Key、客户端或账户</span></div>`;
  return `<div class="picker">${searchBox({ placeholder: "按名称、账户或 ID 搜索", value: query ?? "", name: "subjq", hidden, label: "搜索主体", action: search, hint: false, formId })}<div class="pick-list scroll">${body || empty}</div></div>`;
}

function fieldset(legend, bodyHtml, aside = "") {
  return `<fieldset class="fs"><legend>${esc(legend)}${aside ? ` <span class="muted">${aside}</span>` : ""}</legend>${bodyHtml}</fieldset>`;
}

/**
 * One `HH:MM` boundary field for the weekly grid.
 *
 * `<input type="time">` cannot carry the schema's `24:00` end-of-day value (HTML time inputs are
 * limited to 00:00–23:59, so a browser silently empties an invalid value). Rendering `24:00` into one
 * produced a form nobody could submit unchanged: Chrome posted `w_mon_to_1=""` next to
 * `w_mon_from_1="00:00"`, the service rejected the asymmetric window (INVALID_WINDOW 400), and the
 * editor's own 「每天」preset wrote `24:00` — so the page offered a value it could not round-trip.
 * The field is therefore a plain `.inp` (prototype class) with a native suggestion list and a
 * `pattern` that is exactly the schema's grammar: a clock time, plus `24:00` as an interval end.
 */
function timeField({ name, value, label, end = false }) {
  const clock = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";
  const pattern = end ? `(?:${clock}|24:00)` : clock;
  const hint = end ? "HH:MM；24:00 表示当天结束" : "HH:MM（00:00–23:59）";
  return `<input class="inp" type="text" list="authz-times" name="${esc(name)}" value="${esc(value)}" pattern="${pattern}" maxlength="5" placeholder="HH:MM" aria-label="${esc(label)}" title="${esc(hint)}">`;
}

/**
 * Weekly grid — prototype `renderPolicyEditor`'s `.chips` day row plus ONE `.wrow` per stored
 * interval (a day with no interval renders no row at all: "nothing set" is not an empty time box).
 *
 * Every control the prototype scripts is here a GET round trip over the SAME state (`?day=`, 
 * `?addSlot=1`), so the flow works without a single line of script: click 周一 → a 09:00–18:00 slot
 * appears (prototype `6-app.js:311`), 为已选日期再加一个时段 → one more slot per selected day
 * (`6-app.js:353`), and the three preset links are the prototype's own. Editing a value and pressing
 * Enter submits the editor form, so nothing here needs a script to be usable.
 */
function weeklyGrid(policy, { base, editQuery }) {
  // A policy that spells out "every day, all day" (however it was written) is the same thing as an empty
  // weekly record. Rendering seven 00:00–24:00 rows for it is noise the prototype never shows (its
  // fixture simply has no weekly). Collapse it to one honest line; the link re-expands it per day.
  const everyDayAllDay = WEEK_DAYS.every((day) => {
    const intervals = weeklyIntervals(policy, day);
    return intervals.length === 1 && intervals[0][0] === "00:00" && intervals[0][1] === "24:00";
  });
  const hiddenRows = everyDayAllDay
    ? WEEK_DAYS.map((day) => `<input type="hidden" name="w_${day}_from_1" value="00:00"><input type="hidden" name="w_${day}_to_1" value="24:00">`).join("")
    : "";
  const rows = everyDayAllDay ? "" : WEEK_DAYS.flatMap((day) => weeklyIntervals(policy, day).map(([from, to], index) => `<div class="wrow"><span class="lab">${index === 0 ? esc(WINDOW_DAY_LABELS[day]) : ""}</span>${timeField({ name: `w_${day}_from_${index + 1}`, value: from, label: `${WINDOW_DAY_LABELS[day]} ${index + 1} 开始时间` })}<span class="muted" style="text-align:center">–</span>${timeField({ name: `w_${day}_to_${index + 1}`, value: to, label: `${WINDOW_DAY_LABELS[day]} ${index + 1} 结束时间`, end: true })}<span></span></div>`)).join("");
  const selected = everyDayAllDay ? [] : WEEK_DAYS.filter((day) => weeklyIntervals(policy, day).length > 0);
  const link = (extra, label, cls) => `<a class="${cls}" href="${esc(`${base}?${editQuery(extra)}`)}">${label}</a>`;
  const chips = WEEK_DAYS.map((day) => {
    const on = selected.includes(day);
    return `<a class="chip${on ? " on" : ""}" href="${esc(`${base}?${editQuery({ day })}`)}" title="${esc(on ? "已有窗口，点击移除" : "点击添加 09:00–18:00")}">${esc(WINDOW_DAY_LABELS[day])}</a>`;
  }).join("");
  return `<div class="chips">${chips}<span style="width:8px"></span>${link({ weeklyPreset: "work" }, "工作日 9–18", "btn ghost sm")}${link({ weeklyPreset: "all" }, "每天", "btn ghost sm")}${link({ weeklyPreset: "clear" }, "清空", "btn ghost sm")}</div>
${everyDayAllDay ? `<p class="help" style="margin:8px 0 0">当前等价于「每天全天」，所以不逐日列出（保存时仍按七天全天提交）。${link({ weeklyPreset: "work" }, "改成工作日 9–18", "btn ghost sm")}</p>${hiddenRows}` : ""}
${rows ? `<div style="margin-top:var(--s2)">${rows}</div>` : ""}
${selected.length ? `<a class="addl" href="${esc(`${base}?${editQuery({ addSlot: "1" })}`)}">${ic("plus", "xs")}为已选日期再加一个时段</a>` : ""}
<span class="help">不支持跨午夜，跨午夜请拆成两段（如 22:00–24:00 和次日 00:00–06:00）；结束时间用 24:00 表示当天结束。上面三个快捷项会重新载入表单（未保存的改动会丢失）。</span>`;
}

/** Date-range rows: one `.drow` per stored range plus the prototype's 添加日期区间 action. */
function rangeGrid(policy, { base, editQuery }) {
  const stored = dateRangeRows(policy);
  const rows = stored.map((range, index) => `<div class="drow"><input class="inp" type="date" name="range_from_${index + 1}" value="${esc(range.from)}" aria-label="限定日期开始 ${index + 1}"><span class="muted" style="text-align:center">–</span><input class="inp" type="date" name="range_to_${index + 1}" value="${esc(range.to)}" aria-label="限定日期结束 ${index + 1}"><span></span></div>`).join("");
  return `${rows}<a class="addl" href="${esc(`${base}?${editQuery({ addRange: "1" })}`)}">${ic("plus", "xs")}添加日期区间</a>`;
}

/**
 * Preview pane (prototype `.ped-side`): summary, timeline, now verdict, per-subject impact.
 *
 * Exported so the client-facing fragment endpoint (`GET /admin/auth/access-policy/preview`, the
 * live-preview path) can return exactly this block instead of a whole editor page: the verdict must
 * stay a single server implementation, so the browser adopts what the server rendered rather than
 * recomputing it.
 */
export function previewPane(ctx) {
  const { draft, model, authz, csrf, query = {}, accessPolicyBase: base, now = Date.now(), preview = null } = ctx;
  const win = presentAccessPolicyWindow(draft);
  const zone = typeof draft?.timezone === "string" ? draft.timezone : "—";
  const mode = MODE[draft?.mode] ?? MODE.suspend;
  const caps = (Array.isArray(draft?.capabilities) ? draft.capabilities : []).map((key) => model.capName(key)).join("、") || "（未选择能力）";
  const marks = win.summary.markers.map((marker) => `<span class="tag" style="margin:4px 4px 0 0">${esc(marker)}</span>`).join("");
  const state = policyNowState(draft, now);
  const subjects = Array.isArray(draft?.subjects) ? draft.subjects : [];
  const policies = (Array.isArray(authz?.policies) ? authz.policies : []).filter((policy) => policy.id !== draft?.id);
  const impact = subjects.length
    ? subjects.map((subject) => {
      const view = model.subjectView(subject);
      const matching = [
        ...(draft.enabled !== false ? [draft] : []),
        ...policies.filter((policy) => policy.enabled !== false && Array.isArray(policy.subjects) && policy.subjects.includes(subject)),
      ];
      const lines = matching.length
        ? matching.map((policy) => {
          const item = policy === draft ? state : policyNowState(policy, now);
          const label = item.ok === true ? "此刻允许" : item.ok === false ? `此刻${model.mode(policy.mode).n}` : "暂无法判定";
          const policyCaps = (Array.isArray(policy.capabilities) ? policy.capabilities : []).map((key) => model.capName(key)).join("、") || "—";
          const tag = policy === draft ? ` <span class="tag acc">编辑中</span>` : "";
          return `<div class="verdict ${item.ok === true ? "ok" : item.ok === false ? "no" : ""}">${ic(item.ok === false ? "ban" : "checkc")}<span><b>${esc(policy.label)}</b>${tag} · ${esc(label)}（${esc(item.why)}）· 影响：${esc(policyCaps)}</span></div>`;
        }).join("")
        : `<div class="verdict ok">${ic("checkc")}<span><b>不受定时授权限制</b> · 没有启用的策略引用该主体</span></div>`;
      return `<div style="margin-top:8px"><div style="font-size:13px;color:var(--tx2)">${esc(view.name)} <span class="muted">${esc(view.kindLabel)}</span></div>${lines}</div>`;
    }).join("")
    : `<p class="help">选择主体后显示</p>`;
  const decision = preview?.decision
    ? `<div class="verdict ${preview.decision.allowed === true ? "ok" : "no"}">${ic(preview.decision.allowed === true ? "checkc" : "ban")}<span>服务端判定（${esc(String(preview.subject ?? ""))}）：<b>${preview.decision.allowed === true ? "允许" : "拒绝"}</b> · 原因 <span class="mono">${esc(String(preview.decision.reason ?? "—"))}</span></span></div>`
    : "";
  const known = [...new Set([...(Array.isArray(ctx.subjects) ? ctx.subjects : []), ...subjects])].sort();
  const trial = known.length
    ? `<details style="margin-top:16px"><summary class="muted" style="cursor:pointer;font-size:13px">用其他主体试算（服务端判定）</summary><form class="toolbar" method="post" action="${esc(`${base}/preview`)}" style="margin-top:8px"><input type="hidden" name="csrf" value="${esc(csrf || "")}"><input type="hidden" name="view" value="editor"><input type="hidden" name="${draft?.id ? "edit" : "new"}" value="${esc(draft?.id ?? "1")}"><select class="sel sm" name="subject" aria-label="试算主体">${known.map((subject) => `<option value="${esc(subject)}"${preview?.subject === subject ? " selected" : ""}>${esc(model.subjectView(subject).name)}</option>`).join("")}</select><button class="btn ghost sm" type="submit">试算</button></form></details>`
    : "";
  return `<aside class="ped-side"><div class="stick">
<div class="sect-h"><h2>生效预览</h2><span class="muted">${esc(zone)}</span></div>
<div class="sumbox"><b>${esc(win.summary.text)}</b>${marks ? `<div>${marks}</div>` : ""}<div style="margin-top:4px">窗口外：<b>${esc(mode.n)}</b> ${esc(caps)}</div></div>
<div style="margin-top:16px">${policyTimelineHtml(draft, now)}</div>
<div class="verdict ${state.ok === true ? "ok" : state.ok === false ? "no" : ""}" style="margin-top:12px">${ic(state.ok === false ? "ban" : "checkc")}<span>现在（${esc(policyNowLabel(draft, now))}）<b>${state.ok === true ? "允许访问" : state.ok === false ? esc(mode.n) : "无法判定"}</b> · ${esc(state.why)}</span></div>
${decision}
<div class="sect-h" style="margin-top:24px"><h2>对主体的影响</h2></div>
${impact}
${trial}
</div></aside>`;
}

/** The editor page: `.ped` (form + preview) and the sticky `.ped-foot`. */
export function renderAuthzEditorPage(ctx) {
  const { draft, model, csrf, accessPolicyBase: base, capabilities, subjects, orphaned, query = {}, now = Date.now(), policyId = null } = ctx;
  const isNew = !policyId;
  const revision = ctx.expectedRevision ?? ctx.authz?.revision ?? null;
  const editParam = isNew ? (query.copy ? { copy: String(query.copy) } : { new: "1" }) : { edit: String(policyId) };
  const editQuery = (extra = {}) => new URLSearchParams({ ...editParam, ...extra }).toString();
  const orphanSet = new Set(Array.isArray(orphaned) ? orphaned : []);
  const draftOrphans = (Array.isArray(draft?.subjects) ? draft.subjects : []).filter((subject) => orphanSet.has(subject) || model.subjectView(subject).missing);
  const selectedCaps = Array.isArray(draft?.capabilities) ? draft.capabilities : [];
  const subjectPills = (Array.isArray(draft?.subjects) ? draft.subjects : []).map((subject) => {
    const view = model.subjectView(subject);
    const orphan = view.missing ? ` <span class="tag danger">孤立</span>` : "";
    return `<span class="pill" title="${esc(subject)}"><span class="kind">${esc(view.kindLabel)}</span>${esc(view.name)} <span class="mono muted">${esc(view.shortId)}</span>${orphan}</span>`;
  }).join("");
  const capPills = selectedCaps.map((key) => `<span class="pill">${esc(model.capName(key))} <span class="mono muted">${esc(key)}</span></span>`).join("");
  const conflict = ctx.conflict
    ? banner(`<b>保存冲突</b>：其他管理员在你编辑期间修改了策略（修订已变化）。你的改动尚未保存，也未覆盖他人。<div style="margin-top:8px"><a class="btn sm" href="${esc(`${base}?${editQuery()}`)}">载入最新版本</a></div><span class="help">提交时仍携带你载入时的修订号：再次提交会继续被拒绝，而不是覆盖。</span>`, { tone: "danger" })
    : "";
  const failure = ctx.failure ? result(false, esc(String(ctx.failure))) : "";

  const form = `<form class="ped-form" id="authz-form" method="post" action="${esc(isNew ? `${base}/create` : `${base}/update`)}">
<input type="hidden" name="csrf" value="${esc(csrf || "")}">
${isNew ? "" : `<input type="hidden" name="id" value="${esc(policyId)}">`}
<input type="hidden" name="expectedRevision" value="${esc(revision === null ? "" : String(revision))}">
${conflict}${failure}
${fieldset("基本信息", `<div class="grid2">
<div class="fld"><label for="fld-label">策略名称</label><input class="inp" id="fld-label" name="label" maxlength="120" required placeholder="例如：研究机器人仅工作时间" value="${esc(draft?.label ?? "")}"></div>
<div class="fld"><label>状态</label>${enabledControl(draft)}</div>
</div>
<div class="fld" style="margin-top:12px"><span class="l">窗口外的处理方式</span>${modeControl(draft?.mode === "revoke" ? "revoke" : "suspend")}</div>`)}
${fieldset("主体", `${subjectPills ? `<div class="selrow">${subjectPills}</div>` : `<p class="help" style="margin:0 0 8px">尚未选择主体</p>`}
${draftOrphans.length ? `<p class="help" style="margin:0 0 8px">${ic("alert", "xs")} 含 ${draftOrphans.length} 个已删除的主体：它们不会再匹配任何请求，建议取消勾选（保存本身不会被拒绝）</p>` : ""}
${subjectPicker({ known: subjects, draftSubjects: draft?.subjects, view: (subject) => model.subjectView(subject), query: query.subjq, search: base, hidden: editParam, formId: "authz-subjq" })}`, `策略作用于哪些凭据 · 已选 ${(Array.isArray(draft?.subjects) ? draft.subjects.length : 0)}`)}
${fieldset("限制的能力", `${draft?.mode === "revoke" ? banner(`「撤销」模式只能作用于<b>全部能力</b>，已自动锁定为「全部」，服务端会再次校验。`, { tone: "amber" }) : ""}
${capabilityPicker({ mode: draft?.mode, selected: selectedCaps, groups: capabilities?.groups, query: query.capq, search: base, hidden: editParam, formId: "authz-capq" })}
${capPills ? `<div class="selrow" style="margin-top:8px">${capPills}</div>` : ""}`, "窗口外这些能力不可用")}
${fieldset("允许访问的时间", `<div class="grid2">
<div class="fld"><label for="fld-tz">时区</label><input class="inp" id="fld-tz" name="timezone" list="authz-timezones" value="${esc(draft?.timezone ?? "Asia/Shanghai")}" required><span class="help">下方所有时间都按此时区解释</span></div>
<div></div>
<div class="fld"><label>生效起点 <small>startsAt</small></label><input class="inp" type="datetime-local" name="startsAt" value="${esc(localInputValue(draft?.startsAt, draft?.timezone))}"><span class="help">${draft?.startsAt ? `存储为 ${utcEcho(draft.startsAt)}` : "未设置 · 立即生效"}</span></div>
<div class="fld"><label>失效终点 <small>expiresAt</small></label><input class="inp" type="datetime-local" name="expiresAt" value="${esc(localInputValue(draft?.expiresAt, draft?.timezone))}"><span class="help">${draft?.expiresAt ? `存储为 ${utcEcho(draft.expiresAt)}` : "未设置 · 长期有效"}</span></div>
</div>
<div class="fld" style="margin-top:20px"><span class="l">每周窗口 <span class="muted">留空 = 每天全天</span></span>${weeklyGrid(draft, { base, editQuery })}</div>
<div class="fld" style="margin-top:20px"><span class="l">限定日期 <span class="muted">留空 = 不限日期</span></span>${rangeGrid(draft, { base, editQuery })}</div>`)}
</form>`;

  const foot = `<div class="ped-foot"><button class="btn primary" type="submit" form="authz-form">${isNew ? "创建策略" : "保存策略"}</button><a class="btn ghost" href="${esc(base)}">取消</a><span class="grow"></span>${isNew ? "" : `<a class="btn danger-o" href="${esc(`${base}?confirm=delete&id=${encodeURIComponent(policyId)}`)}">${ic("trash")}<span class="hide-m">删除策略</span></a>`}<span class="help hide-m" style="margin-left:8px"><kbd>⌘</kbd> <kbd>↵</kbd> 保存</span></div>`;

  // The prototype's editor has NO filter toolbar: the two filters live in their own panels —
  // `<label class="search">` as the first child of the 主体 `.picker` and of the 能力 `.picker`
  // (`5-render.js` renderPolicyEditor). A separate toolbar above the form was extra UI the user
  // could see; the filters are rendered by `subjectPicker`/`capabilityPicker` instead.
  const content = `${pageBar({
    crumb: { href: base, label: "定时授权" },
    title: isNew ? (query.copy ? "复制为新策略" : "新建策略") : String(draft?.label || "未命名策略"),
    actions: isNew ? "" : `<span class="hide-m">${idc(policyId)}</span>`,
  })}<div class="content scroll">
<div class="ped">${form}${previewPane(ctx)}</div>
${searchForm({ id: "authz-capq", action: base, hidden: editParam })}${searchForm({ id: "authz-subjq", action: base, hidden: editParam })}
${foot}
</div>
<datalist id="authz-timezones">${COMMON_TIMEZONES.map((zone) => `<option value="${esc(zone)}"></option>`).join("")}</datalist>
<datalist id="authz-times">${TIME_OPTIONS.map((time) => `<option value="${time}"></option>`).join("")}</datalist>`;
  return { content, detailPanel: "" };
}
