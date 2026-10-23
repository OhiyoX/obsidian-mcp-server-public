// U30 contract A2/A3: `POST /api/web/v1/asset` — the Web editor's in-place image upload.
//
// Shape (frozen): raw body + `x-file-name: <percent-encoded UTF-8>` + optional
// `?from=<vault-relative note.md>`. No multipart (the repo has no multer; `express.raw` is
// native to the pinned express 4) and one file per request, so each image gets its own
// progress/retry/cancel and the front end keeps the multi-file order by uploading serially.
//
// Middleware order is raw -> requireApi -> requireCsrf -> write gate -> handler. CSRF must
// travel in the `X-CSRF-Token` header: `requireCsrf` reads `req.body.csrf` as a fallback,
// which a raw Buffer body cannot carry.
import express from "express";
import { WEB_ASSET_MAX_BYTES, WEB_ATTACHMENT_FOLDER } from "../config.js";
import { assertWritable } from "../vault.js";
import { writeWebAsset } from "./attachments.js";

const passThrough = (_req, _res, next) => next();

/** Builds the `<img src>`-ready URL; `from` lets the read route take its direct branch. */
function assetUrl(asset) {
  const query = new URLSearchParams({ path: asset.path });
  if (asset.from) query.set("from", asset.from);
  return `/api/web/v1/asset?${query}`;
}

export function registerAssetRoute(router, deps = {}) {
  const {
    requireApi,
    requireCsrf,
    currentVault,
    provider,
    writeGate = passThrough,
    source = () => "unknown",
  } = deps;

  router.post(
    "/api/web/v1/asset",
    express.raw({ limit: WEB_ASSET_MAX_BYTES, type: () => true }),
    requireApi,
    requireCsrf,
    writeGate,
    async (req, res, next) => {
      try {
        // Same write pipeline as `POST /api/web/v1/note`: scope -> read-only mode ->
        // Vault from the session -> audit. The Vault id is never taken from the body.
        if (!req.webSession.allowedScopes.includes("obsidian.write")) return res.status(403).json({ error: "Account does not have write permission" });
        assertWritable();
        const body = req.body;
        if (!Buffer.isBuffer(body)) return res.status(400).json({ error: "Invalid request body" });
        if (body.length > WEB_ASSET_MAX_BYTES) return res.status(413).json({ error: "Request body too large" });
        const vault = await currentVault(req);
        const asset = await writeWebAsset(vault, {
          fileName: req.get("x-file-name"),
          body,
          from: req.query.from,
          folder: WEB_ATTACHMENT_FOLDER,
        });
        provider?.recordAudit?.({
          action: "web.asset.create",
          credentialType: "web-session",
          credentialId: req.webSession.userId,
          source: source(req),
          detail: `${vault.id}:${asset.path}`,
        });
        res.status(201).json({
          vaultId: asset.vaultId,
          path: asset.path,
          revision: asset.revision,
          size: asset.size,
          contentType: asset.contentType,
          url: assetUrl(asset),
        });
      } catch (error) {
        // `writeWebAsset` classifies its own domain failures (400/409/415) with a `status`
        // and a path-free message; everything else (ENOENT for a missing `from`, the raw
        // parser's 413, symlink escapes) keeps the shared `classifyWebApiError` mapping.
        if (error?.status) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    },
  );
}
