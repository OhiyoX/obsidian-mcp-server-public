// Web Catalog reconcile — single-flight, generation-fenced, incremental.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
//
// A reconcile may enumerate O(N), but it must not read unchanged bodies, must not
// run concurrent copies, must not publish a snapshot that a concurrent mutation has
// already superseded, and must keep the previous readable snapshot when it fails.
import { baseRecordFromRead, catalogRecordFromRead, ensureCatalogDirectories } from "./indexer.js";

export function createWebCatalogReconciler({
  store,
  source,
  now = () => Date.now(),
  maxEntries = Number.MAX_SAFE_INTEGER,
  maxReadBytes = Number.MAX_SAFE_INTEGER,
  // Coverage fence: a scan may only publish "clean" while coverage is stable and
  // present. The runtime supplies these; the pure reconciler defaults to always-on.
  publishFence = () => 0,
  isCovered = () => true,
} = {}) {
  if (!store || !source) throw new Error("createWebCatalogReconciler requires store and source");

  let loop = null;
  let dirty = false;

  async function scan() {
    const startedAt = now();
    const startedGeneration = store.generation();
    const startedFence = publishFence();
    // Stale is committed immediately (autocommit) so a concurrent reader knows the
    // snapshot is being rebuilt; it is cleared inside the publication batch.
    store.setStale(true);

    const listed = (await source.list()).slice(0, maxEntries);
    // U6 explicit directories: a folder that recursively holds no catalog document
    // still becomes a `directory` node. Listed separately from files so the file
    // stats/removal contract is untouched; a source without the hook keeps the
    // legacy "directories are only file ancestors" behaviour (including, below, no
    // directory reaping — an inventory-less scan cannot tell "empty" from "gone").
    const directoryInventory = typeof source.listDirectories === "function";
    const directories = directoryInventory ? (await source.listDirectories()).slice(0, maxEntries) : [];
    const existing = new Map(store.listDocumentMetadata().map((row) => [row.path, row]));
    const seen = new Set();
    const stats = { scanned: 0, reparsed: 0, reused: 0, removed: 0, metadataOnly: 0, files: 0, directories: 0 };
    const upserts = [];
    const baseUpserts = [];
    const metadataOnly = [];
    const fileUpserts = [];

    for (const entry of listed) {
      const rel = String(entry?.path || "");
      if (!rel) continue;
      seen.add(rel);
      stats.scanned += 1;
      const previous = existing.get(rel);
      // Reuse requires a real identity match. "An old revision exists" is not
      // evidence: a same-size/same-mtime rewrite must still be re-read.
      if (previous && entry.signature && previous.metadata_revision === entry.signature) {
        stats.reused += 1;
        continue;
      }
      // An attachment is enumerated, never read: the catalog stores its
      // path/name/size/mtime (and the stat signature for reuse) only. It cannot hit
      // maxReadBytes because no bytes are ever loaded.
      if (entry.kind === "file") {
        fileUpserts.push({
          path: rel,
          size: typeof entry.size === "number" ? entry.size : null,
          modifiedMs: entry.modifiedMs ?? null,
          metadataRevision: entry.signature ?? null,
        });
        stats.files += 1;
        continue;
      }
      if (typeof entry.size === "number" && entry.size > maxReadBytes) {
        // Only a bounded/oversized document degrades to metadata-only; it stays
        // visible in the tree with its ancestor chain.
        metadataOnly.push({
          path: rel,
          kind: entry.kind === "base" ? "base" : "note",
          size: entry.size,
          modifiedMs: entry.modifiedMs ?? null,
          metadataRevision: entry.signature ?? null,
        });
        stats.metadataOnly += 1;
        continue;
      }
      // A Base is a typed node: stat + byte revision only, never the Markdown
      // parser/FTS. Any other read failure propagates so the caller keeps the
      // previous snapshot and the catalog stays stale.
      if (entry.kind === "base") {
        const read = await source.readBase(rel);
        baseUpserts.push({ read, signature: entry.signature ?? null });
        stats.reparsed += 1;
        continue;
      }
      const read = await source.read(rel);
      upserts.push({ read, signature: entry.signature ?? null });
      stats.reparsed += 1;
    }
    const removals = [...existing.keys()].filter((rel) => !seen.has(rel));
    // Issue #532: a directory is an inventory node, so it must be diffed against the
    // scan as directly as a file is. Without this, a folder deleted from outside the
    // catalog (Obsidian desktop, MCP manage_folders, a shell rm) keeps a phantom
    // tree node forever: pruneEmptyAncestors only fires as a side effect of a
    // document removal, and an empty folder has no document removal to fire it.
    // Only a source with the directory hook has a complete listing to diff against.
    // `seen` exclusion: a path the scan found as a file is a kind flip (folder
    // replaced by a same-named file), already handled by its upsert — reaping it
    // here would delete the row this very batch just rewrote.
    const seenDirectories = new Set(directories.map((entry) => String(entry?.path || "")).filter(Boolean));
    const staleDirectories = directoryInventory
      ? store.listDirectoryPaths().filter((rel) => !seenDirectories.has(rel) && !seen.has(rel))
      : [];

    // Generation fence: a mutation during the async scan has already advanced the
    // catalog, so this stale snapshot must not overwrite it. Mark dirty and let the
    // loop re-run; the fresh scan then observes the mutation.
    if (store.generation() !== startedGeneration) {
      dirty = true;
      return { skipped: true, reason: "generation-changed-during-scan", ...stats };
    }

    store.batch(() => {
      for (const { read, signature } of upserts) {
        ensureCatalogDirectories(store, read.path);
        store.upsertNote({ ...catalogRecordFromRead(read), metadataRevision: signature });
      }
      for (const { read, signature } of baseUpserts) {
        ensureCatalogDirectories(store, read.path);
        store.upsertBase({ ...baseRecordFromRead(read), metadataRevision: signature });
      }
      for (const entry of fileUpserts) {
        ensureCatalogDirectories(store, entry.path);
        store.upsertFile(entry);
      }
      for (const entry of metadataOnly) {
        ensureCatalogDirectories(store, entry.path);
        if (entry.kind === "base") store.upsertBase(entry);
        else store.upsertNote(entry);
      }
      for (const rel of removals) {
        store.removePath(rel);
        stats.removed += 1;
      }
      // The same removal contract for explicit directory nodes. Runs BEFORE the
      // re-materialization below, which restores every on-disk directory that a
      // removal's ancestor prune just emptied out (a legit childless folder among
      // them). removePath already covers the whole `rel/` subtree of a stale row.
      for (const rel of staleDirectories) {
        store.removePath(rel);
        stats.removed += 1;
      }
      // AFTER removals: a file removal prunes now-childless ancestor directories,
      // so a directory that still exists on disk (and was listed above) must be
      // re-materialized here instead of being pruned away by that same scan.
      for (const directory of directories) {
        store.upsertDirectory({ path: directory.path, name: null });
        stats.directories += 1;
      }
      store.setReconciledAt(new Date(now()).toISOString());
      // Publication fence: only a scan that still has stable, present coverage may
      // clear stale. A coverage loss during the scan leaves the catalog stale.
      if (publishFence() === startedFence && isCovered()) store.setStale(false);
    });

    return { skipped: false, generation: store.generation(), ...stats, durationMs: now() - startedAt };
  }

  // Single-flight loop: invalidations during a pass make it run again, and every
  // caller (including drain()) awaits the whole loop, not just the current scan.
  function reconcile() {
    if (loop) {
      dirty = true;
      return loop;
    }
    const run = (async () => {
      let result;
      do {
        dirty = false;
        result = await scan();
      } while (dirty);
      return result;
    })();
    loop = run;
    const clear = () => {
      if (loop === run) loop = null;
    };
    run.then(clear, clear);
    return run;
  }

  return {
    reconcile,
    isRunning: () => loop !== null,
    markDirty: () => {
      dirty = true;
    },
  };
}
