// Web Catalog tree-ordering primitives (pure, no SQL).
//
// Contract: docs/web-explorer-sort-model.md (#178) — folders first, the pinned
// zh-Hans collator for `name`, raw JS UTF-16 path tie-break, and missing/invalid
// `modified` last in both directions. node:sqlite cannot express that collator
// (no custom collation), so ordering is computed here and stored as columns;
// these helpers are the single source of the ordering contract.
export const DIRECTORY = "directory";
export const NOTE = "note";
export const BASE = "base";
// A non-Markdown, non-Base regular file (attachment). It carries no content
// projections at all: only path/name/extension/size/mtime.
export const FILE = "file";

// DIRECTORY is the only rank-0 kind; NOTE, BASE and FILE share file rank 1 so they
// never form a hidden "all Markdown then all Base then all attachments" grouping —
// every non-directory child is ordered by one sort tuple.
export function isFileKind(kind) {
  return kind === NOTE || kind === BASE || kind === FILE;
}

// Folders-first, collator name, missing-last — each tuple is entirely ascending
// so a plain row-value keyset works. `desc` is folded into the stored columns.
export const ORDERINGS = {
  name: {
    asc: ["kind_rank", "name_rank", "path_key"],
    desc: ["kind_rank", "name_rank_desc", "path_key"],
  },
  modified: {
    asc: ["kind_rank", "modified_valid", "modified_asc", "name_rank", "path_key"],
    desc: ["kind_rank", "modified_valid", "modified_desc", "name_rank", "path_key"],
  },
};

// Flat (no directory level) orderings. A flat page returns only note rows, so
// `kind_rank` is a constant and is dropped. Each entry is `[column, "asc" | "desc"]`.
//
// Only GLOBALLY meaningful ordering columns are allowed here:
//   - `modified_valid` / `modified_asc` / `modified_desc` come from the row's own
//     `modified_ms`, so they compare across parents;
//   - `path_key` is a pure function of the row's own path, so it is a total,
//     globally consistent tie-break.
// `name_rank`/`name_rank_desc` are deliberately NOT used: they are a dense collator
// rank *within (parent, kind)* (see rank-recompute.js `denseNameRanks` over
// `selectChildren(parent)` and schema.js), so ordering by them across parents groups
// notes by their rank in unrelated folders instead of by name. Serving a real global
// `sort=name` needs a catalog-level global name-rank projection (schema change +
// recompute cost); the flat HTTP layer rejects `sort=name` instead of returning a
// subtly wrong order. `path` is the only ordering with a real descending scan (the
// `nodes_kind_path_key` index is read backwards), so the keyset operator is derived
// from the entry directions instead of assumed.
export const FLAT_ORDERINGS = {
  modified: {
    asc: [["modified_valid", "asc"], ["modified_asc", "asc"], ["path_key", "asc"]],
    desc: [["modified_valid", "asc"], ["modified_desc", "asc"], ["path_key", "asc"]],
  },
  path: {
    asc: [["path_key", "asc"]],
    desc: [["path_key", "desc"]],
  },
};

const COLLATOR_OPTIONS = { numeric: false, sensitivity: "variant", ignorePunctuation: false };
const COLLATOR_LOCALE = "zh-Hans";
const NAME_COLLATOR = new Intl.Collator(COLLATOR_LOCALE, COLLATOR_OPTIONS);

// The pinned collator is only reproducible for a given ICU/Unicode dataset, so a
// persisted rank is only trustworthy while this identity matches. Phase 1A cannot
// prove cross-version equivalence, so any change (locale/options/ICU/Unicode/Node)
// invalidates the stored ordering projection.
export const SORT_CONTRACT_VERSION = 1;

export function currentSortContract() {
  return {
    version: SORT_CONTRACT_VERSION,
    locale: COLLATOR_LOCALE,
    numeric: COLLATOR_OPTIONS.numeric,
    sensitivity: COLLATOR_OPTIONS.sensitivity,
    ignorePunctuation: COLLATOR_OPTIONS.ignorePunctuation,
    icu: process.versions.icu ?? null,
    unicode: process.versions.unicode ?? null,
    node: process.versions.node ?? null,
  };
}

export function sortContractId(contract = currentSortContract()) {
  return JSON.stringify(contract);
}

export function nfc(value) {
  return String(value ?? "").normalize("NFC");
}

export function compareCollator(left, right) {
  return NAME_COLLATOR.compare(nfc(left), nfc(right));
}

export function comparePath(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// hex(UTF-16BE code units). SQLite TEXT BINARY is UTF-8 byte order, which
// disagrees with the frozen JS raw UTF-16 path tie-break for BMP vs supplementary
// characters (e.g. U+FA6C vs U+242EE). This stored hex string's ASCII BINARY
// order equals UTF-16 code-unit order, so it is the only path tie-break used by
// the ordering indexes/keysets.
export function pathKeyOf(value) {
  return Buffer.from(String(value ?? ""), "utf16le").swap16().toString("hex");
}

// Dense rank: collator-equal names share a rank, and the raw path is the stable
// tie-break. Returns Map(path -> rank).
export function denseNameRanks(rows) {
  const sorted = [...rows].sort(
    (left, right) => compareCollator(left.basename, right.basename) || comparePath(left.path, right.path),
  );
  const ranks = new Map();
  let rank = -1;
  let previous = null;
  for (const row of sorted) {
    const key = nfc(row.basename);
    if (previous === null || compareCollator(previous, key) !== 0) {
      rank += 1;
      previous = key;
    }
    ranks.set(row.path, rank);
  }
  return ranks;
}
