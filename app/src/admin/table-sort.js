// Column sorting for the Admin list tables — owner request 2026-10-31: 「点击列头排序」 on every table.
//
// Sorting is **server state**, not script state. The header renders a real GET link carrying
// `?sort=<key>&order=asc|desc`, so:
//   * it works with scripting disabled (D0: the page never needs the module to be usable);
//   * the result is shareable, bookmarkable and survives a reload;
//   * the page that renders the rows is the page that decided their order — the enhancement module
//     only adds column *widths*, it never reorders a row.
//
// The contract a header link keeps: clicking the column that is already sorted flips the direction,
// clicking a different column starts at `asc` (the least surprising behaviour for text, and the
// natural one for dates: oldest → newest). Paging is dropped when the order changes, because "page 3
// of a different order" is not a place the operator asked to be.
/** Query keys a sort link must never carry forward (they would fight the new order). */
const DROP = Object.freeze(["sort", "order", "page"]);

/**
 * Read `{key, order}` out of a request's query. `keys` is the closed set the page can really sort by:
 * anything else falls back to `fallback` (or the first key), so a hand-edited URL can never reach a
 * comparator that does not exist.
 */
export function readSort(query = {}, keys, fallback = keys[0]) {
  const asked = typeof query.sort === "string" ? query.sort : "";
  const key = keys.includes(asked) ? asked : fallback;
  const order = String(query.order ?? "").toLowerCase() === "desc" ? "desc" : "asc";
  return { key, order };
}

/**
 * The next state for a header click: flip the direction on the sorted column, start `asc` elsewhere.
 */
export function nextSort(current, key) {
  if (current && current.key === key) return { key, order: current.order === "asc" ? "desc" : "asc" };
  return { key, order: "asc" };
}

/**
 * Build the header link for one column. `base` is the page's own list URL **including its current
 * filters** (each page already owns such a helper, e.g. `tabHref({ q })`), so sorting never silently
 * drops a search or a filter.
 */
export function sortHref(base, key, order) {
  const url = new URL(base, "http://admin.invalid");
  for (const name of DROP) url.searchParams.delete(name);
  url.searchParams.set("sort", key);
  url.searchParams.set("order", order);
  const query = url.searchParams.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/**
 * The four-value column tuple `table()` accepts: `[labelHtml, width, className, sortKey]`.
 * Returns the sort key or null. Exported so a page can add the key to one column without repeating
 * the shape (the tuple is positional; this keeps the intent readable).
 */
export function sortable(column, key) {
  const next = [...column];
  while (next.length < 3) next.push("");
  next[3] = key;
  return next;
}

/** `-1 / 0 / 1` for a cell, with nulls and unparsable values last in either direction. */
export function compareCell(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

function normalize(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = String(value);
  // ISO instants and `YYYY-MM-DD` both sort correctly as text, but a mixed column (date vs epoch)
  // must compare as time, so a timestamp is reduced to its epoch when it parses as one.
  const time = Date.parse(text);
  if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(text) && Number.isFinite(time)) return time;
  return text;
}

/**
 * Sort a copy of `rows` by `key`. `get[key]` is the page's own accessor (it knows what a "name" or a
 * "last used" means), so no page inherits a comparator from another one's data shape. Ties keep the
 * page's own order in both directions (a stable sort of a copy, with the direction applied to the
 * comparison only), and nulls stay at the bottom instead of leading a descending list with "—".
 */
export function sortRows(rows, { key, order }, get) {
  const pick = get[key];
  if (typeof pick !== "function") return [...rows];
  const direction = order === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = normalize(pick(left));
    const b = normalize(pick(right));
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return direction * compareCell(a, b);
  });
}
