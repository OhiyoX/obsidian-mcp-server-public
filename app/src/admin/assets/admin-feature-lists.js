// Feature module: instant list filtering and in-place status/segment switching.
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
// The legacy policy editor is frozen (design §7 step 2 + step 5), so its two client behaviours are
// gone with it: the 生效预览 pane no longer follows a (non-existent) form, and `⌘/Ctrl+Enter` saves
// nothing. No surface renders `#authz-form` or `[data-preview-form]`; do not re-add a handler for
// either without a page that renders it.
//
// Hard rules this file keeps (D0 contract in `docs/admin/AGENTS`/`docs/admin/README.md`):
//   1. the SSR markup stays the source of truth: nothing here builds a page, rewrites a row or
//      trusts a value that came from data (every value is written with `textContent` / an attribute,
//      never with `innerHTML`);
//   2. every intercepted action already works without script — the segments are `<a href>`, the sort
//      control is a GET form with a submit button, the search box is a GET form. `preventDefault()`
//      happens only after the replacement is possible, and any fetch/parse failure falls back to the
//      original navigation;
//   3. filtering is a pure view operation: it never writes a form value, never drops a chosen option
//      and never removes a node it cannot restore — clearing the box restores the list exactly;
//   4. no inline handler, no `eval`, no third-party origin (CSP keeps `script-src 'self'`).
import { registerFeature } from "./admin-client.js";

/* ------------------------------------------------------------------ vocabulary */

/** The prototype's filtered empty states (5-render.js L203/223/245/342; same strings as the SSR). */
const FILTERED_EMPTY = Object.freeze({
  accounts: { icon: "user", title: "没有匹配的账户", desc: "换个关键词试试" },
  keys: { icon: "key", title: "没有匹配的 Key", desc: "换个关键词试试" },
  clients: { icon: "app", title: "没有匹配的客户端", desc: "换个关键词试试" },
  audit: { icon: "filter", title: "没有匹配的审计记录", desc: "调整或重置筛选条件" },
  accessPolicy: { icon: "cal", title: "没有匹配的策略", desc: "换个关键词试试" },
  default: { icon: "filter", title: "没有匹配的结果", desc: "换个关键词试试" },
});

const SEARCH_INPUT = 'form.search input[name="q"], form.toolbar input[name="q"]';

/* ------------------------------------------------------------------ small DOM helpers */

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

/* ------------------------------------------------------------------ registration */

registerFeature("lists", (ctx) => {
  const filter = createFilter(ctx);
  createNavigation(ctx, { applyFilter: filter.apply });
});
