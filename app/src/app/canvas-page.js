// Registers the read-only Canvas document page: GET /app/canvas/<encoded-document-route> (G11).
//
// Mirrors base-page.js exactly: decode the document route, enforce
// session.allowedVaults before any Vault access, resolve the current Vault, then
// 404 on an unknown / non-`.canvas` / traversal / escaping path.
//
// Why a page of its own instead of a route inside /app: the client bundle that
// owns the workspace shell (app.js) is inside the first-screen byte ratchet, and
// this lane may not raise it (RECON §6 刀2). A canvas document page therefore
// publishes the on-demand canvas asset itself, exactly like the Publish page
// publishes publish.js: a document that is not a canvas never references the
// asset, and opening one costs exactly one canvas.js request. The page contract
// the asset reads is `initial-canvas-path` / `initial-canvas-vault` (the same
// shape `initial-base-*` uses) plus the visible `#canvas-host` in `.document`.
import fs from "node:fs/promises";
import path from "node:path";
import { decodeDocumentRoute, encodeDocumentRoute } from "../publish/service.js";
import { appPage } from "./pages.js";
import { readWebAppearance } from "./themes.js";
import { defaultWebVaultId, resolveWebVault, resolveWebVaultPath } from "./vault-registry.js";

function invalidCanvasPagePath() {
  return Object.assign(new Error("Invalid Vault path"), { code: "INVALID_CANVAS_PAGE_PATH" });
}

// Stat-only existence check, mirroring statBaseFile's containment semantics: the
// canonical containment is resolveWebVaultPath, then a real `.canvas` file. The
// stricter canvas reader still guards the API route (and this page must not be a
// second, weaker path check).
async function statCanvasFile(vault, userPath) {
  const resolved = await resolveWebVaultPath(vault, userPath);
  if (path.posix.extname(resolved.path).toLowerCase() !== ".canvas") throw invalidCanvasPagePath();
  const stat = await fs.stat(resolved.absolute);
  if (!stat.isFile()) throw invalidCanvasPagePath();
  return { path: resolved.path, stat: { size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() } };
}

export function registerCanvasPageRoute(router, { requirePage, manager }) {
  router.get("/app/canvas/*", requirePage, async (req, res, next) => {
    try {
      const route = req.params[0];
      let target;
      let readablePath = false;
      try {
        target = decodeDocumentRoute(route);
      } catch (error) {
        if (!/Invalid document route/.test(error?.message || "")) throw error;
        // A bare path is only a redirect candidate; it is never treated as an
        // authorized route until the Vault allowlist and file checks pass.
        target = { vaultId: defaultWebVaultId(), path: route };
        readablePath = true;
      }
      if (!req.webSession.allowedVaults.includes(target.vaultId)) return res.sendStatus(404);
      const vault = await resolveWebVault(target.vaultId);
      if (vault.id !== target.vaultId) return res.sendStatus(404);
      const canvas = await statCanvasFile(vault, target.path);
      if (readablePath) return res.redirect(302, `/app/canvas/${encodeDocumentRoute(vault.id, canvas.path)}`);
      manager.noteSelection(req, vault.id);
      const appearance = await readWebAppearance(vault.root).catch(() => ({ themeId: null, colorMode: "system" }));
      res.send(appPage(req.webSession, appearance, null, null, { vaultId: vault.id, path: canvas.path }));
    } catch (error) {
      if (
        error?.code === "ENOENT" ||
        error?.code === "INVALID_CANVAS_PAGE_PATH" ||
        /Invalid document route|Invalid Vault path|Path traversal denied|Symbolic link escapes/.test(error?.message || "")
      ) {
        return res.sendStatus(404);
      }
      next(error);
    }
  });
}
