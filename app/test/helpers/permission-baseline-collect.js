// P0 / Task 1 Step 3 — collect the permission baseline by driving the real stack.
//
// The collector never asks a rule engine what it *thinks* an answer is. It boots the same process
// pieces `server.js` boots (see `permission-plane.js`), sends real requests with real credentials
// over real HTTP, and records the answer that came back: allow/deny, the stable error family, where
// the refusal landed, whether the operation handler produced an answer, and how many Vault files
// changed.
//
// Two rules keep the fixture honest:
//   * a refused request must leave every Vault byte-identical; if it changed a byte the collector
//     throws — that is a finding to report, not a row to pin;
//   * `handlerCalls` is MEASURED: the plane counts real handler entries at the seam closest to the
//     handler (tool/resource handler, route handler). A refusal that still reached a handler is a
//     finding, never a row, so the invariant stays falsifiable.
//
// The caller sets the environment (`VAULT_PATH`, `WEB_VAULTS_ROOT`, `DATA_PATH`, `API_KEY`,
// `PUBLIC_BASE_URL`, the OAuth seed variables) BEFORE importing this module.

import fs from "node:fs/promises";
import path from "node:path";

import {
  createPermissionPlane,
  observeCase,
  observeHttpCase,
  resourceRead,
  toolCall,
} from "./permission-plane.js";
import { collectAdminBoundaryRows, collectOAuthRows, collectWebBoundaryRows } from "./permission-extra-rows.js";
import { MALFORMED_TOOL_CALL, sweepArgumentsFor } from "./permission-tool-arguments.js";
import {
  calendarDateIn,
  withTemporaryPolicy,
  weeklyWindowContaining,
  weeklyWindowExcluding,
} from "./permission-access-policy.js";

/** Markers that tell one Vault from another in a resource payload. */
export const RESOURCE_MARKERS = Object.freeze({
  primaryFile: "primary-only-marker.md",
  secondaryFile: "alpha-only-marker.md",
  primaryTag: "primarytag",
  secondaryTag: "alphatag",
});

export const RESOURCE_URIS = Object.freeze([
  "obsidian://vault/index",
  "obsidian://vault/tags",
  "obsidian://vault/graph",
  "obsidian://agent/memory-policy",
]);

const TIME_CASE = "no-constraint";

/** Content of the two files that exist in exactly one Vault: the proof of which Vault answered. */
export const VAULT_MARKER_CONTENT = Object.freeze({
  primary: "Only in the primary Vault",
  secondary: "Only in the alpha Vault",
});

/** Which Vault answered a note read, judged by the marker content it returned. */
export function observedVaultOfNote(payload) {
  if (payload.includes(VAULT_MARKER_CONTENT.primary)) return "primary";
  if (payload.includes(VAULT_MARKER_CONTENT.secondary)) return "secondary";
  return "undetermined";
}

/**
 * The instant the temporal rows are decided at. The plane pins the access-policy runtime clock to
 * it (`policyNow`), so a window boundary is a decision, not a race: ±1 ms is reproducible.
 */
export const POLICY_NOW = Date.parse("2026-11-05T10:00:00.000Z");

/**
 * Which Vault answered a resource read, judged by markers that exist in exactly one Vault.
 * `undetermined` is a real answer: it says the payload could not distinguish them.
 */
export function observedVaultOf(uri, payload) {
  if (uri === "obsidian://agent/memory-policy") return "instance";
  const primary = payload.includes(RESOURCE_MARKERS.primaryFile) || payload.includes(RESOURCE_MARKERS.primaryTag);
  const secondary = payload.includes(RESOURCE_MARKERS.secondaryFile) || payload.includes(RESOURCE_MARKERS.secondaryTag);
  if (primary && !secondary) return "primary";
  if (secondary && !primary) return "secondary";
  if (primary && secondary) return "both";
  return "undetermined";
}

/**
 * Synthetic Vault content: one file and one tag that exist ONLY in one Vault (so a resource
 * payload can be attributed), a readable note in each, and an extra Vault that no synthetic
 * credential holds.
 */
async function seedVaults(sourceRoot) {
  const primary = path.join(sourceRoot, "vault");
  const secondary = path.join(sourceRoot, "alpha");
  const denied = path.join(sourceRoot, "denied-vault");
  for (const root of [primary, secondary, denied]) await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(primary, "note.md"), "---\ntags:\n  - primarytag\n---\n\n# Primary note\n\n[[note]]\n", "utf8");
  await fs.writeFile(path.join(primary, RESOURCE_MARKERS.primaryFile), "# Only in the primary Vault\n", "utf8");
  await fs.mkdir(path.join(primary, "assets"), { recursive: true });
  await fs.writeFile(path.join(primary, "assets", "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await fs.writeFile(path.join(primary, "assets", "scratch.bin"), Buffer.from("delete me\n", "utf8"));
  await fs.writeFile(path.join(secondary, "note.md"), "---\ntags:\n  - alphatag\n---\n\n# Alpha note\n", "utf8");
  // A Base, a Canvas and one theme: the Base/Canvas/theme routes need a real document to answer.
  await fs.writeFile(path.join(primary, "Note.base"), "views:\n  - type: table\n    name: Main\n    limit: 50\n    order:\n      - file.name\n", "utf8");
  await fs.writeFile(path.join(primary, "Sketch.canvas"), JSON.stringify({ nodes: [], edges: [] }, null, 2), "utf8");
  await fs.mkdir(path.join(primary, ".obsidian", "themes", "baseline-theme"), { recursive: true });
  await fs.writeFile(path.join(primary, ".obsidian", "appearance.json"), JSON.stringify({ cssTheme: "baseline-theme", theme: "obsidian", baseFontSize: 16 }, null, 2), "utf8");
  await fs.writeFile(path.join(primary, ".obsidian", "themes", "baseline-theme", "theme.css"), ":root { --baseline: 1; }\n", "utf8");
  await fs.writeFile(path.join(primary, ".obsidian", "themes", "baseline-theme", "font.woff2"), Buffer.from("774f4632", "hex"));
  await fs.writeFile(path.join(secondary, RESOURCE_MARKERS.secondaryFile), "# Only in the alpha Vault\n", "utf8");
  await fs.writeFile(path.join(denied, "note.md"), "# Held by nobody\n", "utf8");
  return { primary, secondary, denied };
}

function bytesOf(text) {
  return Buffer.byteLength(text, "utf8");
}

function buildRow({ actorCase, surface, capability, targetCase, timeCase, observed }) {
  if (!observed.allowed && observed.contentIo > 0) {
    throw new Error(
      `[permission-baseline] finding: a refused request changed ${observed.contentIo} Vault file(s) — `
      + `actorCase=${actorCase} surface=${surface} capability=${capability} targetCase=${targetCase} status=${observed.status}`,
    );
  }
  return {
    actorCase,
    surface,
    capability,
    targetCase,
    timeCase: timeCase ?? TIME_CASE,
    allowed: observed.allowed,
    errorFamily: observed.errorFamily,
    denialPoint: observed.denialPoint,
    handlerCalls: observed.handlerCalls,
    contentIo: observed.contentIo,
    status: observed.status,
    ...(observed.targetVaultObserved ? { targetVaultObserved: observed.targetVaultObserved } : {}),
  };
}

/**
 * Drive every plane and return the rows.
 *
 * `sourceRoot` holds the synthetic Vaults (`vault` = primary, `alpha` = secondary);
 * `dataPath` is where the provider, the Web session store and the access-policy store write.
 */
export async function collectBaselineRows({ sourceRoot, dataPath, nowMs = Date.now() }) {
  const { primary } = await seedVaults(sourceRoot);
  const envKey = process.env.API_KEY;
  const plane = await createPermissionPlane({ envKey, primaryVault: primary, authzEnabled: true, dataPath, policyNow: POLICY_NOW });
  const rows = [];
  const push = (row) => rows.push(row);

  async function mcpCase(actorCase, actor, capability, request, targetCase, surface = "mcp", timeCase = TIME_CASE) {
    const observed = await observeCase(plane, { actor, request, vaultRoot: sourceRoot, targetCase });
    push(buildRow({ actorCase, surface, capability, targetCase, timeCase, observed }));
    return observed;
  }

  async function httpCase(actorCase, surface, capability, request, targetCase, timeCase = TIME_CASE) {
    const observed = await observeHttpCase(plane, { request, vaultRoot: sourceRoot, targetCase });
    push(buildRow({ actorCase, surface, capability, targetCase, timeCase, observed }));
    return observed;
  }

  try {
    const provider = plane.provider;
    const mcpResource = `http://127.0.0.1:18923/mcp`;

    // ---- identities: synthetic, one per credential shape the baseline must pin --------------
    const user = await provider.createOAuthUser({
      username: "baseline-user",
      password: "baseline-user-password",
      displayName: "Baseline User",
      allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
      allowedVaults: ["vault", "alpha"],
    });
    const second = await provider.createOAuthUser({
      username: "baseline-second",
      password: "baseline-second-password",
      displayName: "Baseline Second",
      allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
      allowedVaults: ["vault"],
    });
    const webEditor = await provider.createOAuthUser({
      username: "baseline-web-editor",
      password: "baseline-web-editor-password",
      displayName: "Baseline Web Editor",
      allowedScopes: ["obsidian.read", "obsidian.write", "obsidian.files"],
      allowedVaults: ["vault", "alpha"],
    });
    const webReader = await provider.createOAuthUser({
      username: "baseline-web-reader",
      password: "baseline-web-reader-password",
      displayName: "Baseline Web Reader",
      allowedScopes: ["obsidian.read"],
      allowedVaults: ["vault", "alpha"],
    });
    await provider.clientsStore.registerClient({
      client_id: "baseline-client",
      client_id_issued_at: Math.floor(nowMs / 1000),
      client_name: "Baseline Client",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    const full = await provider.issueTokens("baseline-client", ["obsidian.read", "obsidian.write", "obsidian.files"], mcpResource, user.id, ["vault", "alpha"]);
    const primaryOnly = await provider.issueTokens("baseline-client", ["obsidian.read", "obsidian.write", "obsidian.files"], mcpResource, user.id, ["vault"]);
    const secondaryOnly = await provider.issueTokens("baseline-client", ["obsidian.read"], mcpResource, user.id, ["alpha"]);
    const readKey = await provider.createApiKey("baseline read key", ["obsidian.read"], ["vault"]);
    const filesKey = await provider.createApiKey("baseline files key", ["obsidian.read", "obsidian.files"], ["vault"]);
    const writeKey = await provider.createApiKey("baseline write key", ["obsidian.read", "obsidian.write"], ["vault"]);

    // The Admin session is opened here, long before the Admin ROWS run: the temporal rows need it to
    // store their policy, and a login changes no credential state.
    const admin = await plane.adminLogin({ password: process.env.OAUTH_ADMIN_PASSWORD });
    const form = (fields) => ({ "Content-Type": "application/x-www-form-urlencoded" });
    const body2 = (fields) => new URLSearchParams(fields).toString();

    const byKey = (secret) => ({ id: `key:${secret.slice(0, 12)}`, headers: () => ({ "X-API-Key": secret }) });
    const byToken = (id, token) => ({ id, headers: () => ({ Authorization: `Bearer ${token.access_token}` }) });
    const actors = {
      anonymous: { id: "anonymous", headers: () => ({}) },
      envKey: { id: "env-key", headers: () => ({ "X-API-Key": envKey }) },
      readKey: byKey(readKey.secret),
      filesKey: byKey(filesKey.secret),
      writeKey: byKey(writeKey.secret),
      full: byToken("oauth-full", full),
      primaryOnly: byToken("oauth-primary-only", primaryOnly),
      secondaryOnly: byToken("oauth-secondary-only", secondaryOnly),
    };

    // ---- MCP tools: the permission-relevant ones, with real arguments ----------------------
    await mcpCase("env-key", actors.envKey, "list_notes", toolCall("list_notes", {}), "vault:primary");
    await mcpCase("env-key", actors.envKey, "list_notes", toolCall("list_notes", { vaultId: "alpha" }), "vault:secondary");
    await mcpCase("env-key", actors.envKey, "list_notes", toolCall("list_notes", { vaultId: "no-such-vault" }), "vault:unknown");
    await mcpCase("env-key", actors.envKey, "list_notes", toolCall("list_notes", { vaultId: "denied-vault" }), "vault:denied");
    await mcpCase("env-key", actors.envKey, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    await mcpCase("env-key", actors.envKey, "write_note", toolCall("write_note", { path: "env-key.md", content: "# env key\n" }), "vault:primary");
    await mcpCase("env-key", actors.envKey, "write_note", toolCall("write_note", { path: "env-key-alpha.md", content: "# no\n", vaultId: "alpha" }), "vault:secondary");

    await mcpCase("oauth:full", actors.full, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    // Marker rows: each names its Vault explicitly and returns content that exists in one Vault only.
    const proofPrimary = await mcpCase("oauth:full", actors.full, "get_note", toolCall("get_note", { path: "primary-only-marker.md", vaultId: "vault" }), "vault:primary#marker");
    rows[rows.length - 1].targetVaultObserved = observedVaultOfNote(proofPrimary.payload);
    const proofSecondary = await mcpCase("oauth:full", actors.full, "get_note", toolCall("get_note", { path: "alpha-only-marker.md", vaultId: "alpha" }), "vault:secondary#marker");
    rows[rows.length - 1].targetVaultObserved = observedVaultOfNote(proofSecondary.payload);
    // The default routing BEFORE any Admin write: no `vaultId`, so the primary Vault answers.
    const defaultBefore = await mcpCase("oauth:full", actors.full, "get_note", toolCall("get_note", { path: "primary-only-marker.md" }), "vault:default");
    rows[rows.length - 1].targetVaultObserved = observedVaultOfNote(defaultBefore.payload);
    await mcpCase("oauth:full", actors.full, "get_note", toolCall("get_note", { path: "note.md", vaultId: "alpha" }), "vault:secondary");
    await mcpCase("oauth:full", actors.full, "list_notes", toolCall("list_notes", { vaultId: "no-such-vault" }), "vault:unknown");
    await mcpCase("oauth:full", actors.full, "list_notes", toolCall("list_notes", { vaultId: "denied-vault" }), "vault:denied");
    await mcpCase("oauth:full", actors.full, "write_note", toolCall("write_note", { path: "secondary-write.md", content: "# written in alpha\n", vaultId: "alpha" }), "vault:secondary");
    await mcpCase("oauth:full", actors.full, "no_such_tool", toolCall("no_such_tool", {}), "vault:primary");

    await mcpCase("oauth:primary-only", actors.primaryOnly, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    await mcpCase("oauth:primary-only", actors.primaryOnly, "get_note", toolCall("get_note", { path: "note.md", vaultId: "alpha" }), "vault:secondary");
    await mcpCase("oauth:primary-only", actors.primaryOnly, "write_note", toolCall("write_note", { path: "primary-only.md", content: "# no\n", vaultId: "alpha" }), "vault:secondary");

    await mcpCase("oauth:secondary-only", actors.secondaryOnly, "list_notes", toolCall("list_notes", { vaultId: "alpha" }), "vault:secondary");
    await mcpCase("oauth:secondary-only", actors.secondaryOnly, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    await mcpCase("oauth:secondary-only", actors.secondaryOnly, "list_notes", toolCall("list_notes", {}), "vault:primary");
    await mcpCase("oauth:secondary-only", actors.secondaryOnly, "write_note", toolCall("write_note", { path: "read-only.md", content: "# no\n", vaultId: "alpha" }), "vault:secondary");

    await mcpCase("api-key:read-primary", actors.readKey, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    await mcpCase("api-key:read-primary", actors.readKey, "write_note", toolCall("write_note", { path: "read-key.md", content: "# no\n" }), "vault:primary");
    await mcpCase("api-key:write-primary", actors.writeKey, "delete_file", toolCall("delete_file", { path: "assets/scratch.bin" }), "vault:primary");
    // §11.3-2 of the design: `obsidian.files` alone can delete a file today. This row is the
    // evidence, and P2/P3 must keep it visible instead of filing it as a tightening.
    await mcpCase("api-key:files-primary", actors.filesKey, "delete_file", toolCall("delete_file", { path: "assets/scratch.bin" }), "vault:primary");
    await mcpCase("api-key:files-primary", actors.filesKey, "get_file", toolCall("get_file", { path: "assets/pixel.png" }), "vault:primary");

    await mcpCase("anonymous", actors.anonymous, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");

    // ---- identity coverage: scope subsets, dead credentials, a forged bearer ----------------
    //
    // Each row asks the same question with a different credential property, so a later phase can
    // show that one property alone decides the answer.
    for (const [actorCase, scopes] of [["api-key:write-only", ["obsidian.write"]], ["api-key:files-only", ["obsidian.files"]], ["api-key:write-files", ["obsidian.write", "obsidian.files"]], // An empty list is not "no scopes": `normalizedScopes` falls back to every scope, so this row
      // records that a zero-scope key cannot be created through this path.
      ["api-key:empty-scope-list", []]]) {
      const key = await provider.createApiKey(actorCase, scopes, ["vault"]);
      await mcpCase(actorCase, byKey(key.secret), "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    }
    const deadTokenIds = new Set((await provider.authorizationSnapshot()).tokens.map((token) => token.id));
    const revokedCredential = await provider.issueTokens("baseline-client", ["obsidian.read"], `${process.env.PUBLIC_BASE_URL}/mcp`, user.id, ["vault"]);
    const expiredCredential = await provider.issueTokens("baseline-client", ["obsidian.read"], `${process.env.PUBLIC_BASE_URL}/mcp`, user.id, ["vault"]);
    const freshTokens = (await provider.authorizationSnapshot()).tokens.filter((token) => !deadTokenIds.has(token.id) && token.type === "access");
    const revokedRecord = freshTokens[0];
    const expiredRecord = freshTokens[1];
    if (revokedRecord) await provider.revokeTokenById("access", revokedRecord.id);
    if (expiredRecord) {
      // A real expired record: its stored expiry moves into the past, exactly as a stale token's does.
      for (const stored of Object.values(provider.data.accessTokens)) {
        if (stored.id === expiredRecord.id) stored.expiresAt = Date.now() - 1000;
      }
    }
    const disabledUser = await provider.createOAuthUser({
      username: "baseline-disabled", password: "baseline-disabled-password", displayName: "Baseline Disabled",
      allowedScopes: ["obsidian.read"], allowedVaults: ["vault"],
    });
    const disabledCredential = await provider.issueTokens("baseline-client", ["obsidian.read"], `${process.env.PUBLIC_BASE_URL}/mcp`, disabledUser.id, ["vault"]);
    await provider.updateOAuthUser(disabledUser.id, { disabled: true });
    await mcpCase("oauth:revoked-token", { id: "revoked", headers: () => ({ Authorization: `Bearer ${revokedCredential.access_token}` }) }, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    await mcpCase("oauth:expired-token", { id: "expired", headers: () => ({ Authorization: `Bearer ${expiredCredential.access_token}` }) }, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    await mcpCase("oauth:disabled-account", { id: "disabled", headers: () => ({ Authorization: `Bearer ${disabledCredential.access_token}` }) }, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");
    await mcpCase("oauth:forged-bearer", { id: "forged", headers: () => ({ Authorization: "Bearer forged-token-value" }) }, "get_note", toolCall("get_note", { path: "note.md", vaultId: "vault" }), "vault:primary");

    // ---- the full tool inventory, one real answer each --------------------------------------
    //
    // Arguments come from each tool's own `inputSchema` (plus a curated table for the semantic
    // values), so the row tests the gate and not the SDK's schema. One deliberate malformed call
    // stays, so `validation` is still recorded as a family.
    const { TOOL_NAMES } = await import("../../src/config.js");
    const listed = JSON.parse(
      (await plane.call(actors.full, { jsonrpc: "2.0", id: 90, method: "tools/list", params: {} })).text
        .split("\n").find((line) => line.trim().startsWith("data:"))?.slice(5).trim() ?? "{}",
    );
    const schemas = new Map((listed?.result?.tools ?? []).map((tool) => [tool.name, tool.inputSchema]));
    for (const name of TOOL_NAMES) {
      await mcpCase("oauth:full", actors.full, name, toolCall(name, sweepArgumentsFor(name, schemas.get(name))), "vault:primary#tool-args");
    }
    await mcpCase("oauth:full", actors.full, MALFORMED_TOOL_CALL.tool, toolCall(MALFORMED_TOOL_CALL.tool, MALFORMED_TOOL_CALL.args), "malformed:argument-type", "mcp", "malformed:argument-type");

    // ---- MCP resources: which Vault does each one read? ------------------------------------
    const resourceActors = [["oauth:primary-only", actors.primaryOnly], ["oauth:secondary-only", actors.secondaryOnly], ["oauth:full", actors.full]];
    for (const [actorCase, actor] of resourceActors) {
      for (const uri of RESOURCE_URIS) {
        const observed = await observeCase(plane, { actor, request: resourceRead(uri), vaultRoot: sourceRoot, targetCase: uri === "obsidian://agent/memory-policy" ? "instance" : "vault:primary" });
        const payload = observed.payload ?? "";
        push(buildRow({
          actorCase,
          surface: "mcp-resource",
          capability: uri,
          targetCase: uri === "obsidian://agent/memory-policy" ? "instance" : "vault:primary",
          observed: { ...observed, targetVaultObserved: observedVaultOf(uri, payload) },
        }));
      }
    }
    await httpCase("anonymous", "mcp-resource", "obsidian://vault/index", { method: "POST", urlPath: "/mcp", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify(resourceRead("obsidian://vault/index")) }, "vault:primary");

    // ---- Web plane: real login, real page, real write route, CSRF missing case --------------
    const editor = await plane.webLogin({ username: "baseline-web-editor", password: "baseline-web-editor-password" });
    const reader = await plane.webLogin({ username: "baseline-web-reader", password: "baseline-web-reader-password" });
    const editorHeaders = { Cookie: editor.cookie };
    const readerHeaders = { Cookie: reader.cookie };
    const jsonHeaders = (csrf) => ({ "Content-Type": "application/json", "X-CSRF-Token": csrf });

    await httpCase("web:editor", "web", "GET /app", { urlPath: "/app", headers: editorHeaders }, "vault:primary");
    await httpCase("web:anonymous", "web", "GET /app", { urlPath: "/app" }, "vault:primary");
    await httpCase("web:editor", "web", "POST /auth/login", { method: "POST", urlPath: "/auth/login", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "baseline-web-editor", password: "wrong-password", next: "/app/" }).toString() }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/session", { urlPath: "/api/web/v1/session", headers: editorHeaders }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/vaults", { urlPath: "/api/web/v1/vaults", headers: editorHeaders }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/notes", { urlPath: "/api/web/v1/notes", headers: editorHeaders }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/note", { urlPath: "/api/web/v1/note?path=note.md", headers: editorHeaders }, "vault:primary");
    await httpCase("web:anonymous", "web", "GET /api/web/v1/notes", { urlPath: "/api/web/v1/notes" }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/asset", { urlPath: "/api/web/v1/asset?path=assets%2Fpixel.png&from=note.md", headers: editorHeaders }, "vault:primary");
    await httpCase("web:read-only", "web", "GET /api/web/v1/asset", { urlPath: "/api/web/v1/asset?path=assets%2Fpixel.png&from=note.md", headers: readerHeaders }, "vault:primary");
    await httpCase("web:editor", "web", "POST /api/web/v1/vault/select", { method: "POST", urlPath: "/api/web/v1/vault/select", headers: { ...editorHeaders, ...jsonHeaders(editor.csrf) }, body: JSON.stringify({ id: "alpha" }) }, "vault:secondary");
    await httpCase("web:editor", "web", "POST /api/web/v1/vault/select", { method: "POST", urlPath: "/api/web/v1/vault/select", headers: { ...editorHeaders, ...jsonHeaders(editor.csrf) }, body: JSON.stringify({ id: "denied-vault" }) }, "vault:denied");
    await httpCase("web:editor", "web", "POST /api/web/v1/note", { method: "POST", urlPath: "/api/web/v1/note", headers: { ...editorHeaders, ...jsonHeaders(editor.csrf) }, body: JSON.stringify({ path: "web-written.md", content: "# written by the Web editor\n" }) }, "vault:primary");
    await httpCase("web:editor", "web", "POST /api/web/v1/note", { method: "POST", urlPath: "/api/web/v1/note", headers: { ...editorHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ path: "web-no-csrf.md", content: "# refused\n" }) }, "vault:primary#no-csrf");
    await httpCase("web:read-only", "web", "POST /api/web/v1/note", { method: "POST", urlPath: "/api/web/v1/note", headers: { ...readerHeaders, ...jsonHeaders(reader.csrf) }, body: JSON.stringify({ path: "web-reader-write.md", content: "# refused\n" }) }, "vault:primary");
    const { encodeDocumentRoute } = await import("../../src/publish/service.js");
    await httpCase("web:editor", "web", "GET /app/note/*", { urlPath: `/app/note/${encodeDocumentRoute("vault", "note.md")}`, headers: editorHeaders }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/link/resolve", { urlPath: "/api/web/v1/link/resolve?source=note.md&target=note", headers: editorHeaders }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/publish", { urlPath: "/api/web/v1/publish?path=note.md", headers: editorHeaders }, "vault:primary");
    await httpCase("web:editor", "web", "POST /api/web/v1/publish", { method: "POST", urlPath: "/api/web/v1/publish", headers: { ...editorHeaders, ...jsonHeaders(editor.csrf) }, body: JSON.stringify({ action: "unsupported-action" }) }, "vault:primary");
    await httpCase("web:editor", "web", "GET /api/web/v1/themes", { urlPath: "/api/web/v1/themes", headers: editorHeaders }, "vault:primary");
    // The Web editor's image upload: a mutation boundary with its own scope, CSRF and Vault gate.
    const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    const assetHeaders = (session, csrf, fileName) => ({ ...session, "Content-Type": "application/octet-stream", "X-File-Name": fileName, ...(csrf ? { "X-CSRF-Token": csrf } : {}) });
    await httpCase("web:editor", "web", "POST /api/web/v1/asset", { method: "POST", urlPath: "/api/web/v1/asset", headers: assetHeaders(editorHeaders, editor.csrf, "baseline.png"), body: pngBytes }, "vault:primary");
    await httpCase("web:editor", "web", "POST /api/web/v1/asset", { method: "POST", urlPath: "/api/web/v1/asset", headers: assetHeaders(editorHeaders, null, "baseline-no-csrf.png"), body: pngBytes }, "vault:primary#no-csrf");
    await httpCase("web:read-only", "web", "POST /api/web/v1/asset", { method: "POST", urlPath: "/api/web/v1/asset", headers: assetHeaders(readerHeaders, reader.csrf, "reader.png"), body: pngBytes }, "vault:primary");
    // Deliberate malformed cases, one per surface: `validation` must stay a recorded family.
    await httpCase("web:editor", "web", "POST /api/web/v1/note", {
      method: "POST",
      urlPath: "/api/web/v1/note",
      headers: { ...editorHeaders, "Content-Type": "application/json", "X-CSRF-Token": editor.csrf },
      body: "{not json",
    }, "vault:primary#malformed", "malformed:request-body");
    await httpCase("web:editor", "web", "POST /api/web/v1/folder", { method: "POST", urlPath: "/api/web/v1/folder", headers: { ...editorHeaders, ...jsonHeaders(editor.csrf) }, body: JSON.stringify({ path: "web-folder" }) }, "vault:primary");
    // The Web rename and safe delete routes (Task 4): one allow each, in that order, so the
    // renamed folder is the one the delete moves into the Trash.
    await httpCase("web:editor", "web", "POST /api/web/v1/rename", { method: "POST", urlPath: "/api/web/v1/rename", headers: { ...editorHeaders, ...jsonHeaders(editor.csrf) }, body: JSON.stringify({ path: "web-folder", to: "web-folder-renamed", mutationId: "baseline-rename-0001" }) }, "vault:primary");
    await httpCase("web:editor", "web", "POST /api/web/v1/delete", { method: "POST", urlPath: "/api/web/v1/delete", headers: { ...editorHeaders, ...jsonHeaders(editor.csrf) }, body: JSON.stringify({ path: "web-folder-renamed", confirm: true }) }, "vault:primary");

    // ---- direct upload data plane: PUT bytes, PATCH complete, foreign credential ------------
    const uploadBytes = Buffer.from("P0 direct upload\n", "utf8");
    const uploadSha = (await import("node:crypto")).createHash("sha256").update(uploadBytes).digest("hex");
    const startUpload = async (name, targetCase) => {
      const started = await mcpCase("oauth:full", actors.full, "start_direct_upload", toolCall("start_direct_upload", { path: `uploads/${name}`, totalBytes: uploadBytes.length, sha256: uploadSha }), targetCase);
      return started.payload?.match(/"uploadId"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    };
    const allowedId = await startUpload("p0-allowed.bin", "vault:primary");
    const foreignId = await startUpload("p0-foreign.bin", "vault:primary#foreign-credential");
    if (allowedId) {
      await httpCase("oauth:full", "direct-upload", "PUT /uploads/:uploadId", { method: "PUT", urlPath: `/uploads/${allowedId}`, headers: { ...actors.full.headers(), "Content-Type": "application/octet-stream", "Content-Length": String(uploadBytes.length) }, body: uploadBytes }, "vault:primary");
      await httpCase("oauth:full", "direct-upload", "PATCH /uploads/:uploadId", { method: "PATCH", urlPath: `/uploads/${allowedId}`, headers: { ...actors.full.headers(), "Content-Type": "application/octet-stream", "Content-Length": "0", "Upload-Offset": String(uploadBytes.length) }, body: Buffer.alloc(0) }, "vault:primary");
    }
    // The upload plane's malformed case: bytes with no usable handle.
    await httpCase("oauth:full", "direct-upload", "PUT /uploads/:uploadId", {
      method: "PUT",
      urlPath: "/uploads/not-a-real-handle",
      headers: { ...actors.full.headers(), "Content-Type": "application/octet-stream", "Content-Length": String(uploadBytes.length) },
      body: uploadBytes,
    }, "vault:primary#malformed", "malformed:unknown-handle");
    if (foreignId) {
      await httpCase("oauth:secondary-only", "direct-upload", "PUT /uploads/:uploadId", { method: "PUT", urlPath: `/uploads/${foreignId}`, headers: { ...actors.secondaryOnly.headers(), "Content-Type": "application/octet-stream", "Content-Length": String(uploadBytes.length) }, body: uploadBytes }, "vault:primary");
      await httpCase("anonymous", "direct-upload", "PUT /uploads/:uploadId", { method: "PUT", urlPath: `/uploads/${foreignId}`, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(uploadBytes.length) }, body: uploadBytes }, "vault:primary");
    }

    // ---- OAuth consent and token boundaries ---------------------------------------------------
    await collectOAuthRows({ httpCase, plane, provider });

    // ---- the remaining Web boundaries: Base, Canvas, catalogs, publish view, Vault create -----
    await collectWebBoundaryRows({
      httpCase,
      plane,
      provider,
      dataPath,
      editor: { csrf: editor.csrf },
      reader: { csrf: reader.csrf },
      editorHeaders,
      readerHeaders,
    });
    const publishState = JSON.parse(await fs.readFile(path.join(dataPath, "publish", "state.json"), "utf8").catch(() => "{\"records\":[]}"));
    const published = (publishState.records ?? []).find((record) => record.path === "note.md" && record.vaultId === "vault");
    if (published?.id) {
      await httpCase("web:anonymous", "web", "GET /publish/:id", { urlPath: `/publish/${published.id}` }, "vault:primary");
    }
    // The two folder Publish routes (folder publish, task 5). The seeded Vaults hold no published
    // folder record and no Web route can publish one yet, so both rows are anonymous reads of an
    // id that names nothing: the answer is 404 and the row still proves the boundary is mapped and
    // runs no content I/O. A served index needs a folder record; the folder surface adds it.
    const unknownPublishId = "A".repeat(43); // the id shape, and no record carries it
    const unknownToken = "B".repeat(22); // the token shape, and no record derives it
    await httpCase("web:anonymous", "web", "GET /publish/d/:id", { urlPath: `/publish/d/${unknownPublishId}` }, "vault:primary");
    await httpCase("web:anonymous", "web", "GET /publish/d/:id/n/:token", { urlPath: `/publish/d/${unknownPublishId}/n/${unknownToken}` }, "vault:primary");

    // ---- the temporal gate: one suspend policy at a time, stored through the real Admin service
    //
    // Every row below is the same request (`get_note` on the primary Vault with a full credential);
    // only the policy changes. The policy clock is pinned to `POLICY_NOW` (see the plane's
    // `policyNow`), so "1 ms before/after a boundary" is a decision and not a race. The seam is the
    // Admin *service* (Task 3 froze the legacy write routes): same store, same CAS, same file.
    const policyService = plane.accessPolicy.admin;
    const timePolicy = (timeCase, overrides) => ({
      label: `baseline ${timeCase}`,
      mode: "suspend",
      enabled: true,
      subjects: [`oauth-user:${user.id}`],
      capabilities: ["tool:get_note"],
      timezone: "UTC",
      ...overrides,
    });
    const timeRow = async (timeCase, overrides) => {
      await withTemporaryPolicy(
        { service: policyService, policy: timePolicy(timeCase, overrides) },
        async () => {
          // Explicit `vaultId` and a primary-only file: the row proves WHICH Vault answered, and it
          // cannot be steered by any default Vault another row sets.
          const observed = await mcpCase("oauth:full", actors.full, "get_note", toolCall("get_note", { path: "primary-only-marker.md", vaultId: "vault" }), "vault:primary", "mcp", timeCase);
          rows[rows.length - 1].targetVaultObserved = observedVaultOfNote(observed.payload);
        },
      );
    };

    const at = (deltaMs) => new Date(POLICY_NOW + deltaMs).toISOString();
    const reference = new Date(POLICY_NOW);
    await timeRow("window:startsAt-minus-1ms", { startsAt: at(-1), expiresAt: at(3_600_000) });
    await timeRow("window:startsAt-plus-1ms", { startsAt: at(1), expiresAt: at(3_600_000) });
    await timeRow("window:expiresAt-minus-1ms", { startsAt: at(-3_600_000), expiresAt: at(-1) });
    await timeRow("window:expiresAt-plus-1ms", { startsAt: at(-3_600_000), expiresAt: at(1) });
    for (const zone of ["UTC", "Asia/Shanghai", "Europe/Berlin"]) {
      await timeRow(`weekly:inside:${zone}`, { timezone: zone, weekly: weeklyWindowContaining(zone, reference).weekly });
      await timeRow(`weekly:outside:${zone}`, { timezone: zone, weekly: weeklyWindowExcluding(zone, reference).weekly });
    }
    const today = calendarDateIn("UTC", reference);
    const tomorrow = calendarDateIn("UTC", new Date(POLICY_NOW + 24 * 3600 * 1000));
    const dayAfter = calendarDateIn("UTC", new Date(POLICY_NOW + 48 * 3600 * 1000));
    await timeRow("dateRange:inside-today", { dateRanges: [{ from: today, to: today }] });
    await timeRow("dateRange:outside-tomorrow", { dateRanges: [{ from: tomorrow, to: dayAfter }] });

    // ---- Admin plane: real session, real CSRF, permission save, default-Vault save ---------
    const body = body2;
    await httpCase("admin", "admin", "ADMIN GET /login", { urlPath: "/admin/auth/login" }, "instance");
    await httpCase("admin", "admin", "ADMIN POST /login", { method: "POST", urlPath: "/admin/auth/login", headers: form(), body: body({ password: process.env.OAUTH_ADMIN_PASSWORD }) }, "instance");
    await httpCase("admin:wrong-password", "admin", "ADMIN POST /login", { method: "POST", urlPath: "/admin/auth/login", headers: form(), body: body({ password: "wrong-admin-password" }) }, "instance");
    await httpCase("admin", "admin", "ADMIN GET /", { urlPath: "/admin/auth", headers: { Cookie: admin.cookie } }, "instance");
    await httpCase("admin", "admin", "ADMIN GET /access-policy", { urlPath: "/admin/auth/access-policy", headers: { Cookie: admin.cookie } }, "instance");
    await httpCase("admin:anonymous", "admin", "ADMIN GET /", { urlPath: "/admin/auth" }, "instance");
    const policyFields = {
      csrf: admin.csrf,
      label: "baseline window",
      // A subject no actor in this run has: the policy this row stores must never gate a later row.
      subjects: "oauth-user:00000000-0000-4000-8000-000000000000",
      mode: "suspend",
      capabilities: "scope:obsidian.read",
      timezone: "UTC",
      w_mon_from_0: "09:00",
      w_mon_to_0: "18:00",
    };
    await httpCase("admin", "admin", "ADMIN POST /access-policy/create", { method: "POST", urlPath: "/admin/auth/access-policy/create", headers: { Cookie: admin.cookie, ...form() }, body: body(policyFields) }, "instance");
    await httpCase("admin:no-csrf", "admin", "ADMIN POST /access-policy/create", { method: "POST", urlPath: "/admin/auth/access-policy/create", headers: { Cookie: admin.cookie, ...form() }, body: body({ ...policyFields, csrf: "not-the-token" }) }, "instance");
    await httpCase("admin", "admin", "ADMIN POST /api-key/default-vault", { method: "POST", urlPath: "/admin/auth/api-key/default-vault", headers: { Cookie: admin.cookie, ...form() }, body: body({ csrf: admin.csrf, id: readKey.id, defaultVaultId: "vault" }) }, "instance");
    await httpCase("admin:no-csrf", "admin", "ADMIN POST /api-key/default-vault", { method: "POST", urlPath: "/admin/auth/api-key/default-vault", headers: { Cookie: admin.cookie, ...form() }, body: body({ csrf: "not-the-token", id: readKey.id, defaultVaultId: "vault" }) }, "instance");
    await httpCase("admin:anonymous", "admin", "ADMIN POST /api-key/default-vault", { method: "POST", urlPath: "/admin/auth/api-key/default-vault", headers: form(), body: body({ csrf: "not-the-token", id: readKey.id, defaultVaultId: "vault" }) }, "instance");
    await httpCase("admin", "admin", "ADMIN POST /access-policy/create", {
      method: "POST",
      urlPath: "/admin/auth/access-policy/create",
      headers: { Cookie: admin.cookie, ...form() },
      body: body({ csrf: admin.csrf, capabilities: "scope:obsidian.read", timezone: "UTC", w_mon_from_0: "09:00", w_mon_to_0: "18:00" }),
    }, "instance#malformed", "malformed:missing-field");
    await httpCase("admin", "admin", "ADMIN POST /theme", { method: "POST", urlPath: "/admin/auth/theme", headers: { Cookie: admin.cookie, ...form() }, body: body({ csrf: admin.csrf, theme: "light" }) }, "instance");

    // ---- the rest of the Admin surface: Git, the permission editor, credential writes, audit ---
    await collectAdminBoundaryRows({
      httpCase,
      plane,
      admin,
      dataPath,
      authorizationAdmin: plane.authorizationAdmin,
      userId: user.id,
      secondUserId: second.id,
      publishId: published?.id ?? null,
    });

    // The Admin rows above set a client-level default Vault (`alpha`). This row records that effect
    // ON PURPOSE: with no `vaultId`, the same request now reads the alpha Vault.
    const defaultAfter = await mcpCase("oauth:full", actors.full, "get_note", toolCall("get_note", { path: "alpha-only-marker.md" }), "vault:default#after-client-default");
    rows[rows.length - 1].targetVaultObserved = observedVaultOfNote(defaultAfter.payload);

    // ---- session ownership: a second principal must not ride an existing session --------------
    // Both Vaults, so this row is refused by the session ownership check and not by the client-level
    // default Vault a later Admin row sets.
    const secondToken = await plane.provider.issueTokens("baseline-client", ["obsidian.read"], "http://127.0.0.1:18923/mcp", second.id, ["vault", "alpha"]);
    const secondActor = { id: "oauth:second-user", headers: () => ({ Authorization: `Bearer ${secondToken.access_token}` }) };
    // Take the full credential's real session id, then let the second principal reuse it.
    await plane.sessionIdFor(actors.full);
    const reusedSession = await observeCase(plane, {
      actor: secondActor,
      request: toolCall("get_note", { path: "note.md" }),
      sessionId: plane.sessionIdOf(actors.full),
      vaultRoot: sourceRoot,
      targetCase: "vault:primary#session-of-another-principal",
    });
    push(buildRow({
      actorCase: "oauth:second-principal",
      surface: "mcp",
      capability: "get_note",
      targetCase: "vault:primary#session-of-another-principal",
      timeCase: TIME_CASE,
      observed: reusedSession,
    }));
    // Last row of the plane: logging out must invalidate this session and nothing else.
    await httpCase("admin", "admin", "ADMIN POST /logout", { method: "POST", urlPath: "/admin/auth/logout", headers: { Cookie: admin.cookie, ...form() }, body: body({ csrf: admin.csrf }) }, "instance");
    await httpCase("admin", "admin", "ADMIN GET /", { urlPath: "/admin/auth", headers: { Cookie: admin.cookie } }, "instance#after-logout");
  } finally {
    await plane.close();
  }

  rows.sort((left, right) => rowOrder(left).localeCompare(rowOrder(right)));
  return rows;
}

function rowOrder(row) {
  return [row.surface, row.actorCase, row.capability, row.targetCase, row.timeCase].join("|");
}
