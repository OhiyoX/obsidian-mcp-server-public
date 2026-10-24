// Registers the authenticated v2 Search route.
//
// Auth/allowlist happen BEFORE any catalog access: currentVault() enforces
// allowedVaults and resolves the Vault, and only then does resolveSearchPage() read
// the catalog flag/runtime/store. WEB_CATALOG_ENABLED=false (or an unavailable
// runtime) returns 503 catalog-unavailable -- never a v1/full-scan fallback.
//
// The `/api/web/v2` error handler lives in tree-route.js and is registered after the
// v2 routes, so this route only registers its handler.
//
// `publishService` is the Publish registry used by the `published:` hard filter. It
// is injected by the router (the same instance the Publish status/action routes use)
// so the filter can never read a different source of truth than the UI toolbar.
import { getWebCatalogRuntime } from "./runtime.js";
import { resolveSearchPage } from "./search-api.js";

export function registerSearchRoute(router, { requireApi, currentVault, metrics = null, publishService = null }) {
  router.get("/api/web/v2/search", requireApi, async (req, res, next) => {
    try {
      const vault = await currentVault(req);
      metrics?.count("web.v2.search.requests");
      const payload = await resolveSearchPage({ vault, query: req.query, getRuntime: getWebCatalogRuntime, publishService });
      // Semantic outcomes are the evidence that Phase 3B stayed honest in production.
      if (payload.semantic.requested) {
        metrics?.count("web.v2.search.semantic.requested");
        if (payload.semantic.used) metrics?.count("web.v2.search.semantic.used");
        else metrics?.count("web.v2.search.semantic.degraded");
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
}
