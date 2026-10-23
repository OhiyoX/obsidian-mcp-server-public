// Registers the read-only Base document page: GET /app/base/<encoded-document-route>.
//
// Wave B / B3. Mirrors the `/app/note/*` page contract (routes.js): decode the
// document route, enforce session.allowedVaults before any Vault access, resolve
// the current Vault, then 404 on an unknown / non-`.base` / traversal / escaping
// path. The shell is the normal workspace `appPage`, with the Base path exposed as
// `initial-base-path` meta and an empty `#base-host` inside `.document` for the
// frontend surface (B4) to mount.
//
// Extracted from routes.js so that file stays under the architecture line cap.
import fs from "node:fs/promises";
import path from "node:path";
import { decodeDocumentRoute, encodeDocumentRoute } from "../publish/service.js";
import { appPage } from "./pages.js";
import { readWebAppearance } from "./themes.js";
import { defaultWebVaultId, resolveWebVault, resolveWebVaultPath } from "./vault-registry.js";

function invalidBasePagePath() {
  return Object.assign(new Error("Invalid Vault path"), { code: "INVALID_BASE_PAGE_PATH" });
}

// Stat-only Base existence check, mirroring statWebNote's containment semantics
// without assuming Markdown: canonical containment via resolveWebVaultPath, then a
// real `.base` file. The stricter A3 Base reader still guards the API route.
async function statBaseFile(vault, userPath) {
  const resolved = await resolveWebVaultPath(vault, userPath);
  if (path.posix.extname(resolved.path).toLowerCase() !== ".base") throw invalidBasePagePath();
  const stat = await fs.stat(resolved.absolute);
  if (!stat.isFile()) throw invalidBasePagePath();
  return { path: resolved.path, stat: { size: stat.size, created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString() } };
}

export function registerBasePageRoute(router, { requirePage, manager }) {
  router.get("/app/base/*", requirePage, async (req, res, next) => {
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
      const base = await statBaseFile(vault, target.path);
      if (readablePath) return res.redirect(302, `/app/base/${encodeDocumentRoute(vault.id, base.path)}`);
      manager.noteSelection(req, vault.id);
      const appearance = await readWebAppearance(vault.root).catch(() => ({ themeId: null, colorMode: "system" }));
      res.send(appPage(req.webSession, appearance, null, { vaultId: vault.id, path: base.path }));
    } catch (error) {
      if (
        error?.code === "ENOENT" ||
        error?.code === "INVALID_BASE_PAGE_PATH" ||
        /Invalid document route|Invalid Vault path|Path traversal denied|Symbolic link escapes/.test(error?.message || "")
      ) {
        return res.sendStatus(404);
      }
      next(error);
    }
  });
}
