// Web Catalog runtime — per-vault store lifecycle + watcher/write/resync hooks.
//
// Contract: _Workspace/40-Projects/obsidian_mcp_server/Web/TODO - Web 大型 Vault 动态加载与持久索引架构.md
//
// Phase 1B wires the catalog into the existing lifecycle: startup reconcile,
// filesystem watcher events, vault.resync and internal Web writes. It is gated by
// WEB_CATALOG_ENABLED so the production default stays unchanged until the v2 read
// routes exist.
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_PATH, MAX_READ_BYTES } from "../../config.js";
import { createVaultCatalogSource, upsertCatalogBase, upsertCatalogFile, upsertCatalogRead } from "./indexer.js";
import { createWebCatalogReconciler } from "./reconcile.js";
import { openWebCatalogStore } from "./store.js";
import { readBaseInRoot, readNoteInRoot } from "./note-reader.js";
import {
  BASE_KIND,
  FILE_KIND,
  catalogKindForName,
  isCatalogInventoryPath,
  listCatalogDirectoriesUnder,
  listCatalogInventoryUnder,
  toRootRelative,
} from "./vault-source.js";

export function isWebCatalogEnabled() {
  // Phase 2B: the Explorer reads /api/web/v2/tree, so the catalog is enabled by
  // default. Set WEB_CATALOG_ENABLED=false to opt out (then v2 returns 503).
  return !/^(?:0|false|off|no)$/i.test(String(process.env.WEB_CATALOG_ENABLED ?? "true"));
}

// Web Catalog location boundary (#428). Precedence: a truthy `WEB_CATALOG_DIR` keeps its
// existing interpretation (a relative value resolves against the process cwd), otherwise the
// already-resolved `DATA_PATH` from config.js owns the directory. The retired default was
// `process.cwd()/data/web-catalog`, which silently made every server started with the same cwd
// and the same vault id open ONE SQLite file. There is still no lock: two *processes* that are
// given the same effective directory and the same vault id share that file (documented boundary).
export const WEB_CATALOG_DIR_SOURCE = Object.freeze({
  EXPLICIT: "WEB_CATALOG_DIR",
  DATA_PATH: "DATA_PATH",
});

export function resolveWebCatalogLocation(vault) {
  const configured = process.env.WEB_CATALOG_DIR;
  const source = configured ? WEB_CATALOG_DIR_SOURCE.EXPLICIT : WEB_CATALOG_DIR_SOURCE.DATA_PATH;
  const dir = configured ? path.resolve(configured) : path.join(DATA_PATH, "web-catalog");
  return { vaultId: vault.id, dir, file: path.join(dir, `${vault.id}.sqlite`), source };
}

export function catalogFileFor(vault) {
  return resolveWebCatalogLocation(vault).file;
}

// One line per store that was ACTUALLY opened (not per request, and never inside an HTTP
// response). The logged file is the exact value handed to `openWebCatalogStore`.
export function describeWebCatalogOpen(location) {
  return `Web Catalog (${location.vaultId}): store ${location.file} (source: ${location.source})`;
}

function relativeToVault(vault, absolute) {
  return toRootRelative(vault.root, absolute);
}

export function createWebCatalogRuntime({ vault, store, source, now, logger = console }) {
  // Coverage is the watcher's liveness. A snapshot may only be published "clean"
  // while coverage is present and unchanged; the epoch bumps on every coverage loss
  // so a scan that started before the loss can never clear stale afterwards.
  const coverage = { covered: false, epoch: 0 };
  const reconciler = createWebCatalogReconciler({
    store,
    source,
    now,
    maxReadBytes: MAX_READ_BYTES,
    publishFence: () => coverage.epoch,
    isCovered: () => coverage.covered,
  });
  const report = (error) => logger.error(`Web Catalog (${vault.id}):`, error?.message || error);
  let started = false;

  // A failed incremental mutation must never leave a clean snapshot: mark stale and
  // schedule a repair. The already-committed Markdown/SSE flow is never failed.
  const recover = (error) => {
    report(error);
    try {
      store.setStale(true);
    } catch (nested) {
      report(nested);
    }
    reconciler.reconcile().catch(report);
  };

  const resync = (origin = "resync") => {
    try {
      store.setStale(true);
    } catch (error) {
      report(error);
    }
    reconciler.reconcile().catch(report);
    return { origin, stale: true };
  };

  // Coverage transitions on BOTH edges bump the epoch, so a scan that started in
  // one coverage state can never publish clean in the other. Gaining coverage does
  // not reconcile by itself: the watcher-ready path schedules exactly one reconcile
  // (via vault.resync), so a ready event never runs a duplicate pass.
  const setCoverage = (covered, origin = "coverage") => {
    if (coverage.covered !== covered) coverage.epoch += 1;
    coverage.covered = covered;
    if (!covered) {
      try {
        store.setStale(true);
      } catch (error) {
        report(error);
      }
    }
    return { origin, covered };
  };

  return {
    vaultId: vault.id,
    store,
    status: () => ({
      vaultId: vault.id,
      generation: store.generation(),
      stale: store.isStale(),
      reconciling: reconciler.isRunning(),
      covered: coverage.covered,
      coverageEpoch: coverage.epoch,
    }),
    // Read-your-writes for internal Web/MCP writes: the file is already committed,
    // then the catalog is updated in the same request flow (one published
    // generation). A same-revision, same-metadata write is a no-op (watcher echo).
    // A `.base` never enters the Markdown reader/parser/FTS: it is stat + byte hash
    // + a nodes row only. An attachment is stat-only: no bytes are read at all.
    async indexFile(absolute, relPath) {
      const rel = relPath ?? relativeToVault(vault, absolute);
      try {
        // A hidden path is not an inventory entry at all: never read it as Markdown.
        if (!isCatalogInventoryPath(rel)) return { path: rel, ok: true, skipped: true };
        const kind = catalogKindForName(path.posix.basename(rel));
        if (kind === BASE_KIND) {
          const read = await source.readBase(rel);
          const record = upsertCatalogBase(store, read);
          return { path: record.path, ok: true, skipped: Boolean(record.skipped) };
        }
        // An attachment is stat-only: its bytes are never opened.
        if (kind === FILE_KIND) {
          const entry = await source.statFile(rel);
          const record = upsertCatalogFile(store, entry);
          return { path: record.path, ok: true, skipped: Boolean(record.skipped) };
        }
        const read = await source.read(rel);
        const record = upsertCatalogRead(store, read);
        return { path: record.path, ok: true, skipped: Boolean(record.skipped) };
      } catch (error) {
        recover(error);
        return { path: rel, ok: false };
      }
    },
    removePath(relPath) {
      try {
        const removed = store.removePath(relPath);
        return { path: relPath, removed, ok: true };
      } catch (error) {
        recover(error);
        return { path: relPath, removed: 0, ok: false };
      }
    },
    // watcher-ready / overflow / unknown / vault.resync: mark stale and reconcile in
    // the background; the previous snapshot stays readable meanwhile.
    resync,
    setCoverage,
    // Idempotent background reconcile: the first caller that wants it starts one.
    // A tree read path passes startReconcile:false, so a cold GET can never kick
    // off a full inventory from the request path.
    start() {
      if (started) return;
      started = true;
      reconciler.reconcile().catch(report);
    },
    isStarted: () => started,
    async drain() {
      return reconciler.reconcile();
    },
    close() {
      store.close();
    },
  };
}

const runtimes = new Map();
let runtimeFactory = createDefaultRuntime;

function createDefaultRuntime(vault) {
  const location = resolveWebCatalogLocation(vault);
  const store = openWebCatalogStore({ file: location.file });
  // Emitted after a successful open, so the line always names a file that is really in use.
  console.log(describeWebCatalogOpen(location));
  const source = createVaultCatalogSource({
    vaultRoot: vault.root,
    // Phase 2A-0: root-scoped for every Vault (primary and secondary alike).
    listDocuments: (options) => listCatalogInventoryUnder(vault.root, options),
    // U6: explicit directories (including recursively empty ones) so a folder with
    // no catalog document is still visible in the Explorer tree.
    listDirectories: (options) => listCatalogDirectoriesUnder(vault.root, options),
    stat: (absolute) => fs.stat(absolute),
    // Root-scoped secure reader: obsidian.readNote() is bound to the primary
    // VAULT, so a secondary sibling Vault must use this instead.
    readNote: (absolute, options) => readNoteInRoot(vault.root, absolute, options),
    readBase: (absolute) => readBaseInRoot(vault.root, absolute),
    toVaultPath: (absolute) => toRootRelative(vault.root, absolute),
  });
  return createWebCatalogRuntime({ vault, store, source });
}

export function getWebCatalogRuntime(vault, { startReconcile = true } = {}) {
  if (!vault?.id || !isWebCatalogEnabled()) return null;
  let runtime = runtimes.get(vault.id);
  if (!runtime) {
    // An open/migration failure must surface as an availability error, not a 500.
    runtime = runtimeFactory(vault);
    runtimes.set(vault.id, runtime);
  }
  if (startReconcile) runtime.start();
  return runtime;
}

export function getWebCatalogRuntimeById(vaultId) {
  return runtimes.get(vaultId) ?? null;
}

export function closeWebCatalogRuntime(vaultId) {
  const runtime = runtimes.get(vaultId);
  if (!runtime) return;
  runtimes.delete(vaultId);
  try {
    runtime.close();
  } catch {
    // best-effort shutdown
  }
}

// Applies one watcher event to the catalog. Catalog failures must never break the
// SSE path, so this is best-effort and always resolves.
export async function applyWatcherEvent(runtime, { type, path: relPath, absolute }) {
  if (!runtime) return null;
  try {
    if (type === "note.deleted") return runtime.removePath(relPath);
    if (type === "note.created" || type === "note.changed") return await runtime.indexFile(absolute, relPath);
    return null;
  } catch (error) {
    return null;
  }
}

// SSE layer hook for vault.resync / watcher-ready / overflow. Best-effort.
export function notifyVaultResync(vaultId, origin) {
  try {
    getWebCatalogRuntimeById(vaultId)?.resync(origin);
  } catch (error) {
    console.error(`Web Catalog resync scheduling failed (${vaultId}):`, error?.message || error);
  }
}

// Watcher hook: one note event -> one catalog mutation. Best-effort.
export function indexWatcherEvent(vaultId, event, absolute) {
  const runtime = getWebCatalogRuntimeById(vaultId);
  if (!runtime) return;
  applyWatcherEvent(runtime, { type: event.type, path: event.path, absolute }).catch(() => {});
}

// Watcher (re)started: coverage is back, so reconcile and allow a clean publish.
export function notifyWatcherReady(vault) {
  getWebCatalogRuntime(vault)?.setCoverage(true, "watcher-ready");
}

// Last watcher subscriber left: coverage is now a gap (bumps the fence).
export function notifyWatcherClosed(vaultId) {
  getWebCatalogRuntimeById(vaultId)?.setCoverage(false, "watcher-closed");
}

/** Test seams — not part of the production API. */
export function __setWebCatalogRuntimeFactoryForTests(factory) {
  runtimeFactory = factory ?? createDefaultRuntime;
}

export function __resetWebCatalogRuntimesForTests() {
  for (const runtime of runtimes.values()) {
    try {
      runtime.close();
    } catch {
      // ignore
    }
  }
  runtimes.clear();
  runtimeFactory = createDefaultRuntime;
}
