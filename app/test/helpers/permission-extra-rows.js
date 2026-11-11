// P0 / Task 1 — the boundary rows Step B requires.
//
// Review Blocker 2: the manifest lists 177 boundaries and the baseline had rows for 122 of them.
// This module collects the rest (except the documented blocked list in the fixture test): the Web
// catalogs, Base and Canvas reads, the publish view, the Web Vault creation, and the whole Admin
// surface — the permission editor's five extra routes, the six Vault/Git routes, the credential
// writes, publish revoke and the audit exports.
//
// Rules these rows keep:
//   * a real session and real arguments (an Admin write carries its CSRF token and its
//     type-to-confirm text where the route demands one);
//   * a row that would destroy what a LATER row needs runs last, on throwaway records created here;
//   * a refused row must not have changed a byte (the collector enforces it).

const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const ZH = { "Accept-Language": "zh-CN" };

/** The zh-CN confirmation the Admin surface asks for (the plane sends no locale, so this is it). */
const CONFIRM = Object.freeze({ auditClear: "清空日志", gitRepair: "重置" });

const formBody = (fields) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) body.append(key, item);
    else body.set(key, String(value));
  }
  return body.toString();
};

/**
 * Web rows a Web session can reach: the Base and Canvas surfaces, the catalog reads, the publish
 * view and the Vault creation. `ctx.httpCase(actorCase, surface, capability, request, targetCase)`.
 */
export async function collectWebBoundaryRows(ctx) {
  const { httpCase, editor, reader, editorHeaders, readerHeaders, dataPath, provider } = ctx;
  const json = (csrf) => ({ "Content-Type": "application/json", "X-CSRF-Token": csrf });

  // --- public chrome (no session): the sign-in page, the theme CSS and its asset ---------------
  await httpCase("web:anonymous", "web", "GET /auth/login", { urlPath: "/auth/login" }, "vault:primary");
  await httpCase("web:anonymous", "web", "GET /auth/theme.css", { urlPath: "/auth/theme.css" }, "vault:primary");
  await httpCase("web:anonymous", "web", "GET /auth/theme-asset", { urlPath: "/auth/theme-asset?name=baseline-theme&path=font.woff2" }, "vault:primary");

  // --- pages ----------------------------------------------------------------------------------
  await httpCase("web:editor", "web", "GET /app/", { urlPath: "/app/", headers: editorHeaders }, "vault:primary");
  await httpCase("web:editor", "web", "GET /app/language", { urlPath: "/app/language?lang=en", headers: editorHeaders }, "vault:primary");
  const { encodeDocumentRoute } = await import("../../src/publish/service.js");
  await httpCase("web:editor", "web", "GET /app/base/*", { urlPath: `/app/base/${encodeDocumentRoute("vault", "Note.base")}`, headers: editorHeaders }, "vault:primary");
  await httpCase("web:editor", "web", "GET /app/canvas/*", { urlPath: `/app/canvas/${encodeDocumentRoute("vault", "Sketch.canvas")}`, headers: editorHeaders }, "vault:primary");

  // --- catalog and note context ---------------------------------------------------------------
  await httpCase("web:editor", "web", "GET /api/web/v2/search", { urlPath: "/api/web/v2/search?q=note", headers: editorHeaders }, "vault:primary");
  await httpCase("web:editor", "web", "GET /api/web/v2/tree", { urlPath: "/api/web/v2/tree?path=", headers: editorHeaders }, "vault:primary");
  await httpCase("web:editor", "web", "GET /api/web/v1/tags", { urlPath: "/api/web/v1/tags", headers: editorHeaders }, "vault:primary");
  for (const direction of ["outgoing", "incoming", "unlinked"]) {
    await httpCase("web:editor", "web", `GET /api/web/v1/note-context/${direction}`, { urlPath: `/api/web/v1/note-context/${direction}?path=note.md`, headers: editorHeaders }, "vault:primary");
  }

  // --- Base reads and one real patch ----------------------------------------------------------
  await httpCase("web:editor", "web", "GET /api/web/v1/base", { urlPath: "/api/web/v1/base?path=Note.base", headers: editorHeaders }, "vault:primary");
  const raw = await ctx.plane.httpRequest({ urlPath: "/api/web/v1/base/raw?path=Note.base", headers: editorHeaders });
  await httpCase("web:editor", "web", "GET /api/web/v1/base/raw", { urlPath: "/api/web/v1/base/raw?path=Note.base", headers: editorHeaders }, "vault:primary");
  let baseRevision = null;
  try { baseRevision = JSON.parse(raw.text)?.revision ?? null; } catch { baseRevision = null; }
  await httpCase("web:editor", "web", "PATCH /api/web/v1/base", {
    method: "PATCH",
    urlPath: "/api/web/v1/base",
    headers: { ...editorHeaders, ...json(editor.csrf) },
    body: JSON.stringify({ path: "Note.base", mutations: [{ op: "set-view-option", view: "Main", key: "limit", value: 25 }], ifMatch: baseRevision }),
  }, "vault:primary");

  // --- the session-scoped theme routes (the same theme the public chrome serves) ---------------
  await httpCase("web:editor", "web", "GET /api/web/v1/theme.css", { urlPath: "/api/web/v1/theme.css?name=baseline-theme", headers: editorHeaders }, "vault:primary");
  await httpCase("web:editor", "web", "GET /api/web/v1/theme-asset", { urlPath: "/api/web/v1/theme-asset?name=baseline-theme&path=font.woff2", headers: editorHeaders }, "vault:primary");

  // --- Canvas read ----------------------------------------------------------------------------
  await httpCase("web:editor", "web", "GET /api/web/v1/canvas", { urlPath: "/api/web/v1/canvas?path=Sketch.canvas", headers: editorHeaders }, "vault:primary");

  // --- the public publish view: publish one note, then read it without a session --------------
  // A real publish of one note; the collector reads the stored record id for the public view row.
  await httpCase("web:editor", "web", "POST /api/web/v1/publish", {
    method: "POST",
    urlPath: "/api/web/v1/publish",
    headers: { ...editorHeaders, ...json(editor.csrf) },
    body: JSON.stringify({ action: "publish", path: "note.md" }),
  }, "vault:primary#publish");

  // --- read-only session against a write route: the refusal lives inside the handler ----------
  await httpCase("web:read-only", "web", "PATCH /api/web/v1/base", {
    method: "PATCH",
    urlPath: "/api/web/v1/base",
    headers: { ...readerHeaders, ...json(reader.csrf) },
    body: JSON.stringify({ path: "Note.base", mutations: [], ifMatch: baseRevision }),
  }, "vault:primary");

  // --- creating a Vault changes the inventory, so it runs after every read above --------------
  await httpCase("web:editor", "web", "POST /api/web/v1/vault", {
    method: "POST",
    urlPath: "/api/web/v1/vault",
    headers: { ...editorHeaders, ...json(editor.csrf) },
    body: JSON.stringify({ name: "Baseline Created" }),
  }, "instance");

  // --- sign-out on its own session: it must not disturb the rows above ------------------------
  const leaver = await ctx.plane.webLogin({ username: "baseline-web-editor", password: "baseline-web-editor-password" });
  await httpCase("web:editor", "web", "POST /auth/logout", {
    method: "POST",
    urlPath: "/auth/logout",
    headers: { Cookie: leaver.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ csrf: leaver.csrf }),
  }, "vault:primary");
  void provider;
  void dataPath;
  void ctx.publishId;
}

/**
 * Admin rows: five permission-editor routes, the Vault/Git surface, the credential writes, publish
 * revoke and the audit export. Destructive writes stay on throwaway records and run before the
 * rows that need the durable ones.
 */
export async function collectAdminBoundaryRows(ctx) {
  const { httpCase, admin, plane, dataPath } = ctx;
  const headers = { Cookie: admin.cookie };
  const post = (capability, fields, targetCase = "instance", extra = {}) => httpCase(
    "admin",
    "admin",
    capability,
    { method: "POST", urlPath: `/admin/auth${capability.replace(/^ADMIN POST /, "")}`, headers: { ...headers, ...FORM, ...extra }, body: formBody({ csrf: admin.csrf, ...fields }) },
    targetCase,
  );
  const get = (capability, query = "", extra = {}) => httpCase(
    "admin",
    "admin",
    capability,
    { urlPath: `/admin/auth${capability.replace(/^ADMIN GET /, "")}${query}`, headers: { ...headers, ...extra } },
    "instance",
  );
  const policies = () => import("./permission-access-policy.js").then((module) => module.readPolicyDocument(dataPath));

  // --- reads ----------------------------------------------------------------------------------
  await get("ADMIN GET /language", "?lang=en");
  await get("ADMIN GET /audit/export.csv");
  // The per-Vault constraint page (plan Task 6). It renders the document this run writes further
  // down, so it is read before anything is created: a page that only worked on a populated store
  // would leave the empty state unmeasured.
  await get("ADMIN GET /authz");

  // --- the Vault/Git surface (its writes answer with a page, not a redirect) ------------------
  await get("ADMIN GET /vault-git");
  const gitPage = await plane.httpRequest({ urlPath: "/admin/auth/vault-git", headers });
  const gitRevision = gitPage.text.match(/name="expectedRevision" value="(\d+)"/)?.[1] ?? "0";
  await post("ADMIN POST /vault-git/refresh", {});
  await post("ADMIN POST /vault-git/verify", { vaultId: "vault" });
  await post("ADMIN POST /vault-git/save", { vaultId: "vault", expectedRevision: gitRevision });
  await post("ADMIN POST /vault-git/repair", { confirm: "wrong-repair-token" }, "instance", ZH);

  // --- the permission editor: its five remaining writes on a policy that no actor matches ------
  // Task 3 froze the legacy write routes, so the policy the earlier `ADMIN POST …/create` row used to
  // store is seeded through the Admin *service* instead (same store, same CAS, same file). It matches
  // no actor of this run, so neither the seed nor the refusals below can gate a later row.
  const accessPolicy = plane.accessPolicy?.admin ?? null;
  if (accessPolicy) {
    const seeded = await accessPolicy.createPolicy({
      label: "baseline window",
      mode: "suspend",
      enabled: true,
      subjects: ["oauth-user:00000000-0000-4000-8000-000000000000"],
      capabilities: ["scope:obsidian.read"],
      timezone: "UTC",
      weekly: { mon: [["09:00", "18:00"]] },
    });
    if (!seeded?.ok) throw new Error(`the baseline policy could not be seeded: ${JSON.stringify(seeded).slice(0, 200)}`);
  }
  const stored = await policies();
  const created = stored.policies.find((policy) => policy.label === "baseline window");
  // Each write bumps the store revision; read it fresh instead of counting.
  const currentRevision = async () => (await policies()).revision;
  let revision = stored.revision;
  if (created) {
    await post("ADMIN POST /access-policy/update", { id: created.id, expectedRevision: revision, label: "baseline window renamed", subjects: ["oauth-user:00000000-0000-4000-8000-000000000000"], capabilities: ["scope:obsidian.read"], timezone: "UTC", w_mon_from_0: "09:00", w_mon_to_0: "18:00" });
    // A second subject that no actor of this run has: a policy must never gate a later row.
    revision = await currentRevision();
    await post("ADMIN POST /access-policy/subjects", { id: created.id, subject: "oauth-user:00000000-0000-4000-8000-00000000000a", tab: "keys", expectedRevision: revision });
    revision = await currentRevision();
    await post("ADMIN POST /access-policy/toggle", { id: created.id, enabled: "false", confirmed: "1", expectedRevision: revision });
    await post("ADMIN POST /access-policy/preview", { subject: `oauth-user:${ctx.userId}`, view: "list" });
    await post("ADMIN POST /access-policy/repair", { document: "{}", confirm: "wrong-repair-token" });
    revision = await currentRevision();
    await post("ADMIN POST /access-policy/delete", { id: created.id, expectedRevision: revision, confirm: "baseline window renamed" });
  }

  // --- API keys: create, widen, delete a throwaway key ----------------------------------------
  await post("ADMIN POST /api-key/create", { label: "boundary key", allowedScope: ["obsidian.read"], allowedVault: ["vault"] });
  const keys = await plane.provider.authorizationSnapshot();
  const boundaryKey = keys.apiKeys.find((key) => key.label === "boundary key");
  if (boundaryKey) {
    await post("ADMIN POST /api-key/scopes", { id: boundaryKey.id, allowedScope: ["obsidian.read", "obsidian.write"], allowedVault: ["vault"] });
    await post("ADMIN POST /api-key/delete", { id: boundaryKey.id, confirm: "boundary key" });
  }

  // --- OAuth accounts: create, widen, reset, default Vault, disable, delete -------------------
  await post("ADMIN POST /oauth/user/create", {
    username: "boundary-user", password: "boundary-user-password", displayName: "Boundary User",
    allowedScope: ["obsidian.read"], allowedVault: ["vault"],
  });
  const afterCreate = await plane.provider.authorizationSnapshot();
  const boundaryUser = afterCreate.oauthUsers.find((user) => user.username === "boundary-user");
  if (boundaryUser) {
    await post("ADMIN POST /oauth/user/scopes", { id: boundaryUser.id, allowedScope: ["obsidian.read", "obsidian.write"], allowedVault: ["vault"] });
    await post("ADMIN POST /oauth/user/password", { id: boundaryUser.id, password: "boundary-user-password-2" });
    await post("ADMIN POST /oauth/user/default-vault", { id: boundaryUser.id, defaultVaultId: "vault" });
    await post("ADMIN POST /oauth/user/toggle", { id: boundaryUser.id, disabled: "true" });
    // A token of this account, so the token revoke row has a real target.
    await plane.provider.issueTokens("boundary-client", ["obsidian.read"], `${plane.base}/mcp`, boundaryUser.id, ["vault"]);
    const withToken = await plane.provider.authorizationSnapshot();
    const boundaryToken = withToken.tokens.find((token) => token.userId === boundaryUser.id && token.status === "active");
    if (boundaryToken) await post("ADMIN POST /oauth/token/revoke", { type: boundaryToken.type, id: boundaryToken.id });
    await post("ADMIN POST /oauth/user/delete", { id: boundaryUser.id, confirm: "boundary-user" });
  }
  await post("ADMIN POST /oauth/token/cleanup", { olderThanDays: "7" });

  // --- OAuth clients: a throwaway client to revoke, another to delete -------------------------
  await plane.provider.clientsStore.registerClient({
    client_id: "boundary-client-revoke", client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: "Boundary Revoke", redirect_uris: ["https://client.example/boundary-revoke"],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
  });
  await plane.provider.clientsStore.registerClient({
    client_id: "boundary-client-delete", client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: "Boundary Delete", redirect_uris: ["https://client.example/boundary-delete"],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"],
  });
  // `revokeClient` refuses a client that holds no grant; give it a token first.
  await plane.provider.issueTokens("boundary-client-revoke", ["obsidian.read"], `${plane.base}/mcp`, ctx.userId, ["vault"]);
  await post("ADMIN POST /oauth/client/revoke", { clientId: "boundary-client-revoke" });
  await post("ADMIN POST /oauth/client/delete", { clientId: "boundary-client-delete", confirm: "Boundary Delete" });
  await post("ADMIN POST /oauth/client/default-vault", { clientId: "baseline-client", defaultVaultId: "alpha" });

  // --- publish revoke, then the audit export and its destructive clear (last) -----------------
  if (ctx.publishId) await post("ADMIN POST /publish/revoke", { id: ctx.publishId });
  await post("ADMIN POST /audit/clear", { confirm: "wrong-clear-token" }, "instance", ZH);

  // --- the per-Vault constraint writes (plan Task 5) -------------------------------------------
  // One window per route, on a subject no actor of this run has, so no constraint can gate a later
  // row. The master switch is flipped over HTTP once (that is the boundary) and restored through
  // the service: a second row with the same key would be a duplicate, and a document left switched
  // off would make every window above inert for anything that follows.
  const constraints = ctx.authorizationAdmin ?? null;
  if (constraints) {
    const revision = () => constraints.list().revision;
    const draft = {
      label: "baseline constraint",
      subjects: ["oauth-user:00000000-0000-4000-8000-000000000000"],
      mode: "suspend",
      capabilities: ["get_note"],
      vaultIds: ["vault"],
      timezone: "UTC",
      w_mon_from_0: "09:00",
      w_mon_to_0: "18:00",
    };
    await post("ADMIN POST /authz/create", { expectedRevision: revision(), ...draft });
    const created = constraints.list().constraints.at(-1);
    if (created) {
      await post("ADMIN POST /authz/update", { id: created.id, expectedRevision: revision(), ...draft, label: "baseline constraint renamed" });
      await post("ADMIN POST /authz/toggle", { id: created.id, expectedRevision: revision(), enabled: "false" });
      await post("ADMIN POST /authz/delete", { id: created.id, expectedRevision: revision() });
    }
    await post("ADMIN POST /authz/plane", { expectedRevision: revision(), enabled: "false" });
    await constraints.setTemporalPlane({ expectedRevision: revision(), enabled: true });
  }
}

/**
 * OAuth consent and token boundaries.
 *
 * Design §11.3-1 makes consent the place that freezes the Vault ceiling, so these are permission
 * boundaries, not plumbing. Everything except the browser step is driven here: the consent page is
 * fetched, its transaction is approved with the account's own credentials, and the resulting code is
 * exchanged, refreshed and revoked. The interactive page *rendering* is the one step a test cannot
 * perform for a human; it is recorded as the `GET /oauth/authorize` row instead of being skipped.
 */
export async function collectOAuthRows(ctx) {
  const { httpCase, plane, provider } = ctx;
  const redirectUri = "https://client.example/callback";
  // The canonical resource is the configured public base, not the plane's ephemeral port.
  const resource = `${String(process.env.PUBLIC_BASE_URL || plane.base).replace(/\/+$/, "")}/mcp`;
  const { createHash } = await import("node:crypto");
  const verifier = "baseline-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeQuery = new URLSearchParams({
    response_type: "code", client_id: "baseline-client", redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", state: "baseline", resource, scope: "obsidian.read",
  }).toString();
  const form = { "Content-Type": "application/x-www-form-urlencoded" };

  const consent = await httpCase("oauth:consent", "oauth", "GET /oauth/authorize", { urlPath: `/oauth/authorize?${authorizeQuery}` }, "instance#consent");
  const transaction = consent.response?.text.match(/name="transaction" value="([^"]+)"/)?.[1] ?? null;
  if (!transaction) return;

  const decision = await httpCase("oauth:consent", "oauth", "POST /oauth/decision", {
    method: "POST",
    urlPath: "/oauth/decision",
    headers: form,
    body: formBody({ transaction, username: "baseline-user", password: "baseline-user-password", scope: "obsidian.read", decision: "allow" }),
  }, "instance#consent");
  const code = decision.response?.headers.get("location")?.match(/[?&]code=([^&]+)/)?.[1] ?? null;

  let refreshToken = null;
  if (code) {
    const exchanged = await httpCase("oauth:consent", "oauth", "POST /oauth/token", {
      method: "POST",
      urlPath: "/oauth/token",
      headers: form,
      body: formBody({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: "baseline-client", code_verifier: verifier }),
    }, "instance#token-exchange");
    try { refreshToken = JSON.parse(exchanged.response?.text ?? "{}").refresh_token ?? null; } catch { refreshToken = null; }
    const accessToken = (() => { try { return JSON.parse(exchanged.response?.text ?? "{}").access_token ?? null; } catch { return null; } })();
    if (accessToken) {
      await httpCase("oauth:consent", "oauth", "POST /oauth/revoke", {
        method: "POST",
        urlPath: "/oauth/revoke",
        headers: form,
        body: formBody({ token: accessToken, client_id: "baseline-client" }),
      }, "instance#revoke");
    }
  }
  if (refreshToken) {
    await httpCase("oauth:consent", "oauth", "POST /oauth/token", {
      method: "POST",
      urlPath: "/oauth/token",
      headers: form,
      body: formBody({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "baseline-client" }),
    }, "instance#refresh");
  }
  await httpCase("oauth:consent", "oauth", "POST /oauth/token", {
    method: "POST",
    urlPath: "/oauth/token",
    headers: form,
    body: formBody({ grant_type: "authorization_code", code: "not-a-real-code", redirect_uri: redirectUri, client_id: "baseline-client", code_verifier: verifier }),
  }, "instance#invalid-grant");
  await httpCase("oauth:client", "oauth", "POST /oauth/register", {
    method: "POST",
    urlPath: "/oauth/register",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Baseline Registered", redirect_uris: ["https://client.example/registered"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  }, "instance#register");
  void provider;
}
