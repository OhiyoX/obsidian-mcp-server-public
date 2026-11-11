// P0 / Task 1 — derive the real boundary inventory from `src`.
//
// The manifest is only worth pinning if it cannot silently miss an entry point, so this module
// asks the shipped code instead of a hand-kept list: the three Express routers are built with
// inert dependencies and their registered routes are read back from Express, the canonical tool
// list comes from `src/config.js`, and the resource URIs come from registering `src/resources.js`
// against a capture server. No request is served and no service method is called.
//
// Scope: `src/` owns the tool, resource, Web, upload and Admin registrars. The process shell in
// `app/server.js` (`GET /`, `GET /healthz`, `POST /mcp`, CORS preflight) is not derived here: the
// MCP boundary is its tools and resources, which are.
//
// No exception list: every boundary derived from `src` is a manifest row. A boundary that is truly
// unreachable would be a defect to fix in `src`, not a row to silence.

/** Inert dependencies: the routers must be built, but nothing here is ever called. */
function providerStub() {
  return {
    ready: Promise.resolve(),
    authenticateOAuthUser: async () => null,
    oauthUserSessionRecord: async () => null,
    recordAudit: () => {},
  };
}

/**
 * Every route key of a router, INCLUDING the routes of a mounted sub-router.
 *
 * Express does not store the mount path as a string, so `withMountTracking` records each
 * `router.use(path, subRouter)` while the routers are built and this walk reads that map back.
 * Without it, a route on a mounted sub-router is invisible — the hole the review's control found.
 */
export function routeKeysOf(router, { prefix = "", pathPrefix = "", mounts = new WeakMap() } = {}) {
  const keys = [];
  for (const layer of router.stack || []) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map((method) => (method === "_all" ? "*" : method.toUpperCase()));
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) for (const method of methods) keys.push(`${prefix}${method} ${pathPrefix}${path}`);
      continue;
    }
    const mount = (mounts.get(router) ?? []).find((entry) => entry.sub === layer.handle);
    if (mount) keys.push(...routeKeysOf(mount.sub, { prefix, pathPrefix: `${pathPrefix}${mount.prefix}`, mounts }));
  }
  return keys;
}

/**
 * Run `build` with `Router.prototype.use` instrumented, and record every mounted sub-router with
 * its mount prefix. The prototype is restored before this returns; nothing outside the callback
 * sees the patch.
 */
export function withMountTracking(build) {
  // Express 4 sets every router's PROTOTYPE to `Router` itself (`setPrototypeOf(router, proto)`), so
  // the method to patch lives on `express.Router`, not on `express.Router.prototype`.
  const proto = express.Router;
  const originalUse = proto.use;
  const mounts = new WeakMap();
  proto.use = function trackedUse(pathOrHandler, ...rest) {
    const result = originalUse.call(this, pathOrHandler, ...rest);
    const prefix = typeof pathOrHandler === "string" ? pathOrHandler.replace(/\/+$/, "") : "";
    for (const candidate of [pathOrHandler, ...rest]) {
      if (typeof candidate === "function" && Array.isArray(candidate.stack)) {
        const list = mounts.get(this) ?? [];
        list.push({ prefix, sub: candidate });
        mounts.set(this, list);
      }
    }
    return result;
  };
  try {
    return build(mounts);
  } finally {
    proto.use = originalUse;
  }
}

/**
 * The OAuth protocol endpoints. `server.js` mounts the SDK auth router at `/oauth` and serves the
 * approval form itself, so no `src` router registration exists for them; they are listed here once
 * and compared with the manifest like every other boundary.
 */
export const OAUTH_BOUNDARIES = Object.freeze([
  "GET /oauth/authorize",
  "POST /oauth/decision",
  "POST /oauth/token",
  "POST /oauth/register",
  "POST /oauth/revoke",
]);

const kindOf = (id) => {
  if (/^[A-Z]+ \/oauth\//.test(id)) return "oauth-endpoint";
  if (/^ADMIN /.test(id)) return "admin-action";
  // Any method on the upload data plane, whoever adds it later.
  if (/^[A-Z*]+ \/uploads\//.test(id)) return "direct-upload";
  return "web-route";
};

/**
 * Every boundary `src` registers, as `{ kind, id }`:
 *   tool            the canonical MCP tool name
 *   resource        the MCP resource URI
 *   web-route       `<METHOD> <path>` on the Web router
 *   direct-upload   `<METHOD> <path>` on the upload data plane
 *   admin-action    `ADMIN <METHOD> <path>` on the Admin router (mounted at `/admin/auth`)
 */
import express from "express";

export async function deriveBoundaryEntries() {
  const [
    { createWebAppRouter },
    { createAdminRouter },
    { createDirectUploadRouter },
    { createWebSessionStore },
    { registerResources },
    { TOOL_NAMES },
  ] = await Promise.all([
    import("../../src/app/routes.js"),
    import("../../src/admin/router.js"),
    import("../../src/direct-upload.js"),
    import("../../src/app/web-session-store.js"),
    import("../../src/resources.js"),
    import("../../src/config.js"),
  ]);

  const provider = providerStub();
  const { webRouter, uploadRouter, adminRouter, mounts } = withMountTracking((mounts) => {
    const web = createWebAppRouter({ provider, secureCookie: false, webSessionStore: createWebSessionStore({ file: null }) });
    const upload = createDirectUploadRouter({ auth: (_req, _res, next) => next() });
    // The Admin surface only registers the permission editor and the Vault/Git tab when the services
    // exist (`server.js` always builds them), so inert truthy services are enough to see those routes.
    const admin = createAdminRouter({ provider, adminPassword: "not-used", secureCookie: false, accessPolicyAdmin: {}, vaultGitAdmin: {}, vaultGitStore: {} });
    return { webRouter: web, uploadRouter: upload, adminRouter: admin, mounts };
  });

  const resourceUris = [];
  registerResources({ registerResource: (_name, uri) => resourceUris.push(uri) });

  const entries = [
    ...OAUTH_BOUNDARIES.map((id) => ({ kind: "oauth-endpoint", id })),
    ...TOOL_NAMES.map((id) => ({ kind: "tool", id })),
    ...resourceUris.map((id) => ({ kind: "resource", id })),
    ...routeKeysOf(webRouter, { mounts }).map((id) => ({ kind: kindOf(id), id })),
    ...routeKeysOf(uploadRouter, { mounts }).map((id) => ({ kind: kindOf(id), id })),
    ...routeKeysOf(adminRouter, { prefix: "ADMIN ", mounts }).map((id) => ({ kind: kindOf(id), id })),
  ].sort((left, right) => `${left.kind}|${left.id}`.localeCompare(`${right.kind}|${right.id}`));

  const counts = {};
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return { entries, counts, resourceUris };
}
