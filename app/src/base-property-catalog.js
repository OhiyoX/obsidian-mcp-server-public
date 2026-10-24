// Web Base property catalog (additive DTO field, lane desktop-re/panel-properties).
//
// The desktop Properties menu lists EVERY property the Base can address — the ones the
// selected view shows (checked) AND the ones it does not (unchecked), 26 rows in the
// owner's own screenshot — while the pre-existing `columns` DTO only carries the
// selected view's `order`. This module supplies the missing half without touching any
// existing field.
//
// ── One source of truth per fact (no second catalog) ─────────────────────────
//   ① built-in file properties → `BASE_BUILTIN_PROPERTY_NAMES` (`base-builtin-names.js`,
//      the desktop `o$` table at asar app.js@2351488 / i18n 2334-2347). Reused, not copied.
//   ② properties the `.base` declares → its own `properties:` block (parsed by the same
//      `parseAndValidateBase` the query pipeline uses) plus the resolved `columns`, whose
//      `label` already carries the desktop's displayName priority (`columnLabel`).
//   ③ properties that actually occur in the Base's directory → the frontmatter of the
//      records `loadRecords` already loaded for this request (the Web Catalog's typed
//      frontmatter tree). No extra IO: the record set is the one the query evaluated.
//
// The catalog is a read projection: `checked` is exactly membership in the view's
// `order`, so the client never re-derives visibility.
import { BASE_BUILTIN_PROPERTY_NAMES, builtinPropertyName } from "./base-builtin-names.js";
import { parseAndValidateBase } from "./base-query.js";

const BUILTIN_KEYS = Object.freeze(Object.keys(BASE_BUILTIN_PROPERTY_NAMES));

// The built-in `file.*` properties have a FIXED semantic type, so when a record holds no
// such key (they are computed, not authored) the observed-kind probe has nothing to look
// at and would fall back to text — which put the text glyph where the desktop paints a
// calendar (file.mtime/file.ctime) or a list. This table is that semantics, used only for
// the 14 built-ins; an authored key still goes through `observedKind`.
const BUILTIN_KINDS = Object.freeze({
  "file.ctime": "date",
  "file.mtime": "date",
  "file.size": "number",
  "file.links": "list",
  "file.backlinks": "list",
  "file.embeds": "list",
  "file.tags": "list",
});

function kindOf(key, values) {
  if (Object.hasOwn(BUILTIN_KINDS, key)) return BUILTIN_KINDS[key];
  return observedKind(values);
}

// Field order the desktop menu uses, as far as it can be evidenced: the 23 unchecked
// rows of the owner's screenshot are alphabetical by KEY (backlinks, basename, ctime,
// embeds, ext, folder, fullname, links, mtime, name, path, size, tags), not in the
// `o$` declaration order. The checked rows keep the view's own order and come first.
function compareKey(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirnameOf(relPath) {
  const value = String(relPath ?? "");
  const slash = value.lastIndexOf("/");
  return slash === -1 ? "" : value.slice(0, slash);
}

// A record belongs to the Base's directory when it sits anywhere under it.
export function isInBaseDirectory(recordPath, directory) {
  if (!directory) return true;
  const value = String(recordPath ?? "");
  return value === directory || value.startsWith(`${directory}/`);
}

// Coarse value kind for one observed frontmatter key. This is INFERENCE from the
// values the directory really holds (the DTO carries no declared type), so it stays a
// three-character-ish label for the client's icon slot and never claims a schema.
function observedKind(values) {
  let sawText = false;
  let sawNumber = false;
  let sawBoolean = false;
  let sawDate = false;
  let sawList = false;
  let sawObject = false;
  for (const value of values) {
    // A YAML date without quotes is parsed into a Date INSTANCE by the frontmatter loader, and
    // `typeof value === "object"` used to swallow it as an object — which painted the text glyph
    // where the desktop paints a calendar (the review saw it on `created`).
    if (value instanceof Date) sawDate = true;
    else if (Array.isArray(value)) sawList = true;
    else if (value === null || value === undefined) continue;
    else if (typeof value === "boolean") sawBoolean = true;
    else if (typeof value === "number") sawNumber = true;
    else if (typeof value === "string") {
      // Frontmatter quotes survive the parser (`created: '2026-08-30'`), so the date probe
      // has to look at the bare value, otherwise a quoted date reads as text and the row
      // gets the text glyph where the desktop paints a calendar.
      const bare = value.trim().replace(/^['"]/, "").replace(/['"]$/, "");
      // An EMPTY string is not evidence of text: `created:` with no value occurs in real
      // notes, and counting it as text stole the calendar glyph from a date column.
      if (bare === "") continue;
      if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(bare)) sawDate = true;
      else sawText = true;
    } else if (typeof value === "object") sawObject = true;
  }
  // Mixed columns report the most specific kind actually seen; text wins a tie because
  // an untyped frontmatter key is most often a string.
  if (sawList) return "list";
  if (sawObject) return "object";
  if (sawBoolean && !sawNumber && !sawText && !sawDate) return "boolean";
  if (sawNumber && !sawText && !sawDate) return "number";
  if (sawDate && !sawText) return "date";
  return "text";
}

function displayNameOf(declared) {
  if (!declared || typeof declared !== "object") return null;
  return typeof declared.displayName === "string" && declared.displayName ? declared.displayName : null;
}

// ── The catalog ─────────────────────────────────────────────────────────────
//
// `{ base: {path, raw}, columns: [{key, label, kind}], records: [{path, frontmatter}] }`
// → `[{ key, label, kind, checked, source }]`, checked rows first (view order), then the
// rest by key. `source` is provenance only (builtin / declared / observed) and is what
// the compatibility matrix documents; the client does not branch on it.
export function buildPropertyCatalog({ base, columns = [], records = [] } = {}) {
  let declaredProperties = {};
  const raw = base?.raw;
  if (typeof raw === "string") {
    try {
      declaredProperties = parseAndValidateBase(raw).base?.properties ?? {};
    } catch {
      // The query path already failed closed on an invalid document; a catalog that
      // cannot read `properties:` degrades to columns + builtins + observed keys
      // instead of turning a working page into an error.
      declaredProperties = {};
    }
  }

  const entries = new Map();
  const keyOrder = [];
  const add = (key, entry) => {
    if (!key || entries.has(key)) return;
    entries.set(key, entry);
    keyOrder.push(key);
  };
  // Label rule, corrected by the section-5.14 review against the owner's own screenshot:
  // the menu does NOT apply a `.base` displayName to note properties — `status`/`updated` read as
  // raw keys there, while the TABLE headers read 状态/更新. Only a FORMULA row takes its declared
  // displayName (项目). Built-ins always use their built-in name (文件反向链接).
  const label = (key, isFormula = false) =>
    (isFormula ? displayNameOf(declaredProperties[key]) : null) ?? builtinPropertyName(key) ?? key;

  // ① the view's own columns: these are the CHECKED rows, in the view's order.
  //
  // Their `kind` comes from the observed values too (not the literal "property"): the
  // desktop paints the type glyph on the checked rows as well (date → calendar), so a
  // placeholder kind here left those rows with an empty icon slot.
  const observedValuesEarly = new Map();
  {
    const directory = dirnameOf(base?.path);
    for (const record of Array.isArray(records) ? records : []) {
      if (!isInBaseDirectory(record?.path, directory)) continue;
      const frontmatter = record?.frontmatter;
      if (!frontmatter || typeof frontmatter !== "object") continue;
      for (const [key, value] of Object.entries(frontmatter)) {
        if (!observedValuesEarly.has(key)) observedValuesEarly.set(key, []);
        observedValuesEarly.get(key).push(value);
      }
    }
  }
  const order = [];
  for (const column of Array.isArray(columns) ? columns : []) {
    const key = typeof column?.key === "string" ? column.key : null;
    if (!key) continue;
    order.push(key);
    const isFormula = column?.kind === "formula";
    add(key, {
      key,
      label: isFormula
        ? (typeof column?.label === "string" && column.label ? column.label : label(key, true))
        : label(key),
      kind: isFormula ? "formula" : kindOf(key, observedValuesEarly.get(key) ?? []),
      checked: true,
      source: "column",
    });
  }

  // ② properties the `.base` declares but the view does not show (`properties:` only
  // names a display name, so the kind stays the observed/inferred one).
  const declaredKeys = Object.keys(declaredProperties).sort(compareKey);
  const declaredValues = new Map(declaredKeys.map((key) => [key, []]));

  // ③ keys that really occur in the Base's directory, from the records already loaded.
  // (Computed above as `observedValuesEarly`, before the checked rows needed it.)
  const directory = dirnameOf(base?.path);
  const observedValues = observedValuesEarly;

  // The unchecked half, in the desktop's own ORDER (coordinator, verified against the
  // owner's screenshot `02-properties-open.png`): the built-in `file.*` rows come first
  // (alphabetical by key: backlinks, basename, ctime, embeds, ext, folder, fullname,
  // links, mtime, name, path, size, tags) and only then the author's own keys
  // (archived, created, description, kind, … source_commit). Sorting everything in one
  // alphabetical run put `archived`/`created`/`description` ABOVE the built-ins, which is
  // not what the desktop paints.
  //
  // `file.file` (文件) is NOT listed: the desktop's screenshot has 13 built-in rows and
  // omits the note's own file link. It stays out of the unchecked set for that reason;
  // if a view ever shows it, it arrives through the CHECKED half instead.
  const builtinKeys = BUILTIN_KEYS.filter((key) => key !== "file.file").sort(compareKey);
  const authorKeys = [...new Set([...declaredKeys, ...observedValues.keys()])]
    .filter((key) => !Object.hasOwn(BASE_BUILTIN_PROPERTY_NAMES, key))
    .sort(compareKey);
  const unchecked = new Set([...builtinKeys, ...authorKeys]);
  for (const key of [...unchecked].filter((key) => !entries.has(key))) {
    const declared = declaredKeys.includes(key);
    const isBuiltin = Object.hasOwn(BASE_BUILTIN_PROPERTY_NAMES, key);
    add(key, {
      key,
      label: label(key),
      kind: isBuiltin ? "builtin" : kindOf(key, observedValues.get(key) ?? declaredValues.get(key) ?? []),
      checked: false,
      source: isBuiltin ? "builtin" : declared ? "declared" : "observed",
    });
  }

  return keyOrder.map((key) => entries.get(key));
}
