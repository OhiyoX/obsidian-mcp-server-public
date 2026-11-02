// Feature module: instant list filtering, in-place status/segment switching, live policy preview.
//
// Owned by lane L3. Behaviour to match `docs/admin-ui-proto/src/6-app.js` (interaction) and
// `5-render.js` (markup):
//   * a search box filters the current list as you type — prototype `S.q` +
//     `document.addEventListener("input")` → `rerenderKeepFocus` (6-app.js) over the rows built by
//     `renderAccounts`/`renderKeys`/`renderClients`/`renderAudit` (5-render.js L203/223/245/342),
//     including the prototype's filtered empty state (`没有匹配的…` + `换个关键词试试`);
//   * the status segments and the sort control switch without a full page load — prototype
//     `data-tokf` (6-app.js `S.tokenFilter`) / `data-act="tok-order"` (`S.tokenOrder`) / `data-auf`
//     (`S.audit.outcome`) / `data-act="pagesize"`, all of which re-render the list in place (here:
//     fetch the same URL the SSR link/form already points at, swap `.content`, keep scroll+focus,
//     `pushState`);
//   * the policy editor's right-hand 生效预览 (`.ped-side`) follows the form: the summary and the
//     7-day timeline are derived in the browser the same way the prototype derives them
//     (`windowSummary()` / `timeline()`, 5-render.js L80–116), while the *verdict*
//     (「现在（…）允许/拒绝」 and 「对主体的影响」) is always the server's answer: the pane is
//     re-adopted from the SSR fragment endpoint (routes/access-policy.js `GET {base}/preview`).
//     A verdict is never computed, guessed or cached in this file;
//   * `⌘/Ctrl+Enter` submits the editor (prototype keydown handler → `savePolicy()`); the shell's key
//     router dispatches it here.
//
// Hard rules this file keeps (D0 contract in `docs/admin/AGENTS`/`docs/admin/README.md`):
//   1. the SSR markup stays the source of truth: nothing here builds a page, rewrites a row or
//      trusts a value that came from data (every value is written with `textContent` / an attribute,
//      never with `innerHTML`);
//   2. every intercepted action already works without script — the segments are `<a href>`, the sort
//      control is a GET form with a submit button, the search box is a GET form, the save button is
//      a real `<button form="authz-form">`. `preventDefault()` happens only after the replacement is
//      possible, and any fetch/parse failure falls back to the original navigation;
//   3. filtering is a pure view operation: it never writes a form value, never drops a chosen option
//      and never removes a node it cannot restore — clearing the box restores the list exactly;
//   4. no inline handler, no `eval`, no third-party origin (CSP keeps `script-src 'self'`).
import { registerFeature } from "./admin-client.js";

/* ------------------------------------------------------------------ vocabulary */

/** Prototype `windowSummary()` / `timeline()` day order and labels (weeks start Monday). */
const DAY_KEYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const DAY_LABELS = Object.freeze({ mon: "周一", tue: "周二", wed: "周三", thu: "周四", fri: "周五", sat: "周六", sun: "周日" });
/** `presentation/vocab.js` `MODE[].n` — the two words the preview's 窗口外 line needs. */
const MODE_WORDS = Object.freeze({ suspend: "暂停", revoke: "撤销" });
/** `access-policy-window-presentation.js` `MARKER_LABELS` (same three markers, same order). */
const MARKER_ORDER = Object.freeze(["dateRanges", "startsAt", "expiresAt"]);
const MARKER_LABELS = Object.freeze({ dateRanges: "另有限定日期", startsAt: "另有开始时间", expiresAt: "另有截止时间" });
/** `access-policy-window-presentation.js` budget: at most 2 merged groups / 48 code points. */
const SUMMARY_MAX_GROUPS = 2;
const SUMMARY_MAX_CODE_POINTS = 48;
const UNPARSABLE_TEXT = "无法解析时间窗口";
const NO_WEEKLY_TEXT = "每天全天";
const FULL_DAY = Object.freeze({ from: "00:00", to: "24:00" });

/** The prototype's filtered empty states (5-render.js L203/223/245/342; same strings as the SSR). */
const FILTERED_EMPTY = Object.freeze({
  accounts: { icon: "user", title: "没有匹配的账户", desc: "换个关键词试试" },
  keys: { icon: "key", title: "没有匹配的 Key", desc: "换个关键词试试" },
  clients: { icon: "app", title: "没有匹配的客户端", desc: "换个关键词试试" },
  audit: { icon: "filter", title: "没有匹配的审计记录", desc: "调整或重置筛选条件" },
  accessPolicy: { icon: "cal", title: "没有匹配的策略", desc: "换个关键词试试" },
  default: { icon: "filter", title: "没有匹配的结果", desc: "换个关键词试试" },
});

const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END_TIME = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_INPUT = 'form.search input[name="q"], form.toolbar input[name="q"]';

/** Prototype `toast(ms: 3200)`-era debounce for the preview round trip (no SSR equivalent). */
const PREVIEW_DEBOUNCE_MS = 350;
/** Where the editor's `.ped-side` is re-adopted from (`routes/access-policy.js`, additive GET). */
const PREVIEW_ENDPOINT = "/admin/auth/access-policy/preview";

/* ------------------------------------------------------------------ small DOM helpers */

/** Assign text only when it actually changes — an identical assignment still dirties the node. */
function setText(node, value) {
  if (!node) return;
  const next = String(value ?? "");
  if (node.textContent !== next) node.textContent = next;
}

/** `display` values we wrote ourselves, so `show()` only ever removes what `hide()` added. */
const HIDDEN_BY_US = new WeakMap();

function hide(element) {
  if (!element || HIDDEN_BY_US.has(element)) return;
  HIDDEN_BY_US.set(element, element.style.display || "");
  element.style.display = "none";
}

function show(element) {
  if (!element || !HIDDEN_BY_US.has(element)) return;
  const previous = HIDDEN_BY_US.get(element);
  HIDDEN_BY_US.delete(element);
  if (previous) element.style.display = previous;
  else element.style.removeProperty("display");
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ 1. instant filtering */

/**
 * Prototype `data-search` behaviour: filter the rows/cards already on screen as the operator types.
 *
 * Only visibility changes. The rows, their order, their links and every form value stay exactly as
 * the server rendered them, so clearing the box restores the list byte-for-byte (rule 3 above); the
 * server-side `?q=` filter keeps working when the script is absent or fails.
 */
function createFilter(ctx) {
  const emptyStates = new WeakMap();

  const rowText = (row) => [
    [...row.querySelectorAll("td:not(.act)")].map((cell) => cell.textContent).join(" "),
    // The audit row's expandable detail panel is the only place the recorded UA/reason/detail is
    // rendered, and the server's own `?q=` filter searches those fields (`searchText` in audit.js).
    row.querySelector("td.act .uax")?.textContent ?? "",
  ].join(" ").toLowerCase();

  const showEmptyState = (tw, table, labels) => {
    let node = emptyStates.get(tw);
    if (!node) {
      node = document.createElement("div");
      node.className = "empty";
      const holder = document.createElement("div");
      holder.className = "ic";
      holder.append(icon(labels.icon));
      node.append(holder, textNode("b", "", labels.title), textNode("span", "", labels.desc));
      tw.append(node);
      emptyStates.set(tw, node);
    }
    hide(table);
    show(node);
  };

  const hideEmptyState = (tw, table) => {
    const node = emptyStates.get(tw);
    if (node) hide(node);
    show(table);
  };

  const apply = (input) => {
    const main = document.querySelector(".main");
    if (!main || !input) return;
    const needle = String(input.value ?? "").trim().toLowerCase();

    const rows = [...main.querySelectorAll(".tbl tbody tr")];
    let visible = 0;
    let previous = true;
    for (const row of rows) {
      // A *separate* detail row (the prototype's expanded `<tr>`: one full-width cell holding the
      // panel) follows the row it belongs to and is never matched on its own text. The SSR renders
      // the same panel nested inside the row's action cell, so a row that keeps its own cells is
      // always matched normally.
      if (row.cells.length === 1 && row.cells[0].querySelector(".uax")) {
        if (previous) show(row);
        else hide(row);
        continue;
      }
      const match = !needle || rowText(row).includes(needle);
      if (match) show(row);
      else hide(row);
      previous = match;
      if (match) visible += 1;
    }

    const cards = [...main.querySelectorAll(".mcards .mc")];
    let visibleCards = 0;
    for (const card of cards) {
      const match = !needle || String(card.querySelector(".b")?.textContent ?? card.textContent).toLowerCase().includes(needle);
      if (match) show(card);
      else hide(card);
      if (match) visibleCards += 1;
    }

    const tw = main.querySelector(".tw");
    const table = tw?.querySelector(".tbl") ?? null;
    if (table && rows.length) {
      const tab = document.querySelector(".app")?.dataset.tab ?? "";
      const labels = FILTERED_EMPTY[tab === "access-policy" ? "accessPolicy" : tab] ?? FILTERED_EMPTY.default;
      if (needle && visible === 0) showEmptyState(tw, table, labels);
      else hideEmptyState(tw, table);
    }
    const cardList = main.querySelector(".mcards");
    // The prototype renders no `.mcards` container when the list is empty (`mcards([])`), so an
    // all-filtered-out card list must not keep an empty box on screen.
    if (cardList) {
      if (!needle || visibleCards > 0) show(cardList);
      else hide(cardList);
    }
  };

  ctx.on("input", SEARCH_INPUT, (event, input) => apply(input));
  return { apply, input: () => document.querySelector(`.main ${SEARCH_INPUT}`) };
}

/* ------------------------------------------------------------------ 2. segments / sort */

/**
 * In-place list switching: the SSR link/form URL is fetched same-origin, only `.content` is
 * replaced, scroll/focus survive and the URL is pushed so Back/refresh stay correct.
 *
 * The click/change is only intercepted after we know we can do better; every failure path calls
 * `location.assign(url)` — the plain navigation the markup already offers.
 */
function createNavigation(ctx, { applyFilter }) {
  const currentContent = () => document.querySelector(".main .content");

  /** Search values the operator typed (prototype keeps `S.q` across a segment switch). */
  const carriedSearches = (content) => [...content.querySelectorAll(SEARCH_INPUT)].map((input) => input.value).filter(Boolean);

  const restoreSearches = (content, values) => {
    if (!values.length) return;
    const inputs = [...content.querySelectorAll(SEARCH_INPUT)];
    values.forEach((value, index) => {
      if (inputs[index] && !inputs[index].value) inputs[index].value = value;
    });
  };

  const navigate = async (url, focusTarget) => {
    const content = currentContent();
    if (!content) {
      location.assign(url);
      return;
    }
    const scrollTop = content.scrollTop;
    const searches = carriedSearches(content);
    let fragment;
    try {
      fragment = await ctx.fetchFragment(url);
    } catch {
      location.assign(url);
      return;
    }
    const next = fragment.querySelector(".main .content");
    if (!next) {
      // Not the page we expected (session expired, error page): let the browser do the real thing.
      location.assign(url);
      return;
    }
    content.replaceWith(next);
    next.scrollTop = scrollTop;
    restoreSearches(next, searches);
    const input = next.querySelector(SEARCH_INPUT);
    if (input && input.value) applyFilter(input);
    // Focus goes back to the same control the operator used (compared by attribute value: the URL
    // carries `?`, `&` and `=`, which a CSS attribute selector would have to escape).
    if (focusTarget) {
      const match = [...next.querySelectorAll(focusTarget.selector)]
        .find((element) => element.getAttribute(focusTarget.attribute) === focusTarget.value);
      match?.focus();
    }
    ctx.push(url);
  };

  ctx.on("click", ".seg a[href]", (event, link) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = link.getAttribute("href") ?? "";
    if (!href.startsWith("/")) return;
    event.preventDefault();
    void navigate(href, { selector: ".seg a", attribute: "href", value: href });
  });

  // Sort / filter `<select>`s of a GET toolbar (prototype `data-act="tok-order"`, `data-af`,
  // `data-act="pagesize"`: changing the control re-renders the list immediately). The submit button
  // the SSR renders next to them stays the no-script path.
  ctx.on("change", 'form[method="get"] select', (event, select) => {
    const form = select.form;
    if (!form || !form.closest(".main")) return;
    if (String(form.getAttribute("method") ?? "").toLowerCase() !== "get") return;
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      const item = String(value ?? "");
      if (item) params.append(key, item);
    }
    const action = form.getAttribute("action") ?? location.pathname;
    const url = `${action}?${params.toString()}`;
    if (url === `${location.pathname}${location.search}`) return;
    event.preventDefault();
    void navigate(url, { selector: "select", attribute: "name", value: String(select.name) });
  });
}

/* ------------------------------------------------------------------ 3. live policy preview */

/** Sort + de-duplicate intervals exactly like the server's display model (`sortAndDedupeIntervals`). */
function normalizeIntervals(pairs) {
  const seen = new Set();
  return [...pairs]
    .sort((left, right) => (left.from === right.from ? (left.to < right.to ? -1 : left.to > right.to ? 1 : 0) : left.from < right.from ? -1 : 1))
    .filter((pair) => {
      const key = `${pair.from}-${pair.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const isAllDay = (intervals) => intervals.length === 1 && intervals[0].from === FULL_DAY.from && intervals[0].to === FULL_DAY.to;
// Wave Q: the same vocabulary as `access-policy-window-presentation.js` (and the prototype's own
// `windowSummary`): literal ranges (all-day included), 「工作日」, groups joined with 「；」,
// 「每天全天」 when nothing is set. The client must not re-render a different dialect than the server.
const intervalText = (intervals) => intervals.map((pair) => `${pair.from}–${pair.to}`).join("、");

/** `daySetLabel()` — 每天 / 工作日 / 周末 / explicit list (prototype vocabulary). */
function daySetLabel(days) {
  const set = new Set(days);
  if (days.length === 7) return "每天";
  if (days.length === 5 && ["mon", "tue", "wed", "thu", "fri"].every((day) => set.has(day))) return "工作日";
  if (days.length === 2 && set.has("sat") && set.has("sun")) return "周末";
  return days.map((day) => DAY_LABELS[day]).join("、");
}

/**
 * Browser-side mirror of `presentAccessPolicyWindow()`'s summary rules for the *unsaved* form
 * values: the same day merging, the same 2-group/48-code-point budget and the same explicit
 * "unparsable" answer (never a guessed 全天). The verdict is not computed here.
 */
function summarize(draft) {
  const days = new Map(DAY_KEYS.map((day) => [day, []]));
  const brokenDays = new Set();
  for (const day of DAY_KEYS) {
    const valid = [];
    for (const pair of draft.weekly[day] ?? []) {
      if (!START_TIME.test(pair.from) || !END_TIME.test(pair.to) || pair.from >= pair.to) brokenDays.add(day);
      else valid.push(pair);
    }
    days.set(day, normalizeIntervals(valid));
  }
  const hasWeeklyConstraint = DAY_KEYS.some((day) => days.get(day).length > 0);
  const byExpression = new Map();
  for (const day of DAY_KEYS) {
    const intervals = days.get(day);
    if (!intervals.length) continue;
    const signature = intervals.map((pair) => `${pair.from}-${pair.to}`).join(",");
    if (!byExpression.has(signature)) byExpression.set(signature, { signature, dayKeys: [], intervals });
    byExpression.get(signature).dayKeys.push(day);
  }
  const groups = [...byExpression.values()].map((group) => ({
    dayKeys: group.dayKeys,
    dayLabel: daySetLabel(group.dayKeys),
    intervals: group.intervals,
    text: `${daySetLabel(group.dayKeys)} ${intervalText(group.intervals)}`,
  }));
  const markers = MARKER_ORDER.filter((key) => {
    if (key === "dateRanges") return draft.dateRanges.length > 0;
    return Boolean(draft[key]);
  }).map((key) => MARKER_LABELS[key]);
  const shape = { days, brokenDays, hasWeeklyConstraint, groups, markers, weeklyOk: draft.weeklyOk, windowOk: draft.windowOk };
  if (!draft.windowOk) return { ...shape, text: UNPARSABLE_TEXT };
  if (!groups.length) return { ...shape, text: NO_WEEKLY_TEXT };
  const joined = groups.map((group) => group.text).join("；");
  if (groups.length > SUMMARY_MAX_GROUPS || [...joined].length > SUMMARY_MAX_CODE_POINTS) {
    return { ...shape, text: `自定义 · ${groups.length} 个时段` };
  }
  return { ...shape, text: joined };
}

/** The draft's wall clock in the policy timezone, as the day key + minute-of-day the timeline needs. */
function localClock(timezone, now = new Date()) {
  try {
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]));
    const hour = Number(parts.hour) % 24;
    const minutes = hour * 60 + Number(parts.minute);
    const utcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    return { dayKey: DAY_KEYS[(new Date(utcMidnight).getUTCDay() + 6) % 7], minutes, percent: (minutes / 1440) * 100 };
  } catch {
    return null;
  }
}

const toPercent = (value) => {
  const [hour, minute] = String(value).split(":").map(Number);
  return ((hour * 60 + minute) / 1440) * 100;
};

/** Prototype `timeline()` / server `policyTimelineHtml()`: 7 rows, window bars, today + now marks. */
function timelineNode(window, timezone) {
  const clock = localClock(timezone);
  const root = document.createElement("div");
  root.className = "tl";
  for (const day of DAY_KEYS) {
    const today = clock?.dayKey === day;
    const label = document.createElement("span");
    if (today) label.className = "today";
    label.textContent = DAY_LABELS[day].slice(1);
    const track = document.createElement("div");
    track.className = "tr";
    let bars = [];
    const intervals = window.days.get(day) ?? [];
    if (intervals.length) bars = isAllDay(intervals) ? [FULL_DAY] : intervals;
    else if (!window.hasWeeklyConstraint && window.weeklyOk) bars = [FULL_DAY];
    for (const bar of bars) {
      if (toPercent(bar.to) <= toPercent(bar.from)) continue;
      const node = document.createElement("div");
      node.className = "w";
      node.style.left = `${toPercent(bar.from)}%`;
      node.style.width = `${toPercent(bar.to) - toPercent(bar.from)}%`;
      node.title = `${bar.from}–${bar.to}`;
      track.append(node);
    }
    if (today && clock) {
      const marker = document.createElement("div");
      marker.className = "now";
      marker.style.left = `${clock.percent}%`;
      marker.title = "现在";
      track.append(marker);
    }
    root.append(label, track);
  }
  root.append(document.createElement("span"));
  const axis = document.createElement("div");
  axis.className = "ax";
  for (const tick of ["0", "6", "12", "18", "24"]) axis.append(textNode("span", "", tick));
  root.append(axis);
  return root;
}

/** The draft as the form really is right now — only the fields the preview lawfully derives from. */
function readDraft(form) {
  const weekly = {};
  const ranges = new Map();
  const draft = { label: "", mode: "suspend", timezone: "", startsAt: "", expiresAt: "" };
  for (const day of DAY_KEYS) weekly[day] = [];
  for (const field of form.querySelectorAll("input[name], select[name]")) {
    const name = field.name;
    if (name === "label" || name === "timezone" || name === "startsAt" || name === "expiresAt") {
      draft[name] = String(field.value ?? "");
      continue;
    }
    if (name === "mode") {
      if (field.checked) draft.mode = String(field.value || "suspend");
      continue;
    }
    const slot = /^w_(mon|tue|wed|thu|fri|sat|sun)_(from|to)_(\d+)$/.exec(name);
    if (slot) {
      const index = Number(slot[3]);
      weekly[slot[1]][index] = { ...(weekly[slot[1]][index] ?? { from: "", to: "" }), [slot[2]]: String(field.value ?? "").trim() };
      continue;
    }
    const range = /^range_(from|to)_(\d+)$/.exec(name);
    if (range) {
      const index = Number(range[2]);
      ranges.set(index, { ...(ranges.get(index) ?? { from: "", to: "" }), [range[1]]: String(field.value ?? "").trim() });
    }
  }
  for (const day of DAY_KEYS) weekly[day] = (weekly[day] ?? []).filter(Boolean).filter((pair) => pair.from || pair.to);
  draft.weekly = weekly;
  draft.dateRanges = [...ranges.keys()].sort((left, right) => left - right).map((index) => ranges.get(index)).filter((pair) => pair.from || pair.to);
  draft.weeklyOk = true;
  for (const day of DAY_KEYS) {
    for (const pair of weekly[day]) {
      if (!START_TIME.test(pair.from) || !END_TIME.test(pair.to) || pair.from >= pair.to) draft.weeklyOk = false;
    }
  }
  const rangesOk = draft.dateRanges.every((pair) => CALENDAR_DATE.test(pair.from) && CALENDAR_DATE.test(pair.to) && pair.from <= pair.to);
  const instantsOk = [draft.startsAt, draft.expiresAt].every((value) => !value || Number.isFinite(Date.parse(value)));
  draft.windowOk = draft.weeklyOk && rangesOk && instantsOk;
  return draft;
}

/** The capability names the checked boxes carry in the page's own server-rendered labels. */
function capabilityNames(form) {
  const names = [];
  const seen = new Set();
  for (const field of form.querySelectorAll('input[name="capabilities"]')) {
    if (field.type === "hidden" || !field.checked) continue;
    const label = field.closest("label");
    const first = label?.querySelector("span")?.firstChild;
    const text = typeof first?.nodeValue === "string" ? first.nodeValue.trim() : "";
    const name = text || String(field.value ?? "");
    if (!name || seen.has(field.value)) continue;
    seen.add(field.value);
    names.push(name);
  }
  return names.join("、");
}

/** The `.sumbox` marker row (the SSR renders it as a `<div>` of `.tag` spans). */
function marksSlot(sum) {
  const existing = sum.querySelector("[data-admin-preview-marks]");
  if (existing) return existing;
  const strong = sum.querySelector("b");
  const server = [...sum.children].find((element) => element !== strong
    && element.tagName === "DIV"
    && element.children.length > 0
    && [...element.children].every((child) => child.classList.contains("tag")));
  const slot = document.createElement("div");
  slot.dataset.adminPreviewMarks = "";
  if (server) server.replaceWith(slot);
  else strong?.after(slot);
  return slot;
}

/** `窗口外：<b>暂停</b> 读取、写入` — the line whose tail lists the restricted capabilities. */
function offlineLine(sum) {
  return [...sum.children].find((element) => element.tagName === "DIV" && element.textContent.startsWith("窗口外：")) ?? null;
}

function setTail(line, text) {
  const tail = line.lastChild;
  if (tail && tail.nodeType === Node.TEXT_NODE) tail.nodeValue = ` ${text}`;
  else line.append(document.createTextNode(` ${text}`));
}

/** The pane note that keeps the locally derived half honest while the server answer is in flight. */
function note(pane, text, warn = false) {
  let node = pane.querySelector("[data-admin-preview-note]");
  if (!node) {
    node = textNode("p", `help${warn ? " warn" : ""}`, text);
    node.dataset.adminPreviewNote = "";
    node.style.margin = "8px 0 0";
    pane.querySelector(".stick > .sect-h")?.after(node);
  }
  node.className = `help${warn ? " warn" : ""}`;
  node.textContent = text;
}

/** The server-derived halves of the preview pane: a change here needs a repaint, nothing else does. */
function serverDerivedText(pane) {
  if (!pane) return null;
  const verdict = pane.querySelector(".verdict");
  const impact = pane.querySelector(".sect-h + *")?.parentElement?.querySelectorAll(".sect-h");
  void impact;
  const parts = [verdict ? verdict.textContent.trim() : ""];
  const headings = [...pane.querySelectorAll(".sect-h h2")].map((h) => h.textContent.trim());
  // 「对主体的影响」 is the block after its own heading; compare its rendered text, not its markup, so
  // attribute-only differences (ids, aria wiring) do not count as a change.
  const impactHeading = [...pane.querySelectorAll(".sect-h h2")].find((h) => h.textContent.includes("对主体的影响"));
  if (impactHeading) {
    const block = impactHeading.closest(".sect-h")?.nextElementSibling;
    parts.push(block ? block.textContent.trim() : "");
  }
  parts.push(headings.join("|"));
  return parts.join("\u0000");
}

/** True when the incoming server render shows exactly what is already on screen. */
function sameServerText(current, next) {
  return serverDerivedText(current) === serverDerivedText(next);
}

const PENDING_TEXT = "摘要与时间线已按当前表单更新；现在判定与主体影响由服务端给出，正在请求…";
const STALE_TEXT = "服务端判定暂不可用：下面显示的「现在判定 / 对主体的影响」是上一次的服务端结果。";

/**
 * The editor's live preview. Summary + timeline follow the form locally; the verdict half is
 * adopted from the SSR fragment endpoint, and a pending/stale note says which half is which.
 */
function createEditorPreview(ctx) {
  const form = document.getElementById("authz-form");
  const pane = document.querySelector(".main aside.ped-side");
  if (!form || !pane) return;

  let version = 0;
  const previewUrl = () => {
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      // The CSRF token never travels in a URL (`csrf`), and the revision/id are not draft fields.
      if (key === "csrf" || key === "expectedRevision" || key === "id") continue;
      params.append(key, String(value));
    }
    params.set("preview", "1");
    const id = form.querySelector('input[name="id"]')?.value ?? "";
    if (id) params.set("edit", id);
    else params.set("new", "1");
    return `${PREVIEW_ENDPOINT}?${params.toString()}`;
  };

  const renderLocal = () => {
    const target = document.querySelector(".main aside.ped-side");
    if (!target) return;
    const draft = readDraft(form);
    const window = summarize(draft);
    const sum = target.querySelector(".sumbox");
    const strong = sum?.querySelector("b");
    // Write only real changes. Assigning identical text still mutates the DOM, and rebuilding the
    // marker chips on every keystroke made them blink while the operator typed a policy name
    // (owner report 2026-10-21: 「文字反复出现消失」).
    setText(strong, window.text);
    if (sum) {
      const slot = marksSlot(sum);
      const shown = [...slot.querySelectorAll(".tag")].map((node) => node.textContent);
      if (shown.join("\u0000") !== window.markers.join("\u0000")) {
        slot.textContent = "";
        for (const marker of window.markers) slot.append(textNode("span", "tag", marker));
      }
      if (window.markers.length) slot.style.marginTop = "0";
      const line = offlineLine(sum);
      const word = line?.querySelector("b");
      setText(word, MODE_WORDS[draft.mode] ?? draft.mode);
      if (line) setTail(line, capabilityNames(form) || "（未选择能力）");
    }
    const timeline = target.querySelector(".tl");
    if (timeline) timeline.replaceWith(timelineNode(window, draft.timezone));
  };

  const adopt = async () => {
    const started = version;
    let fragment;
    try {
      fragment = await ctx.fetchFragment(previewUrl());
    } catch {
      note(document.querySelector(".main aside.ped-side") ?? pane, STALE_TEXT, true);
      return;
    }
    const next = fragment.querySelector("aside.ped-side");
    const target = document.querySelector(".main aside.ped-side");
    // A newer keystroke already scheduled its own answer: never let an older server render win.
    if (!next || !target || started !== version) return;
    // With the script running the pane *does* follow unsaved input, so the no-script hint goes away.
    for (const hint of next.querySelectorAll("p.help")) {
      if (hint.textContent.includes("不会更新本栏")) hint.remove();
    }
    // Typing a name does not change the verdict: swapping the whole aside for an identical render is
    // what made the text flash on every keystroke (the operator reported it on 2026-10-21). Compare the
    // server-derived parts and leave the DOM alone when nothing they show has changed.
    if (sameServerText(target, next)) return;
    target.replaceWith(next);
  };

  const schedule = ctx.debounce(() => { void adopt(); }, PREVIEW_DEBOUNCE_MS);
  const onEdit = () => {
    version += 1;
    renderLocal();
    // No placeholder on every keystroke. Writing 「正在请求…」 over the verdict and then replacing the
    // pane made the text visibly flash while the operator typed a policy name; the previous answer
    // simply stays on screen until the new one is ready (STALE_TEXT still marks a failed round trip).
    schedule();
  };

  form.addEventListener("input", onEdit);
  form.addEventListener("change", onEdit);

  // Prototype keydown: `(metaKey || ctrlKey) && Enter` in the editor → `savePolicy()`.
  ctx.registerShortcut("mod+enter", () => {
    const submitter = document.querySelector('button[type="submit"][form="authz-form"]');
    if (submitter) form.requestSubmit(submitter);
    else form.requestSubmit();
  });
}

/* ------------------------------------------------------------------ 3b. list-page preview card (Q11) */

/**
 * The 定时授权 list page's 「当前状态预览」 card.
 *
 * The prototype re-renders the verdict in place when the subject select changes
 * (`data-act=preview-subject`). The plane's SSR spelling of that control is a real POST form (so a
 * scriptless operator can submit it with the 查看 button), therefore with the script running the
 * change has to answer IN PLACE or the operator gets a page reload the prototype never had. The
 * answer is the server's own: the same `POST {base}/preview` the form posts is fetched as a fragment
 * and its `#preview .card` adopted, with the local form (and the operator's focus) left alone. If the
 * fetch fails the real submit runs, because the page must never depend on the script.
 */
function createPreviewCard(ctx) {
  const form = document.querySelector("[data-preview-form]");
  const select = form?.querySelector("select[name=subject]");
  const card = form?.closest(".card");
  if (!form || !select || !card) return;
  let version = 0;

  const adopt = async () => {
    const started = version;
    let document_;
    try {
      // `application/x-www-form-urlencoded`, not multipart: the Admin router reads `req.body.csrf`
      // (express.urlencoded), so a `FormData` body would be rejected as a CSRF failure.
      const body = new URLSearchParams();
      for (const [key, value] of new FormData(form)) body.append(key, String(value));
      const response = await fetch(form.action, {
        method: (form.getAttribute("method") || "post").toUpperCase(),
        body,
        credentials: "same-origin",
        redirect: "follow",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-admin-fragment": "1" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      document_ = new DOMParser().parseFromString(await response.text(), "text/html");
    } catch {
      // Fall back to the markup's own submit: the hidden 查看 button is the no-JS path, and
      // `requestSubmit()` works whether or not the button is visible.
      form.requestSubmit();
      return;
    }
    if (started !== version) return; // a newer pick already asked its own question
    const next = document_.querySelector("#preview .card");
    const current = document.querySelector("#preview .card");
    if (!next || !current) return;
    const localForm = current.querySelector("[data-preview-form]");
    for (const child of [...current.children]) if (child !== localForm) child.remove();
    for (const child of [...next.children]) {
      if (child.hasAttribute && child.hasAttribute("data-preview-form")) continue;
      current.append(child);
    }
  };

  select.addEventListener("change", (event) => {
    // This is the intercepted path: the generic `data-autosubmit` listener must not also fire and
    // navigate the page the operator is typing in.
    event.stopPropagation();
    version += 1;
    void adopt();
  });
}

/* ------------------------------------------------------------------ registration */

registerFeature("lists", (ctx) => {
  const filter = createFilter(ctx);
  createNavigation(ctx, { applyFilter: filter.apply });
  createEditorPreview(ctx);
  createPreviewCard(ctx);
});
