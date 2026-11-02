// Registers the authenticated v1 Tags route and its error contract.
//
// Auth/allowlist happen BEFORE any catalog access: currentVault() enforces
// allowedVaults and resolves the Vault, and only then does resolveTags() read the
// catalog runtime/store. WEB_CATALOG_ENABLED=false (or an unavailable runtime)
// returns 503 catalog-unavailable -- never a full Vault scan fallback.
//
// The shared `/api/web/v1` error handler lives at the end of routes.js and does not
// know the catalog contract codes, so this route maps WebCatalogHttpError itself.
import { getWebCatalogRuntime } from "./web-catalog/runtime.js";
import { WebCatalogHttpError } from "./web-catalog/tree-api.js";
import { resolveTags } from "./tags-api.js";

export function registerTagsRoute(router, { requireApi, currentVault }) {
  router.get("/api/web/v1/tags", requireApi, async (req, res, next) => {
    try {
      const vault = await currentVault(req);
      const payload = await resolveTags({ vault, query: req.query, getRuntime: getWebCatalogRuntime });
      res.setHeader("Cache-Control", "no-store");
      res.json(payload);
    } catch (error) {
      if (error instanceof WebCatalogHttpError) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(error.status).json({ error: error.code });
      }
      next(error);
    }
  });
}
