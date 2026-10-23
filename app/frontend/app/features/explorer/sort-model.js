// Explorer sort model — Phase 1 pure ordering helpers.
//
// This module only re-orders records that the caller already holds. It never
// fetches, filters, dedupes, rewrites, or resolves records, and it never touches
// DOM / state / localStorage. It is intentionally not imported by any production
// bundle yet; see docs/web-explorer-sort-model.md for the frozen contract and the
// integration prerequisites that a later controller slice must satisfy.

const NAME_COLLATOR = new Intl.Collator("zh-Hans", {
  numeric: false,
  sensitivity: "variant",
  ignorePunctuation: false,
});

const TREE_KEYS = ["name", "modified"];
const FLAT_KEYS = ["name", "modified", "path", "score"];
const DEFAULT_KEY = "name";
const DEFAULT_DIRECTION = "asc";

// Strict RFC3339-style datetime: explicit timezone (`Z`/`z` or `±HH:MM`) is
// mandatory, `T`/`t` separates date and time, seconds are required, and the
// fractional part accepts one or more digits (truncated to milliseconds).
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

function defaultSort() {
  return { key: DEFAULT_KEY, direction: DEFAULT_DIRECTION };
}

function normalizeSort(sort, allowedKeys) {
  if (sort === null || typeof sort !== "object") return defaultSort();
  if (!allowedKeys.includes(sort.key)) return defaultSort();
  if (sort.direction !== "asc" && sort.direction !== "desc") return defaultSort();
  return { key: sort.key, direction: sort.direction };
}

function isUsableString(value) {
  return typeof value === "string" && value.length > 0;
}

function basename(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  return base.length > 0 ? base : "";
}

function recordPath(record) {
  const path = record?.path;
  return typeof path === "string" ? path : "";
}

// Sorting name: title, else basename(path), else the raw path. `.md` is never
// stripped and no new title is derived. Records whose title/path are not usable
// strings degrade to "" for comparison only; the record itself is untouched.
function recordName(record) {
  const title = record?.title;
  if (isUsableString(title)) return title;
  const path = record?.path;
  if (isUsableString(path)) {
    const base = basename(path);
    return base.length > 0 ? base : path;
  }
  return "";
}

function folderName(folder) {
  const name = folder?.name;
  if (isUsableString(name)) return name;
  const path = folder?.path;
  if (isUsableString(path)) {
    const base = basename(path);
    return base.length > 0 ? base : path;
  }
  return "";
}

// Raw UTF-16 code-unit ordering. Used for `path` sorting and every final path
// tie-break so path identity is locale-independent.
function compareUtf16(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareName(left, right) {
  return NAME_COLLATOR.compare(left.normalize("NFC"), right.normalize("NFC"));
}

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

// Returns an epoch-ms number for a strict timezone-bearing RFC3339 datetime, or
// null for missing/invalid input. Component ranges are validated explicitly,
// because `Date.parse` silently rolls calendar-invalid values (e.g.
// 2026-02-30 -> 2026-03-02) instead of rejecting them.
function parseTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (offset !== "Z" && offset !== "z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const millis = match[7] ? Number(`${match[7]}000`.slice(0, 3)) : 0;
  // The base year is a leap year so day 29 is accepted here only after the
  // target-year leap check above has already run.
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millis));
  date.setUTCFullYear(year);
  const epoch = date.getTime();
  if (!Number.isFinite(epoch)) return null;
  if (offset === "Z" || offset === "z") return epoch;
  const sign = offset[0] === "-" ? -1 : 1;
  const offsetMinutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return epoch - offsetMinutes * 60_000;
}

function finiteScore(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Secondary ordering for equal `modified`/invalid groups: name ASC, then raw
// path ASC. Direction never reverses these.
function compareNameThenPath(left, right) {
  const byName = compareName(recordName(left), recordName(right));
  if (byName !== 0) return byName;
  return compareUtf16(recordPath(left), recordPath(right));
}

function compareByName(left, right, direction) {
  const byName = compareName(recordName(left), recordName(right));
  if (byName !== 0) return direction === "desc" ? -byName : byName;
  return compareUtf16(recordPath(left), recordPath(right));
}

function compareByModified(left, right, direction) {
  const leftTime = parseTimestamp(left?.modified);
  const rightTime = parseTimestamp(right?.modified);
  if (leftTime !== null && rightTime !== null) {
    if (leftTime !== rightTime) {
      const byTime = leftTime < rightTime ? -1 : 1;
      return direction === "desc" ? -byTime : byTime;
    }
    return compareNameThenPath(left, right);
  }
  // Valid timestamps always precede invalid/missing ones, in both directions.
  if (leftTime !== null) return -1;
  if (rightTime !== null) return 1;
  return compareNameThenPath(left, right);
}

function compareByPath(left, right, direction) {
  const byPath = compareUtf16(recordPath(left), recordPath(right));
  return direction === "desc" ? -byPath : byPath;
}

function compareByScore(left, right, direction) {
  const leftScore = finiteScore(left?.score);
  const rightScore = finiteScore(right?.score);
  if (leftScore !== null && rightScore !== null) {
    if (leftScore !== rightScore) {
      const byScore = leftScore < rightScore ? -1 : 1;
      return direction === "desc" ? -byScore : byScore;
    }
    return compareUtf16(recordPath(left), recordPath(right));
  }
  if (leftScore !== null) return -1;
  if (rightScore !== null) return 1;
  return compareUtf16(recordPath(left), recordPath(right));
}

function compareFolder(left, right, spec) {
  const byName = compareName(folderName(left), folderName(right));
  // Folders carry no `modified`; they are always name ASC and never follow the
  // notes' modified direction.
  if (spec.key === "modified") {
    if (byName !== 0) return byName;
    return compareUtf16(recordPath(left), recordPath(right));
  }
  if (byName !== 0) return spec.direction === "desc" ? -byName : byName;
  return compareUtf16(recordPath(left), recordPath(right));
}

function compareNote(left, right, spec) {
  return spec.key === "modified"
    ? compareByModified(left, right, spec.direction)
    : compareByName(left, right, spec.direction);
}

function compareFlatNote(left, right, spec) {
  switch (spec.key) {
    case "modified":
      return compareByModified(left, right, spec.direction);
    case "path":
      return compareByPath(left, right, spec.direction);
    case "score":
      return compareByScore(left, right, spec.direction);
    default:
      return compareByName(left, right, spec.direction);
  }
}

// Copies the array and sorts records in place by reference, so record identity
// and cardinality are preserved and the caller's array is never mutated. Equal
// comparison keys fall back to the original input index.
function stableSort(records, compare) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => compare(left.record, right.record) || left.index - right.index)
    .map((entry) => entry.record);
}

// Sorts one already-loaded tree level. Returns new `{ folders, notes }` arrays;
// folders are structurally separate from notes and therefore always render
// first, regardless of key or direction.
export function sortTreeLevel(input, sort) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("sortTreeLevel expects an object with { folders, notes }");
  }
  if (!Array.isArray(input.folders) || !Array.isArray(input.notes)) {
    throw new TypeError("sortTreeLevel expects folders and notes arrays");
  }
  const spec = normalizeSort(sort, TREE_KEYS);
  return {
    folders: stableSort(input.folders, (left, right) => compareFolder(left, right, spec)),
    notes: stableSort(input.notes, (left, right) => compareNote(left, right, spec)),
  };
}

// Re-orders the already-loaded flat record set. `score` is only honoured when
// `context.query === true`; any other score request falls back to name ASC.
export function sortFlatNotes(notes, sort, context) {
  if (!Array.isArray(notes)) {
    throw new TypeError("sortFlatNotes expects an array of notes");
  }
  let spec = normalizeSort(sort, FLAT_KEYS);
  if (spec.key === "score" && context?.query !== true) spec = defaultSort();
  return stableSort(notes, (left, right) => compareFlatNote(left, right, spec));
}
