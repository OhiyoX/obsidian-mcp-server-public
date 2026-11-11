// P1 / Task 2 — the canonical authorization operation catalog.
//
// Contract: design §4 (capability vocabulary, boundary mapping) and the P0
// coverage manifest (`manifest.json`, read-only truth: one row per real
// boundary). The catalog itself has no enforcement power: it only names
// operations and maps a boundary key onto the one operation it performs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTHORIZATION_CATALOG_VERSION,
  authorizationOperation,
  capabilityForBoundary,
  catalogBoundaryKeys,
  catalogOperationIds,
  catalogToolIds,
  isOutsideTemporalPlane,
  surfaceForBoundary,
} from "../src/authorization/catalog.js";
import { TOOL_NAMES } from "../src/config.js";
import { MCP_RESOURCE_SCOPE_REQUIREMENTS, MCP_TOOL_SCOPE_REQUIREMENTS } from "../src/scopes.js";

const MANIFEST_PATH = new URL("./fixtures/permission-architecture/manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const DESCRIPTOR_KEYS = ["contentEffect", "grantable", "id", "oauthScopes", "plane", "surfaces", "targetKind"];

// P0 owns the coverage list. The catalog must map exactly its rows: one more row
// is an invented boundary and one fewer is an unmapped one, and both fail here.
// The temporal exemption is a property of two OPERATIONS, never of a request string.
const EXEMPT_BOUNDARIES = Object.freeze([
  "GET /api/web/v1/session", "POST /api/web/v1/vault/select", // vault_select
  "GET /app", "GET /app/", "GET /app/language", // session_bootstrap
  "GET /auth/login", "POST /auth/login", "POST /auth/logout",
  "GET /auth/theme.css", "GET /auth/theme-asset",
  "POST /oauth/register", "POST /oauth/revoke", // credential housekeeping, no account subject
  // §4.1a: the instance metadata plane carries no Vault content and the tool layer never
  // evaluated it while suspended (A-07), so no account window may reach it.
  "agent_bootstrap", "server_info", "obsidian://agent/memory-policy",
]);

// §4.2 rows the manifest names but the vocabulary does not spell out one by one.
// Every entry carries the design row it comes from.
const WEB_BOUNDARY_EXPECTATIONS = {
  "GET /app/note/*": "get_note", // Web note read
  "GET /app/base/*": "get_base", // Base page shell (readGate)
  "GET /app/canvas/*": "get_canvas", // Canvas page shell (readGate)
  "GET /app": "session_bootstrap", // public shell, outside account time policy
  "GET /app/": "session_bootstrap",
  "GET /app/language": "session_bootstrap", // locale shell asset
  "GET /auth/login": "session_bootstrap", // public login page
  "POST /auth/login": "session_bootstrap",
  "POST /auth/logout": "session_bootstrap",
  "GET /auth/theme.css": "session_bootstrap", // public login style asset
  "GET /auth/theme-asset": "session_bootstrap",
  "GET /publish/:id": "publish_document_read", // anonymous Publish delegation
  "GET /publish/d/:id": "publish_folder_read", // the published folder's index
  "GET /publish/d/:id/n/:token": "publish_folder_read", // one note by opaque token
  "GET /api/web/v1/session": "vault_select", // session shell, outside the temporal plane
  "GET /api/web/v1/vaults": "vault_list_read", // Vault list, legacy readGate, inside the plane
  "POST /api/web/v1/vault/select": "vault_select", // switch Vault, outside the temporal plane
  "POST /api/web/v1/vault": "vault_create", // new Vault
  "GET /api/web/v1/notes": "list_notes",
  "GET /api/web/v1/events": "get_note", // SSE is a content-derived read of the current Vault
  "GET /api/web/v1/note": "get_note",
  "GET /api/web/v1/link/resolve": "get_note", // resolves a note link inside the current Vault
  "GET /api/web/v1/base": "get_base", // Base raw/query (readGate)
  "GET /api/web/v1/base/raw": "get_base",
  "PATCH /api/web/v1/base": "patch_base", // Base patch (write class)
  "GET /api/web/v1/canvas": "get_canvas",
  "GET /api/web/v1/tags": "list_tags",
  "GET /api/web/v1/note-context/incoming": "get_note_context",
  "GET /api/web/v1/note-context/outgoing": "get_note_context",
  "GET /api/web/v1/note-context/unlinked": "get_note_context",
  "GET /api/web/v2/search": "search_notes",
  "GET /api/web/v2/tree": "list_files",
  "GET /api/web/v1/publish": "get_publish_status",
  "POST /api/web/v1/publish": "manage_publish",
  "GET /api/web/v1/themes": "get_note", // theme/shell reads follow the content-derived row
  "GET /api/web/v1/theme.css": "get_note",
  "GET /api/web/v1/theme-asset": "get_note",
  "GET /api/web/v1/asset": "get_file", // attachment GET
  "POST /api/web/v1/asset": "write_file", // attachment POST (write class)
  "POST /api/web/v1/note": "write_note",
  "POST /api/web/v1/folder": "manage_folders",
  "POST /api/web/v1/rename": "move_note", // rename a folder or a note (write class)
  "POST /api/web/v1/delete": "delete_note", // safe delete into the Trash (write class)
};

const ADMIN_BOUNDARY_EXPECTATIONS = {
  "ADMIN GET /assets/:file": "admin_metadata_read",
  "ADMIN GET /login": "admin_metadata_read",
  "ADMIN POST /login": "admin_metadata_read",
  "ADMIN POST /logout": "admin_metadata_read",
  "ADMIN POST /theme": "admin_metadata_read",
  "ADMIN GET /": "admin_metadata_read",
  "ADMIN POST /api-key/scopes": "admin_authorization_manage",
  "ADMIN POST /api-key/delete": "admin_authorization_manage",
  "ADMIN POST /oauth/user/create": "admin_authorization_manage",
  "ADMIN POST /oauth/user/scopes": "admin_authorization_manage",
  "ADMIN POST /oauth/user/password": "admin_authorization_manage",
  "ADMIN POST /oauth/user/toggle": "admin_authorization_manage",
  "ADMIN POST /oauth/user/delete": "admin_authorization_manage",
  "ADMIN POST /oauth/client/revoke": "admin_authorization_manage",
  "ADMIN POST /oauth/client/delete": "admin_authorization_manage",
  "ADMIN POST /oauth/token/revoke": "admin_authorization_manage",
  "ADMIN POST /oauth/token/cleanup": "admin_authorization_manage",
  "ADMIN POST /publish/revoke": "admin_publish_revoke",
  "ADMIN GET /audit/export.csv": "admin_metadata_read",
  "ADMIN POST /audit/clear": "admin_metadata_read",
  "ADMIN GET /language": "admin_metadata_read",
  "ADMIN GET /access-policy": "admin_metadata_read",
  "ADMIN POST /access-policy/preview": "admin_metadata_read",
  "ADMIN POST /access-policy/subjects": "admin_metadata_read",
  "ADMIN POST /api-key/default-vault": "admin_metadata_read", // a preference, not a grant
  "ADMIN POST /oauth/client/default-vault": "admin_metadata_read",
  "ADMIN POST /oauth/user/default-vault": "admin_metadata_read",
  "ADMIN POST /access-policy/create": "admin_authorization_manage",
  "ADMIN POST /access-policy/delete": "admin_authorization_manage",
  "ADMIN POST /access-policy/repair": "admin_authorization_manage",
  "ADMIN POST /access-policy/toggle": "admin_authorization_manage",
  "ADMIN POST /access-policy/update": "admin_authorization_manage",
  "ADMIN GET /authz": "admin_authorization_manage",
  "ADMIN POST /authz/create": "admin_authorization_manage",
  "ADMIN POST /authz/delete": "admin_authorization_manage",
  "ADMIN POST /authz/plane": "admin_authorization_manage",
  "ADMIN POST /authz/toggle": "admin_authorization_manage",
  "ADMIN POST /authz/update": "admin_authorization_manage",
  "ADMIN POST /api-key/create": "admin_authorization_manage",
  "ADMIN GET /vault-git": "admin_git_manage",
  "ADMIN POST /vault-git/refresh": "admin_git_manage",
  "ADMIN POST /vault-git/repair": "admin_git_manage",
  "ADMIN POST /vault-git/save": "admin_git_manage",
  "ADMIN POST /vault-git/verify": "admin_git_manage",
};

const RESOURCE_BOUNDARY_EXPECTATIONS = {
  "obsidian://vault/index": "vault_index_read",
  "obsidian://vault/tags": "vault_tags_read",
  "obsidian://vault/graph": "vault_graph_read",
  "obsidian://agent/memory-policy": "agent_memory_policy_read",
};

// §4.2 + §8: the direct-upload rows belong to the upload tool that owns the handle
// and keep the legacy mcp CONTROL_TOOL semantics.
const DIRECT_UPLOAD_BOUNDARY_EXPECTATIONS = {
  "PUT /uploads/:uploadId": "start_direct_upload",
  "PATCH /uploads/:uploadId": "start_direct_upload",
  "* /uploads/:uploadId": "start_direct_upload",
};

function manifestBoundaries() {
  const seen = new Set();
  for (const row of manifest.coverage) {
    assert.equal(typeof row.id, "string", "manifest row id must be a string");
    assert.equal(seen.has(row.id), false, `duplicate manifest boundary: ${row.id}`);
    seen.add(row.id);
  }
  return [...seen];
}

test("catalog_maps_every_native_tool_resource_and_web_route_once", () => {
  assert.equal(AUTHORIZATION_CATALOG_VERSION, 1);
  assert.deepEqual([...catalogToolIds].sort(), TOOL_NAMES.toSorted());

  const boundaries = manifestBoundaries();
  assert.equal(boundaries.length, 191, "the P0 manifest is the 182-row coverage set plus the Task 4 rename and delete routes, the two folder Publish routes and the per-Vault constraint page with its five writes, minus the frozen editor's preview fragment, which no surface reached");

  for (const boundary of boundaries) {
    const operationId = capabilityForBoundary(boundary);
    assert.equal(typeof operationId, "string", `unmapped boundary: ${boundary}`);
    assert.notEqual(authorizationOperation(operationId), null, `boundary ${boundary} maps to unknown operation ${operationId}`);
  }

  // Both directions: a catalog row without a manifest row is an invented boundary,
  // and a manifest row without a catalog row is an unmapped one. Both fail here.
  assert.deepEqual([...catalogBoundaryKeys].sort(), [...boundaries].sort());
});

test("catalog_maps_each_web_route_to_its_design_operation", () => {
  for (const [boundary, expected] of Object.entries(WEB_BOUNDARY_EXPECTATIONS)) {
    assert.equal(capabilityForBoundary(boundary), expected, boundary);
  }
  assert.equal(Object.keys(WEB_BOUNDARY_EXPECTATIONS).length, 43);
});

test("catalog_maps_admin_actions_to_control_operations", () => {
  for (const [boundary, expected] of Object.entries(ADMIN_BOUNDARY_EXPECTATIONS)) {
    assert.equal(capabilityForBoundary(boundary), expected, boundary);
  }
  assert.equal(Object.keys(ADMIN_BOUNDARY_EXPECTATIONS).length, 44);
});

test("catalog_maps_each_resource_once_with_its_own_read_capability", () => {
  for (const [boundary, expected] of Object.entries(RESOURCE_BOUNDARY_EXPECTATIONS)) {
    assert.equal(capabilityForBoundary(boundary), expected, boundary);
  }
  assert.equal(capabilityForBoundary("obsidian://vault/index"), "vault_index_read");
  assert.equal(capabilityForBoundary("obsidian://vault/tags"), "vault_tags_read");
  assert.equal(capabilityForBoundary("obsidian://vault/graph"), "vault_graph_read");
  assert.equal(capabilityForBoundary("obsidian://agent/memory-policy"), "agent_memory_policy_read");
  assert.equal(authorizationOperation("agent_memory_policy_read").targetKind, "instance");
  assert.equal(authorizationOperation("vault_index_read").targetKind, "vault");
});

test("catalog_keeps_direct_upload_boundaries_on_the_upload_tool", () => {
  for (const [boundary, expected] of Object.entries(DIRECT_UPLOAD_BOUNDARY_EXPECTATIONS)) {
    assert.equal(capabilityForBoundary(boundary), expected, boundary);
    // §8: a direct upload keeps the MCP control-tool semantics, not a Web surface.
    assert.equal(surfaceForBoundary(boundary), "mcp", boundary);
  }
});

test("catalog_marks_delete_file_and_uploads_as_content_mutations", () => {
  for (const id of ["delete_file", "write_file", "upload_file_chunk", "manage_publish", "git_push", "apply_note_plan"]) {
    assert.equal(authorizationOperation(id).contentEffect, "mutate", id);
  }
  for (const id of ["get_note", "read_archive_entry", "query_base", "get_publish_status", "reindex_vault"]) {
    assert.equal(authorizationOperation(id).contentEffect, "read", id);
  }
  // A read-only old account keeps its read-scope tools, so an index rebuild must
  // not be classified as a content mutation.
  assert.equal(authorizationOperation("reindex_vault").plane, "control");
});

test("catalog_maps_web_asset_post_to_write_file", () => {
  assert.equal(capabilityForBoundary("POST /api/web/v1/asset"), "write_file");
  assert.equal(authorizationOperation("write_file").contentEffect, "mutate");
});

test("catalog_has_web_vault_list_switch_and_create_rows", () => {
  assert.equal(capabilityForBoundary("GET /api/web/v1/vaults"), "vault_list_read");
  assert.equal(capabilityForBoundary("POST /api/web/v1/vault/select"), "vault_select");
  assert.equal(capabilityForBoundary("POST /api/web/v1/vault"), "vault_create");
  assert.equal(authorizationOperation("vault_select").grantable, false);
  // The legacy session routes carried no scope, so a legacy `scope:` selector must
  // not expand onto the session action (§8).
  assert.deepEqual(authorizationOperation("vault_select").oauthScopes, []);
  // The Vault list is its own gated read operation, not the session action.
  assert.equal(capabilityForBoundary("GET /api/web/v1/vaults"), "vault_list_read");
  assert.equal(authorizationOperation("vault_create").targetKind, "instance");
});

test("catalog_exempts_identity_and_credential_operations_and_never_mixes_a_boundary", () => {
  // The exemption is a property of the operation: no request string can select it,
  // and one operation may not hold both an exempt and a gated boundary.
  const exemptOperations = catalogOperationIds.filter((id) => isOutsideTemporalPlane(id));
  assert.deepEqual(exemptOperations.sort(), ["agent_bootstrap", "agent_memory_policy_read", "oauth_client_register", "oauth_token_revoke", "server_info", "session_bootstrap", "vault_select"]);

  const exemptBoundaryKeys = catalogBoundaryKeys.filter((key) => isOutsideTemporalPlane(capabilityForBoundary(key)));
  assert.deepEqual([...exemptBoundaryKeys].sort(), [...EXEMPT_BOUNDARIES].sort());

  for (const operationId of catalogOperationIds) {
    const boundaries = catalogBoundaryKeys.filter((key) => capabilityForBoundary(key) === operationId);
    const exempt = isOutsideTemporalPlane(operationId);
    for (const key of boundaries) {
      assert.equal(EXEMPT_BOUNDARIES.includes(key), exempt, `${operationId} mixes the boundary ${key} against its exemption`);
    }
  }

  // The gated Vault list has its own operation, so an account window still applies.
  assert.equal(capabilityForBoundary("GET /api/web/v1/vaults"), "vault_list_read");
  assert.equal(isOutsideTemporalPlane("vault_list_read"), false);
  assert.equal(authorizationOperation("vault_list_read").targetKind, "instance");
  assert.equal(authorizationOperation("vault_list_read").grantable, true);
  assert.equal(authorizationOperation("session_bootstrap").grantable, false);
  assert.equal(isOutsideTemporalPlane("no_such_operation"), false);
  assert.equal(isOutsideTemporalPlane(null), false);
});

test("catalog_returns_null_for_unknown_keys", () => {
  for (const unknown of ["no_such_tool", "", "GET /nope", "ADMIN POST /nope", "obsidian://vault/unknown", null, undefined, 7]) {
    assert.equal(capabilityForBoundary(unknown), null, String(unknown));
  }
  for (const unknown of ["no_such_operation", "", null, undefined, "__proto__", "constructor"]) {
    assert.equal(authorizationOperation(unknown), null, String(unknown));
  }
});

test("catalog_descriptors_carry_exactly_the_design_fields", () => {
  assert.equal(catalogOperationIds.length, 113, "92 canonical tools + 21 fixed extra IDs");
  for (const id of catalogOperationIds) {
    const descriptor = authorizationOperation(id);
    assert.deepEqual(Object.keys(descriptor).sort(), DESCRIPTOR_KEYS, id);
    assert.equal(descriptor.id, id);
    assert.equal(["content", "metadata", "control"].includes(descriptor.plane), true, id);
    assert.equal(["vault", "instance", "publication"].includes(descriptor.targetKind), true, id);
    assert.equal(typeof descriptor.grantable, "boolean", id);
    assert.equal(["read", "mutate"].includes(descriptor.contentEffect), true, id);
    assert.equal(Array.isArray(descriptor.oauthScopes), true, id);
    assert.equal(descriptor.surfaces.length > 0, true, id);
    for (const surface of descriptor.surfaces) {
      assert.equal(["mcp", "web", "oauth", "admin", "publish", "system"].includes(surface), true, `${id}: ${surface}`);
    }
  }
});

test("catalog_grantable_set_matches_the_design", () => {
  const grantable = catalogOperationIds.filter((id) => authorizationOperation(id).grantable).sort();
  const expectedGrantable = [
    ...TOOL_NAMES,
    "vault_index_read",
    "vault_tags_read",
    "vault_graph_read",
    "vault_list_read",
    "vault_create",
    "agent_memory_policy_read",
  ].sort();
  assert.deepEqual(grantable, expectedGrantable);

  const notGrantable = catalogOperationIds.filter((id) => !authorizationOperation(id).grantable).sort();
  assert.deepEqual(notGrantable, [
    "admin_authorization_manage",
    "admin_git_manage",
    "admin_metadata_read",
    "admin_publish_revoke",
    "oauth_authorize",
    "oauth_client_register",
    "oauth_code_exchange",
    "oauth_refresh",
    "oauth_token_revoke",
    "publish_document_read",
    "publish_folder_read",
    "session_bootstrap",
    "system_git_commit",
    "system_git_push",
    "vault_select",
  ]);
});

test("catalog_oauth_scopes_agree_with_the_existing_scope_registry", () => {
  // The protocol mapping is compatibility, not the authorization check (§4.1); it
  // still has to agree with the frozen table that today's clients are issued from.
  for (const name of TOOL_NAMES) {
    assert.deepEqual(authorizationOperation(name).oauthScopes, MCP_TOOL_SCOPE_REQUIREMENTS[name], name);
  }
  for (const [uri, scopes] of Object.entries(MCP_RESOURCE_SCOPE_REQUIREMENTS)) {
    const operation = capabilityForBoundary(uri);
    assert.equal(operation !== null, true, uri);
    assert.deepEqual(authorizationOperation(operation).oauthScopes, scopes, uri);
  }
});
