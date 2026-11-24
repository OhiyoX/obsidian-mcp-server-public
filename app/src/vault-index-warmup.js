// #476: the first search after a restart pays a cold Vault index build — 9.8 s for 1,048 notes
// on the production Vault (measured 2026-11-22, `primaryIndexRuntime.getVaultIndex()` twice in one
// process: cold 9,770 ms / warm 388 ms / warm 178 ms). That build is the same one the first search
// triggers anyway, so running it once in the background after startup only moves the cost off the
// request path. A failure is logged and leaves the index cold, exactly as before: warm-up must
// never change what a search does or make startup fail.

export async function warmVaultIndex({ index, log = console } = {}) {
  if (typeof index?.getVaultIndex !== "function") {
    throw new TypeError("warmVaultIndex requires an index runtime with getVaultIndex()");
  }
  try {
    const snapshot = await index.getVaultIndex();
    log.log(`[vault-index] warm-up: ${snapshot.stats.files} notes in ${snapshot.stats.durationMs} ms`);
    return snapshot;
  } catch (error) {
    log.error(`[vault-index] warm-up failed: ${error?.message ?? error}`);
    return null;
  }
}
