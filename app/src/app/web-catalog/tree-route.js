// Registers the authenticated v2 Tree route and its error contract.
//
// Auth/allowlist happen BEFORE any catalog access: currentVault() enforces
// allowedVaults and resolves the Vault, and only then does resolveTreePage() read
// the catalog flag/runtime/store. WEB_CATALOG_ENABLED=false (or an unavailable
// runtime) returns 503 catalog-unavailable -- never a v1/full-scan fallback.
import { classifyWebApiError } from "../web-api-error.js";
import { getWebCatalogRuntime } from "./runtime.js";
import { WebCatalogHttpError, resolveTreePage } from "./tree-api.js";

export function registerTreeRoute(router, { requireApi, currentVault, metrics = null }) {
  router.get("/api/web/v2/tree", requireApi, async (req, res, next) => {
    try {
      const vault = await currentVault(req);
      // Counted after auth: this is authenticated first-party usage, not a scanner.
      metrics?.count("web.v2.tree.requests");
      const payload = await resolveTreePage({ vault, query: req.query, getRuntime: getWebCatalogRuntime });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.use("/api/web/v2", (error, _req, res, _next) => {
    if (error instanceof WebCatalogHttpError) {
      if (error.code === "catalog-not-ready") metrics?.count("web.v2.failure.catalog_not_ready");
      if (error.code === "cursor-stale") metrics?.count("web.v2.failure.cursor_stale");
      return res.status(error.status).json({ error: error.code });
    }
    const response = classifyWebApiError(error);
    if (response.status >= 500) console.error("Obsidian Web v2 API error:", error);
    res.status(response.status).json({ error: response.error });
  });
}
