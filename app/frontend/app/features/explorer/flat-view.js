// Explorer flat-list adapter + renderer.
//
// The flat list has two data sources with different payload shapes:
//   - an active query  -> `/api/web/v2/search` rows (`name` + `modifiedMs` + `score`);
//   - no query         -> `/api/web/v2/tree?flat=1` note rows (`title` + ISO `modified`).
// `toFlatRecord()` normalizes both into the exact record shape the frozen
// `sortFlatNotes()` model reads (`path`/`title`/`modified`/`score`), so the flat list
// never grows a second comparator family. Ordering is always delegated to the model.
//
// The renderer reuses the existing note-row format (`.note` + `.note-title`) and adds
// only a muted relative-path subtitle; the current-note identity/scroll behaviour
// matches the Tree renderer (`isCurrent` + `aria-current="page"`).

function basenameOf(value) {
  const path = String(value ?? "");
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  return base;
}

function isoFromMillis(value) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function finiteScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Display name for a flat row: the search payload's `name` (a basename with `.md`)
// is normalized to the catalog's display title (extension stripped) so a row reads
// the same whichever source produced it.
export function flatTitleOf(item) {
  const title = item?.title;
  if (typeof title === "string" && title.length > 0) return title;
  const name = item?.name;
  if (typeof name === "string" && name.length > 0) return name.replace(/\.md$/i, "");
  // Same fallback as the frozen model's `recordName`: basename, else the raw path.
  const base = basenameOf(item?.path);
  return base.length > 0 ? base : String(item?.path ?? "");
}

// One record in the shape `sortFlatNotes()` reads. `modified` is only set when it is
// a timestamp the model's strict parser accepts; anything else stays absent and
// therefore sorts last, exactly like a Tree note without metadata.
export function toFlatRecord(item) {
  const record = { path: String(item?.path ?? ""), title: flatTitleOf(item) };
  const modified = typeof item?.modified === "string" ? item.modified : isoFromMillis(item?.modifiedMs);
  if (modified) record.modified = modified;
  const score = finiteScore(item?.score);
  if (score !== null) record.score = score;
  return record;
}

export function toFlatRecords(items) {
  return Array.isArray(items) ? items.map(toFlatRecord) : [];
}

function buildLoadMore({ loading, onLoadMore }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-load-more flat-load-more";
  button.disabled = loading === true;
  button.textContent = loading ? "正在加载…" : "加载更多";
  button.onclick = () => {
    if (!button.disabled) onLoadMore?.();
  };
  return button;
}

function buildError({ onRetry }) {
  const wrap = document.createElement("div");
  wrap.className = "tree-load-error";
  const message = document.createElement("span");
  message.className = "tree-load-error-text";
  message.textContent = "加载失败";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "tree-retry";
  retry.textContent = "重试";
  retry.onclick = () => onRetry?.();
  wrap.append(message, retry);
  return wrap;
}

export function renderFlatList({
  host,
  records,
  isCurrent,
  onNote,
  loading = false,
  error = null,
  hasMore = false,
  onLoadMore,
  onRetry,
  revealCurrent = false,
}) {
  host.innerHTML = "";
  const items = Array.isArray(records) ? records : [];
  if (items.length === 0) {
    if (error) {
      host.append(buildError({ onRetry }));
      return;
    }
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = loading ? "正在加载…" : "没有找到笔记";
    host.append(empty);
    return;
  }

  for (const record of items) {
    const button = document.createElement("button");
    const active = Boolean(isCurrent?.(record.path));
    button.className = `note note-flat${active ? " active" : ""}`;
    button.dataset.path = record.path;
    button.dataset.kind = "note";
    if (active) button.setAttribute("aria-current", "page");
    button.title = record.path;
    const title = document.createElement("div");
    title.className = "note-title";
    // textContent is inherently escaped; `escapeHtml` is for the innerHTML path only.
    title.textContent = String(record.title ?? "");
    const subtitle = document.createElement("div");
    subtitle.className = "note-subtitle";
    subtitle.textContent = record.path;
    button.append(title, subtitle);
    button.onclick = () => onNote?.(record.path);
    host.append(button);
  }
  if (hasMore) host.append(buildLoadMore({ loading, onLoadMore }));
  if (error) host.append(buildError({ onRetry }));
  if (revealCurrent) {
    host.querySelector('.note[aria-current="page"]')?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
}
