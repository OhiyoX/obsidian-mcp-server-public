// The lazy Explorer tree transport: one tree-page fetch plus the bounded
// catalog-not-ready 503 retry. Extracted from `lazy-controller.js` for the line
// gate with no behaviour change; `pageUrl` is injected so the URL/SortSpec contract
// stays owned by the controller.

// First-reconcile readiness: a fresh catalog is not-ready until its initial
// reconcile publishes. Retry with bounded backoff; never for catalog-unavailable or
// generic 5xx.
export const READY_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

function isCatalogNotReady(error) {
  return (
    error?.status === 503 &&
    (error?.code === "catalog-not-ready" || error?.data?.error === "catalog-not-ready")
  );
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// `stillOwned()` is re-checked after every await, so a retired owner (sort change,
// invalidate, dispose, supersede) stops the chain instead of letting it "become" a
// request for the new spec.
export function createPageFetcher({ api, pageUrl, retryDelays = READY_RETRY_DELAYS_MS }) {
  return async function fetchPage(rel, { cursor, anchorPath, spec }, signal, stillOwned) {
    let attempt = 0;
    for (;;) {
      try {
        return await api(pageUrl({ parent: rel, cursor, anchorPath, spec }), { signal });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (!stillOwned()) throw Object.assign(new Error("stale request"), { name: "AbortError" });
        if (isCatalogNotReady(error) && attempt < retryDelays.length) {
          await sleep(retryDelays[attempt], signal);
          if (!stillOwned()) throw Object.assign(new Error("stale request"), { name: "AbortError" });
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  };
}
