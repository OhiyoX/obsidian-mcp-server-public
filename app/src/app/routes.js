import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { withRequestContext } from "../request-context.js";
import {
  assertWritable,
} from "../vault.js";
import { appPage, loginPage, publishPage } from "./pages.js";
import { publicPublishMarkdown } from "./publish-markdown.js";
import { attachmentHeaders, resolveWebAttachment } from "./attachments.js";
import { listWebThemes, publicThemeRecord, readWebAppearance, readWebThemeCss, resolveWebThemeAsset } from "./themes.js";
import { createWebVault, defaultWebVaultId, listWebNotes, listWebVaults, readWebNote, resolveWebNoteLink, resolveWebVault, resolveWebVaultPath, statWebNote, writeWebBasePatch, writeWebNote } from "./vault-registry.js";
import { openVaultEventStream, publishWebMutation } from "./live-events.js";
import { createWebSessionManager, createWebSessionStore } from "./web-session-store.js";
import { decodeDocumentRoute, encodeDocumentRoute, publishService as defaultPublishService } from "../publish/service.js";
import { PublishTargetError, UNSUPPORTED_PUBLISH_TARGET, isMarkdownTargetPath, normalizePublishTarget } from "../publish/target.js";
import { vaultLayout, workspacePathForLegacy } from "../vault-layout.js";
import { classifyWebApiError } from "./web-api-error.js";
import { createWebAccessPolicy, webWriteRouteGate } from "./access-policy.js";
import { loginAppearance, registerAuthRoutes, safeNext } from "./auth-routes.js";
import { registerTreeRoute } from "./web-catalog/tree-route.js";
import { registerSearchRoute } from "./web-catalog/search-route.js";
import { extractPublishFilter, resolvePublishedPaths } from "./web-catalog/search-api.js";
import { getRouteMetrics } from "./route-metrics.js";
import { registerBaseRoute } from "./base-route.js";
import { registerBasePatchRoute } from "./base-patch-route.js";
import { registerBasePageRoute } from "./base-page.js";
import { registerCanvasRoute } from "./canvas-route.js";
import { registerCanvasPageRoute } from "./canvas-page.js";
import { readBaseInRoot } from "./base-reader.js";
import { loadRecords } from "./base-record-source.js";
import { createBaseSnapshotEvaluator } from "./base-snapshot-adapter.js";
import { registerNoteContextRoute } from "./note-context.js";
import { registerTagsRoute } from "./tags-route.js";
import { registerAssetRoute } from "./asset-route.js";
import { createWebFolder } from "./web-folders.js";
import { createImmutableAssetHandler } from "./asset-encoding.js";
import { preconditionRequiredBody, readPrecondition } from "./web-precondition.js";

const MAX_EDITOR_BYTES = 2 * 1024 * 1024;
const ASSETS = fileURLToPath(new URL("./assets/", import.meta.url));

const source = (req) => String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 80);

// Headers every Web route shares, cache policy excluded (assets keep them too).
function applySecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// Session/HTML/API/publish responses are per-user and must never be stored.
function securityHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  applySecurityHeaders(res);
  next();
}

// `/app/assets/*` is content-addressed by `pages.js` (`?v=<sha256>`), so it needs
// the opposite cache policy and must be registered *before* `securityHeaders`:
// `send` only writes the static mount's `immutable`/`max-age` when the header is
// still unset, so a preceding `no-store` silently won and every asset was
// re-fetched on every load (#414). Asset responses keep the same non-cache
// security headers, including `nosniff`.
function assetSecurityHeaders(_req, res, next) {
  applySecurityHeaders(res);
  next();
}

export function createWebAppRouter({ provider, secureCookie = true, publishService = defaultPublishService, resolveOrigin, webSessionStore, routeMetrics: injectedRouteMetrics, accessRuntime }) {
  const router = express.Router();
  const store = webSessionStore || createWebSessionStore({ file: null });
  const manager = createWebSessionManager({ store, provider, nextTarget: (req) => safeNext(req.originalUrl) });
  const currentSession = (req) => manager.currentSession(req);
  const requirePage = manager.requirePage;
  const requireApi = manager.requireApi;
  const requireCsrf = manager.requireCsrf;

  // AuthZ Wave C thin wiring (INTERFACE §10.3): the temporal gate always runs
  // after session resolution and before any Vault/catalog/loader work. A
  // disabled runtime allows everything, so a caller that injects a runtime gets
  // the real gates while an omitted runtime keeps the exact legacy middleware
  // chain via `passThrough` (zero behaviour difference, no extra branches at
  // the call sites).
  const policy = accessRuntime ? createWebAccessPolicy({ runtime: accessRuntime }) : null;
  const passThrough = (_req, _res, next) => next();
  const gate = (fn) => (policy && fn ? fn : passThrough);
  const readGate = gate(policy?.requireWebRead);
  const filesGate = gate(policy?.requireWebFiles);
  // #625: every Web write route resolves its gate through the frozen per-route
  // needs table (`WEB_WRITE_ROUTE_NEEDS`, access-policy.js). A route that is not
  // in that table is refused here — before the handler — instead of passing
  // through, so a new write route must be registered to work at all.
  const writeRouteGate = (routeKey) => webWriteRouteGate(policy, routeKey);

  // Asset branch first: gzip + immutable cache policy (asset-encoding.js), with
  // the plain static mount kept behind it as the 404/directory/unknown-type path.
  const assetHandler = createImmutableAssetHandler({ root: ASSETS });
  router.use("/app/assets", assetSecurityHeaders, assetHandler);
  router.use("/app/assets", express.static(ASSETS, { fallthrough: false, immutable: true, maxAge: "1y" }));
  router.use(["/app", "/auth", "/api/web/v1", "/api/web/v2", "/publish"], securityHeaders);
  router.use("/auth", express.urlencoded({ extended: false, limit: "16kb" }));

  registerAuthRoutes(router, { provider, store, requirePage, currentSession, secureCookie, source });

  router.get(["/app", "/app/"], requirePage, async (req, res, next) => {
    try {
      let appearance = { themeId: null, colorMode: "system" };
      try {
        const vault = await resolveWebVault(req.webSession.vaultId);
        appearance = await readWebAppearance(vault.root);
      } catch {
        appearance = await loginAppearance();
      }
      res.send(appPage(req.webSession, appearance));
    } catch (error) {
      next(error);
    }
  });

  router.get("/app/note/*", requirePage, readGate, async (req, res, next) => {
    try {
      const route = req.params[0];
      let target;
      let readablePath = false;
      try {
        target = decodeDocumentRoute(route);
      } catch (error) {
        if (!/Invalid document route/.test(error?.message || "")) throw error;
        target = { vaultId: defaultWebVaultId(), path: route };
        readablePath = true;
      }
      if (!req.webSession.allowedVaults.includes(target.vaultId)) return res.sendStatus(404);
      const vault = await resolveWebVault(target.vaultId);
      if (vault.id !== target.vaultId) return res.sendStatus(404);
      const migratedPath = vault.primary && vaultLayout.workspaceRoot
        ? workspacePathForLegacy(target.path)
        : null;
      if (migratedPath) {
        try {
          await statWebNote(vault, migratedPath);
          return res.redirect(302, `/app/note/${encodeDocumentRoute(vault.id, migratedPath)}`);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      const note = await statWebNote(vault, target.path);
      if (readablePath) return res.redirect(302, `/app/note/${encodeDocumentRoute(vault.id, note.path)}`);
      manager.noteSelection(req, vault.id);
      const appearance = await readWebAppearance(vault.root).catch(() => ({ themeId: null, colorMode: "system" }));
      res.send(appPage(req.webSession, appearance, { vaultId: vault.id, path: note.path }));
    } catch (error) {
      if (error?.code === "ENOENT" || /Invalid document route|Invalid Vault path|Path traversal denied|Symbolic link escapes/.test(error?.message || "")) return res.sendStatus(404);
      next(error);
    }
  });

  // Read-only Base document page (mirrors /app/note/*): the workspace shell that
  // exposes `initial-base-path` + `#base-host` for the Web Base surface. Extracted
  // to base-page.js so this router stays under the architecture line cap.
  registerBasePageRoute(router, { requirePage: [requirePage, readGate], manager });

  // Read-only Canvas document page (G11): the workspace shell with
  // `initial-canvas-path` + `#canvas-host`, and the on-demand canvas asset the
  // asset itself gates on. 404 on anything that is not a `.canvas` file.
  registerCanvasPageRoute(router, { requirePage: [requirePage, readGate], manager });

  router.get("/publish/:id", async (req, res, next) => {
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(String(req.params.id || ""))) return res.sendStatus(404);
      const published = await publishService.resolve(req.params.id);
      if (!published) return res.sendStatus(404);
      const title = path.posix.basename(published.record.path, ".md") || "Published note";
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
      res.send(publishPage({ title, content: publicPublishMarkdown(published.note.content), publishedAt: published.record.createdAt }));
    } catch (error) {
      next(error);
    }
  });
  router.get("/api/web/v1/session", requireApi, (req, res) => res.json({ username: req.webSession.username, displayName: req.webSession.displayName, scopes: req.webSession.allowedScopes, vaultId: req.webSession.vaultId, allowedVaults: req.webSession.allowedVaults }));

  async function currentVault(req) {
    if (!req.webSession.allowedVaults.includes(req.webSession.vaultId)) throw new Error("Vault access denied");
    const vault = await resolveWebVault(req.webSession.vaultId);
    if (!req.webSession.allowedVaults.includes(vault.id)) throw new Error("Vault access denied");
    return vault;
  }

  // Phase 2A-2: authenticated v2 Tree route (always registered; auth before catalog).
  // Registered before registerTreeRoute so the shared `/api/web/v2` error handler
  // (added at the end of the tree registration) also covers this route.
  const routeMetrics = injectedRouteMetrics || getRouteMetrics();
  registerSearchRoute(router, { requireApi: [requireApi, readGate], currentVault, metrics: routeMetrics, publishService });
  registerTreeRoute(router, { requireApi: [requireApi, readGate], currentVault, metrics: routeMetrics });

  // Web Base API (frozen A3 contract): real per-Vault Catalog record source + the
  // canonical A1 evaluator. GET-only; auth runs before any Vault/catalog access.
  // Registered before the shared `/api/web/v1` error handler below.
  //
  // A1's queryBaseSnapshot returns `view` as the selected view *name* (MCP parity)
  // while the frozen A3 evaluateSnapshot contract expects `{ name, type }`; and the
  // Web transport `limit` must be clamped to the view's semantic limit (Wave C
  // bounded prefix). Both bridges live in base-snapshot-adapter.js.
  registerBaseRoute(router, {
    requireApi: [requireApi, readGate],
    currentVault,
    readBase: readBaseInRoot,
    loadRecords,
    evaluateSnapshot: createBaseSnapshotEvaluator(),
  });

  // Web Base write surface (A4b): the raw-`content` read view + `PATCH /api/web/v1/base`
  // (A4a increments). Same write pipeline as `POST /api/web/v1/note`; registered before
  // the shared `/api/web/v1` error handler below so unknown errors keep its mapping.
  registerBasePatchRoute(router, {
    requireApi,
    readGate,
    requireCsrf,
    writeGate: writeRouteGate("PATCH /api/web/v1/base"),
    currentVault,
    provider,
    source,
    readBase: readBaseInRoot,
    writeBasePatch: writeWebBasePatch,
    publishMutation: publishWebMutation,
  });

  // Web Canvas API (G11 minimal face): GET-only, root-scoped safe read reused
  // from base-reader.js, no catalog/index dependency (single-file read).
  registerCanvasRoute(router, { requireApi: [requireApi, readGate], currentVault });

  // Note context (sidebar Phase 2): read-only outgoing links for the current note.
  registerNoteContextRoute(router, { requireApi: [requireApi, readGate], currentVault });
  registerTagsRoute(router, { requireApi: [requireApi, readGate], currentVault });
  registerAssetRoute(router, { requireApi, requireCsrf, currentVault, writeGate: writeRouteGate("POST /api/web/v1/asset"), provider, source });

  router.get("/api/web/v1/vaults", requireApi, readGate, async (req, res, next) => {
    try {
      const inventory = await listWebVaults();
      const vaults = inventory.vaults.filter((item) => req.webSession.allowedVaults.includes(item.id)).map(({ root: _root, ...item }) => item);
      res.json({ vaults, current: req.webSession.vaultId, canCreate: inventory.canCreate && req.webSession.allowedScopes.includes("obsidian.write") });
    } catch (error) { next(error); }
  });

  router.post("/api/web/v1/vault/select", express.json({ limit: "8kb" }), requireApi, requireCsrf, async (req, res, next) => {
    try {
      const id = String(req.body?.id || "");
      if (!req.webSession.allowedVaults.includes(id)) return res.status(403).json({ error: "Vault access denied" });
      await resolveWebVault(id);
      const selected = await manager.selectVault(req, id);
      if (!selected.ok) return res.status(503).json({ error: "Session persistence unavailable" });
      provider.recordAudit({ action: "web.vault.select", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: id });
      res.json({ current: id });
    } catch (error) { next(error); }
  });

  router.post("/api/web/v1/vault", express.json({ limit: "8kb" }), requireApi, requireCsrf, writeRouteGate("POST /api/web/v1/vault"), async (req, res, next) => {
    try {
      if (!req.webSession.allowedScopes.includes("obsidian.write")) return res.status(403).json({ error: "Account does not have write permission" });
      const vault = await createWebVault(req.body?.name);
      const allowedVaults = [...new Set([...req.webSession.allowedVaults, vault.id])];
      const updated = await provider.updateOAuthUser(req.webSession.userId, { allowedVaults, revokeGrants: false });
      const persisted = await manager.createVaultUpdate(req, { vaultId: vault.id, userUpdatedAt: updated.user.updatedAt });
      if (!persisted.ok) return res.status(503).json({ error: "Session persistence unavailable" });
      provider.recordAudit({ action: "web.vault.create", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: vault.id });
      res.json({ id: vault.id, name: vault.name, current: vault.id });
    } catch (error) { next(error); }
  });

  router.get("/api/web/v1/notes", requireApi, readGate, async (req, res, next) => {
    try {
      const query = String(req.query.q || "").trim().slice(0, 1000);
      const semantic = ["1", "true"].includes(String(req.query.semantic || "").toLocaleLowerCase());
      const caseSensitive = ["1", "true"].includes(String(req.query.caseSensitive || "").toLocaleLowerCase());
      const vault = await currentVault(req);
      // The deprecation gate: authenticated first-party v1 notes usage. If the evidence
      // cannot be recorded, this compatibility request must NOT look like a normal
      // success -- otherwise a broken evidence store would read as a clean zero and the
      // 7-day window could never be trusted. (The alternative would be an independent
      // durable ops channel; this keeps the guarantee self-contained.)
      if (!routeMetrics.count("web.v1.notes.requests")) {
        // The attempt is still real usage by a valid client; record it in the
        // independent ops channel before refusing, because this file is what is broken.
        routeMetrics.markUnrecordedAttempt("web.v1.notes.requests");
        return res.status(503).json({ error: "evidence-unavailable" });
      }
      // Same control alias and same single-source candidate set as the v2 route (§9):
      // the parse lives in `extractPublishFilter`, the path set only in
      // `resolvePublishedPaths`, so the two surfaces cannot drift apart.
      const { query: searchQuery, published } = extractPublishFilter(query);
      let pathFilter = null;
      if (published !== null) {
        const paths = await resolvePublishedPaths(publishService, vault.id);
        pathFilter = (item) => paths.has(item.path) === published;
      }
      const result = await listWebNotes(vault, searchQuery, { semantic, caseSensitive, pathFilter });
      result.query = query;
      res.json(result);
    } catch (error) {
      if (error?.code === "INVALID_SEARCH_QUERY") error.status = 400;
      next(error);
    }
  });

  router.get("/api/web/v1/events", requireApi, readGate, async (req, res, next) => {
    try {
      const vault = await currentVault(req);
      // Re-resolve the session on every heartbeat so a logout between ticks (not
      // just a window boundary) still closes the stream; the gate returns null
      // to close it, the legacy path returns the current session unchanged.
      const revalidate = policy
        ? async () => policy.revalidateWebRead(req, await currentSession(req))
        : () => currentSession(req);
      await openVaultEventStream({ req, res, session: req.webSession, vault, revalidate });
    } catch (error) { next(error); }
  });

  router.get("/api/web/v1/note", requireApi, readGate, async (req, res, next) => {
    try {
      const vault = await currentVault(req);
      const note = await readWebNote(vault, String(req.query.path || ""));
      const etag = `\"${note.revision}\"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, no-cache");
      if (req.get("If-None-Match") === etag) return res.status(304).end();
      res.json({
        ...note,
        vaultId: vault.id,
        route: `/app/note/${encodeDocumentRoute(vault.id, note.path)}`,
      });
    } catch (error) { next(error); }
  });

  router.get("/api/web/v1/link/resolve", requireApi, readGate, async (req, res, next) => {
    try {
      const vault = await currentVault(req);
      const sourcePath = String(req.query.source || "");
      const target = String(req.query.target || "");
      const resolved = await resolveWebNoteLink(vault, sourcePath, target);
      res.json({
        ...resolved,
        vaultId: vault.id,
        route: resolved.path ? `/app/note/${encodeDocumentRoute(vault.id, resolved.path)}` : null,
      });
    } catch (error) { next(error); }
  });

  function requestOrigin(req) {
    if (typeof resolveOrigin === "function") return resolveOrigin(req);
    return `${req.protocol}://${req.get("host")}`;
  }

  function publishPayload(req, vault, note, record) {
    const privatePath = `/app/note/${encodeDocumentRoute(vault.id, note.path)}`;
    const publicPath = record ? `/publish/${record.id}` : null;
    const origin = String(requestOrigin(req)).replace(/\/+$/, "");
    return {
      vaultId: vault.id,
      path: note.path,
      privatePath,
      privateUrl: `${origin}${privatePath}`,
      published: Boolean(record),
      publicPath,
      publicUrl: publicPath ? `${origin}${publicPath}` : null,
      publishedAt: record?.createdAt || null,
    };
  }

  router.get("/api/web/v1/publish", requireApi, readGate, async (req, res, next) => {
    try {
      const { vault, note, record } = await publishService.status(req.webSession.vaultId, String(req.query.path || ""));
      if (!req.webSession.allowedVaults.includes(vault.id)) return res.status(403).json({ error: "Vault access denied" });
      res.json(publishPayload(req, vault, note, record));
    } catch (error) {
      if (error?.code === "ENOENT" || /Invalid Vault path|Path traversal denied|Symbolic link escapes/i.test(error?.message || "")) {
        return res.status(404).json({ error: "Not found" });
      }
      next(error);
    }
  });

  router.post("/api/web/v1/publish", express.json({ limit: "8kb" }), requireApi, requireCsrf, writeRouteGate("POST /api/web/v1/publish"), async (req, res, next) => {
    try {
      if (!req.webSession.allowedScopes.includes("obsidian.write")) return res.status(403).json({ error: "Account does not have write permission" });
      const vault = await currentVault(req);
      const action = String(req.body?.action || "publish");
      if (!['publish', 'revoke'].includes(action)) return res.status(400).json({ error: "Unsupported publish action" });
      const requestedPath = String(req.body?.path || "");
      const actor = `web:${req.webSession.username}`;
      if (action === "revoke") {
        // §7 / §15 S02: the *service* revoke stays target-type-agnostic so an Admin can clear a
        // historical non-Markdown record, so the Web input layer refuses a non-Markdown revoke
        // itself — after canonicalizing with `allowMissing` (a missing file is not an error) and
        // keeping the Vault containment rule enforced.
        const target = await normalizePublishTarget(requestedPath, {
          resolvePath: (requested, options) => resolveWebVaultPath(vault, requested, { ...options, allowMissing: true }),
        });
        if (!isMarkdownTargetPath(target.path)) {
          throw new PublishTargetError(UNSUPPORTED_PUBLISH_TARGET, `Publish target must be a Markdown (.md) file: ${target.path}`, { path: target.path });
        }
        const revoked = await publishService.revoke(vault.id, requestedPath);
        provider.recordAudit({ action: "web.publish.revoke", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: `${vault.id}:${target.path}` });
        // #277: never re-stat the target after the mutation — revoking an orphaned or never
        // published path is a structured 200 (§7), not an ENOENT/404.
        return res.json({ ...publishPayload(req, vault, { path: target.path }, null), changed: revoked.revoked, revoked: revoked.revoked });
      }
      const result = await publishService.publish(vault.id, requestedPath, { actor });
      const status = await publishService.status(vault.id, requestedPath);
      provider.recordAudit({ action: "web.publish.publish", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: `${vault.id}:${status.note.path}` });
      res.json({ ...publishPayload(req, status.vault, status.note, status.record), changed: result.created });
    } catch (error) { next(error); }
  });

  router.get("/api/web/v1/themes", requireApi, readGate, async (req, res, next) => {
    try {
      const vault = await currentVault(req);
      const themes = (await listWebThemes(vault.root)).map(publicThemeRecord);
      const appearance = await readWebAppearance(vault.root);
      res.json({ themes, appearance, defaultTheme: appearance.themeId });
    } catch (error) { next(error); }
  });

  router.get("/api/web/v1/theme.css", requireApi, readGate, async (req, res, next) => {
    try {
      const { theme, css } = await readWebThemeCss(req.query.name, (await currentVault(req)).root);
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("X-Obsidian-Theme", encodeURIComponent(theme.id));
      res.type("text/css").send(css);
    } catch (error) {
      if (error?.code === "ENOENT") return res.sendStatus(404);
      next(error);
    }
  });

  router.get("/api/web/v1/theme-asset", requireApi, readGate, async (req, res, next) => {
    try {
      const asset = await resolveWebThemeAsset(req.query.name, req.query.path, (await currentVault(req)).root);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(asset.absolute);
    } catch (error) {
      if (error?.code === "ENOENT") return res.sendStatus(404);
      next(error);
    }
  });

  router.get("/api/web/v1/asset", requireApi, filesGate, async (req, res, next) => {
    try {
      if (!req.webSession.allowedScopes.includes("obsidian.files")) return res.status(403).json({ error: "Account does not have file permission" });
      const attachment = await resolveWebAttachment(req.query.path, req.query.from, (await currentVault(req)).root);
      provider.recordAudit({ action: "web.attachment.read", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: attachment.path });
      res.sendFile(attachment.absolute, { headers: attachmentHeaders(attachment) });
    } catch (error) {
      if (error?.code === "ENOENT") return res.sendStatus(404);
      next(error);
    }
  });

  router.post("/api/web/v1/note", express.json({ limit: `${MAX_EDITOR_BYTES}b` }), requireApi, requireCsrf, writeRouteGate("POST /api/web/v1/note"), async (req, res, next) => {
    try {
      if (!req.webSession.allowedScopes.includes("obsidian.write")) return res.status(403).json({ error: "Account does not have write permission" });
      assertWritable();
      const content = String(req.body?.content ?? "");
      if (Buffer.byteLength(content) > MAX_EDITOR_BYTES) return res.status(413).json({ error: "Note exceeds the Web editor limit" });
      const vault = await currentVault(req);
      // #624: the *shared* precondition reader — the `If-Match` header wins over the
      // body's `ifMatch`, quoted/W-prefixed tokens are unwrapped — instead of reading
      // `req.body.ifMatch` here, so both write faces accept exactly the same token.
      const ifMatch = readPrecondition(req);
      const result = await withRequestContext({ author: { agent: "obsidian-web", model: `human:${req.webSession.username}` } }, () => writeWebNote(vault, String(req.body?.path || ""), content, ifMatch));
      // Watchers start with SSE subscribers; mutation publish alone must not leave orphan watchers.
      const mutationId = String(req.body?.mutationId || "web").slice(0, 120);
      publishWebMutation({
        vaultId: vault.id,
        path: result.path,
        created: result.created,
        revision: result.revision,
        size: result.size,
        origin: "web",
        mutationId,
      });
      provider.recordAudit({ action: result.created ? "web.note.create" : "web.note.update", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: `${vault.id}:${result.path}` });
      res.json(result);
    } catch (error) {
      // #624 one table for both write faces (§4.1 of the write-surface design):
      //   missing precondition + existing target -> 428 `precondition-required`, the same
      //     body `PATCH /api/web/v1/base` sends (shared `preconditionRequiredBody`);
      //   precondition that does not match      -> 409, still `Revision conflict`, now
      //     stating the revision that is actually on disk so a client can retry.
      // The domain decides which row applies (only it knows whether the target exists).
      if (error?.code === "WEB_NOTE_PRECONDITION_REQUIRED") {
        return res.status(428).json(preconditionRequiredBody("POST /api/web/v1/note", "existing note requires a precondition"));
      }
      if (/Revision conflict/.test(error.message)) {
        return res.status(409).json({
          error: "Revision conflict",
          code: error.code ?? "WEB_NOTE_REVISION_CONFLICT",
          expectedRevision: error.expectedRevision ?? null,
          currentRevision: error.currentRevision ?? null,
        });
      }
      next(error);
    }
  });

  // U6: Web folder create. Same write pipeline as the note route (auth -> CSRF ->
  // write gate -> obsidian.write scope -> assertWritable -> audit); 409 on an
  // existing folder, 400 on an invalid/absolute/hidden/excluded path.
  router.post("/api/web/v1/folder", express.json({ limit: "8kb" }), requireApi, requireCsrf, writeRouteGate("POST /api/web/v1/folder"), async (req, res, next) => {
    try {
      if (!req.webSession.allowedScopes.includes("obsidian.write")) return res.status(403).json({ error: "Account does not have write permission" });
      const vault = await currentVault(req);
      const result = await createWebFolder(vault, req.body?.path);
      provider.recordAudit({ action: "web.folder.create", credentialType: "web-session", credentialId: req.webSession.userId, source: source(req), detail: `${vault.id}:${result.path}` });
      res.status(201).json(result);
    } catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      if (/read-only/i.test(error?.message || "")) return res.status(403).json({ error: "Server is read-only" });
      next(error);
    }
  });

  router.use("/api/web/v1", (error, _req, res, _next) => {
    const response = classifyWebApiError(error);
    if (response.status >= 500) console.error("Obsidian Web API error:", error);
    // `code` is present only for the classified domain errors (e.g. the frozen publish
    // target codes); every other response keeps the historical `{ error }`-only shape.
    res.status(response.status).json(response.code ? { error: response.error, code: response.code } : { error: response.error });
  });

  router.use(["/app", "/auth", "/publish"], (error, _req, res, _next) => {
    console.error("Obsidian Web error:", error);
    res.status(400).send(loginPage("请求无法完成。", { colorMode: "system" }));
  });

  return router;
}
