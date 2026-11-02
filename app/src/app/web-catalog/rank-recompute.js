// Dense ordering-rank recomputation for the Web Catalog store.
//
// Extracted from sqlite-store.js. Ordering columns are derived from children, so a
// mutation only dirties the parent it touched; ranks are recomputed once per dirty
// parent at the end of the outermost transaction.
import { normalizeRelative } from "./catalog-path.js";
import { DIRECTORY, denseNameRanks, isFileKind } from "./ordering.js";

export function createRankRecompute({ db }) {
  const updateRank = db.prepare(
    "UPDATE nodes SET name_rank = ?, name_rank_desc = ?, modified_valid = ?, modified_asc = ?, modified_desc = ? WHERE path = ?",
  );
  const selectChildren = db.prepare("SELECT path, kind, basename, modified_ms FROM nodes WHERE parent_path = ?");

  const dirtyParents = new Set();
  let rankWrites = 0;
  let log = [];

  function recompute(parent) {
    const rows = selectChildren.all(parent);
    if (rows.length === 0) return;
    log.push(parent);
    const directories = rows.filter((row) => row.kind === DIRECTORY);
    // NOTE and BASE are one file group: they use the exact same sort tuple and are
    // never separated into "all Markdown first, all Base last".
    const files = rows.filter((row) => isFileKind(row.kind));

    const directoryRanks = denseNameRanks(directories);
    for (const row of directories) {
      const rank = directoryRanks.get(row.path);
      // Folders carry no `modified`: they are always name ASC, even for
      // sort=modified desc.
      updateRank.run(rank, -rank, 0, rank, rank, row.path);
    }

    const fileRanks = denseNameRanks(files);
    for (const row of files) {
      const rank = fileRanks.get(row.path);
      const missing = row.modified_ms === null || row.modified_ms === undefined;
      // Missing/invalid modified sorts after every valid timestamp in BOTH
      // directions (modified_valid is never negated).
      updateRank.run(
        rank,
        -rank,
        missing ? 1 : 0,
        missing ? 0 : row.modified_ms,
        missing ? 0 : -row.modified_ms,
        row.path,
      );
    }
    rankWrites += rows.length;
  }

  return {
    markDirty: (parent) => dirtyParents.add(normalizeRelative(parent)),
    flush() {
      if (dirtyParents.size === 0) return;
      const parents = [...dirtyParents];
      dirtyParents.clear();
      for (const parent of parents) recompute(parent);
    },
    clear: () => dirtyParents.clear(),
    rankWrites: () => rankWrites,
    // Callers that rewrite exactly one row's modified ordering (a same-name save)
    // account for it as a single rank write.
    rankWritesIncrement: () => {
      rankWrites += 1;
    },
    recomputes: () => [...log],
    resetLog: () => {
      log = [];
    },
  };
}
