// P1 / Task 2 — the single authorization operation catalog (design §4).
//
// One operation per executable action. The ID of a tool operation *is* the
// canonical tool name (design §4.1: no second domain vocabulary). This module
// names and classifies operations and maps a boundary key — the MCP tool name,
// the MCP resource URI, or `<METHOD> <path>` — onto the one operation that
// boundary performs. It holds no policy, evaluates nothing and grants nothing;
// enforcement still runs on `src/scopes.js` and `src/app/access-policy.js`.
//
// `plane` is the kind of thing the operation touches: `content` = Vault file
// bytes (notes, attachments, canvas, bases, versions, archives, plans),
// `metadata` = information derived from content (search, lists, index, tags,
// links, status), `control` = server/Vault state that is not a content body
// (Git, publish management, folders, upload control, session, admin, OAuth).
//
// `oauthScopes` is the protocol compatibility mapping only (design §4.1). It is
// not the authorization check; the token the clients get today is issued from
// `src/scopes.js`, and that table stays authoritative until P2.

import { TOOL_NAMES } from "../config.js";

export const AUTHORIZATION_CATALOG_VERSION = 1;

const READ = Object.freeze(["obsidian.read"]);
const READ_WRITE = Object.freeze(["obsidian.read", "obsidian.write"]);
const READ_FILES = Object.freeze(["obsidian.read", "obsidian.files"]);
const READ_WRITE_FILES = Object.freeze(["obsidian.read", "obsidian.write", "obsidian.files"]);
const NO_SCOPES = Object.freeze([]);

const SURFACES = Object.freeze(["mcp", "web", "oauth", "admin", "publish", "system"]);

// Canonical tool operations, grouped by descriptor. A tool ID must appear in
// exactly one group (checked at load).
const TOOL_GROUPS = [
  // Instance metadata: no Vault content power, but part of the standard read preset.
  {
    plane: "metadata", targetKind: "instance", contentEffect: "read", oauthScopes: READ,
    tools: ["agent_bootstrap", "server_info"],
  },
  // Vault file bodies or plans over them.
  {
    plane: "content", targetKind: "vault", contentEffect: "read", oauthScopes: READ,
    tools: [
      "get_note", "get_canvas", "get_base", "get_note_version", "compare_note_versions",
      "get_note_plan", "plan_note_changes", "plan_move_note", "plan_delete_note",
      "plan_restore_version", "plan_restore_from_trash",
    ],
  },
  {
    plane: "content", targetKind: "vault", contentEffect: "read", oauthScopes: READ_FILES,
    tools: ["pull_note_file", "get_file", "pull_file", "inspect_archive", "read_archive_entry"],
  },
  {
    plane: "content", targetKind: "vault", contentEffect: "mutate", oauthScopes: READ_WRITE,
    tools: [
      "write_note", "write_file", "append_to_note", "patch_note", "replace_in_note", "manage_frontmatter",
      "manage_tags", "move_note", "delete_note", "write_canvas", "write_base", "patch_base",
      "create_base_entry", "daily_note", "create_from_template", "restore_from_trash",
      "delete_trash_entry", "restore_version", "delete_version", "update_task",
      "rename_property", "set_property_type", "memory_capture", "apply_note_plan",
    ],
  },
  {
    plane: "content", targetKind: "vault", contentEffect: "mutate", oauthScopes: READ_WRITE_FILES,
    tools: [
      "start_file_upload", "start_direct_upload", "upload_file_chunk",
      "cancel_file_upload", "create_archive", "extract_archive", "skill_export", "skill_import",
    ],
  },
  // Attachment delete is a content mutation even though the old Scope needs no write.
  {
    plane: "content", targetKind: "vault", contentEffect: "mutate", oauthScopes: READ_FILES,
    tools: ["delete_file"],
  },
  // Information about content, never a body.
  {
    plane: "metadata", targetKind: "vault", contentEffect: "read", oauthScopes: READ,
    tools: [
      "get_metadata", "list_notes", "list_files", "list_recent", "search_notes", "list_tags",
      "list_trash", "list_versions", "get_backlinks", "get_graph", "get_unresolved_links",
      "get_orphans", "get_deadends", "list_tasks", "list_templates", "list_properties",
      "list_aliases", "list_bases", "list_base_views", "query_base", "git_status", "git_diff", "git_log",
      "index_status", "recall", "find_related", "get_note_context", "graph_health",
      "suggest_links", "memory_recall", "skill_list", "skill_match", "skill_validate",
      "get_publish_status",
    ],
  },
  {
    plane: "metadata", targetKind: "vault", contentEffect: "read", oauthScopes: READ_FILES,
    tools: ["file_upload_status"],
  },
  // Control-plane mutations: Git, publication state, directory structure, index.
  {
    plane: "control", targetKind: "vault", contentEffect: "mutate", oauthScopes: READ_WRITE,
    tools: ["git_commit", "git_pull", "git_push", "manage_publish", "manage_folders"],
  },
  // Rebuilding the search index is control work, not a content change: §4.1 lists
  // content mutations explicitly, and an old read-only account keeps this tool.
  {
    plane: "control", targetKind: "vault", contentEffect: "read", oauthScopes: READ,
    tools: ["reindex_vault"],
  },
];

// The fixed extra IDs of design §4.1 (no tool of their own). `surfaces` here is
// the declared use; boundaries below add the concrete entry rows.
const EXTRA_OPERATIONS = [
  { id: "vault_index_read", plane: "metadata", targetKind: "vault", contentEffect: "read", grantable: true, oauthScopes: READ },
  // The Web Vault list carried the legacy read gate, so it is its own, gated,
  // instance-read operation: no window exemption and no shared `vault_select`.
  { id: "vault_list_read", plane: "metadata", targetKind: "instance", contentEffect: "read", grantable: true, oauthScopes: READ },
  // Public auth pages and the app shell: outside account time policy (§9), with no
  // grant of its own. Non-grantable, because it authorizes nothing but the shell.
  { id: "session_bootstrap", plane: "control", targetKind: "instance", contentEffect: "read", grantable: false, oauthScopes: NO_SCOPES },
  { id: "vault_tags_read", plane: "metadata", targetKind: "vault", contentEffect: "read", grantable: true, oauthScopes: READ },
  { id: "vault_graph_read", plane: "metadata", targetKind: "vault", contentEffect: "read", grantable: true, oauthScopes: READ },
  { id: "vault_create", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: true, oauthScopes: READ_WRITE },
  // Derived from each Vault read; never granted on its own, never a write.
  // Derived from each Vault read; the legacy session routes carried no scope, so a
  // legacy `scope:` selector must not expand onto this operation.
  { id: "vault_select", plane: "control", targetKind: "vault", contentEffect: "read", grantable: false, oauthScopes: NO_SCOPES },
  { id: "agent_memory_policy_read", plane: "metadata", targetKind: "instance", contentEffect: "read", grantable: true, oauthScopes: READ },
  { id: "publish_document_read", plane: "content", targetKind: "publication", contentEffect: "read", grantable: false, oauthScopes: NO_SCOPES },
  // The folder index and its token routes read the same publication plane, so they are
  // the same kind of read: one grant-free operation for both routes.
  { id: "publish_folder_read", plane: "content", targetKind: "publication", contentEffect: "read", grantable: false, oauthScopes: NO_SCOPES },
  { id: "oauth_authorize", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  { id: "oauth_code_exchange", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  { id: "oauth_refresh", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  // Registration and revocation are OAuth control operations with no grant: they change the
  // deployment's client and token set, not a person's rights, so the trusted OAuth surface decides.
  { id: "oauth_client_register", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  { id: "oauth_token_revoke", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  { id: "admin_metadata_read", plane: "control", targetKind: "instance", contentEffect: "read", grantable: false, oauthScopes: NO_SCOPES },
  { id: "admin_authorization_manage", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  { id: "admin_publish_revoke", plane: "control", targetKind: "instance", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  { id: "admin_git_manage", plane: "control", targetKind: "vault", contentEffect: "mutate", grantable: false, oauthScopes: NO_SCOPES },
  { id: "system_git_commit", plane: "control", targetKind: "vault", contentEffect: "mutate", grantable: false, oauthScopes: READ_WRITE },
  { id: "system_git_push", plane: "control", targetKind: "vault", contentEffect: "mutate", grantable: false, oauthScopes: READ_WRITE },
];

const DECLARED_SURFACES = Object.freeze({
  vault_index_read: Object.freeze(["mcp"]),
  vault_list_read: Object.freeze(["web"]),
  session_bootstrap: Object.freeze(["web"]),
  vault_tags_read: Object.freeze(["mcp"]),
  vault_graph_read: Object.freeze(["mcp"]),
  vault_create: Object.freeze(["web"]),
  vault_select: Object.freeze(["web"]),
  agent_memory_policy_read: Object.freeze(["mcp"]),
  publish_document_read: Object.freeze(["publish"]),
  publish_folder_read: Object.freeze(["publish"]),
  oauth_authorize: Object.freeze(["oauth"]),
  oauth_code_exchange: Object.freeze(["oauth"]),
  oauth_refresh: Object.freeze(["oauth"]),
  oauth_client_register: Object.freeze(["oauth"]),
  oauth_token_revoke: Object.freeze(["oauth"]),
  admin_metadata_read: Object.freeze(["admin"]),
  admin_authorization_manage: Object.freeze(["admin"]),
  admin_publish_revoke: Object.freeze(["admin"]),
  admin_git_manage: Object.freeze(["admin"]),
  system_git_commit: Object.freeze(["system"]),
  system_git_push: Object.freeze(["system"]),
});

// The public Publish boundaries, named once. `publish/service.js` maps them to the
// publication capability, and `app/routes.js` passes the folder ones on every folder read, so
// a drifted literal would return no capability and turn every folder read into a 404.
export const PUBLISH_DOCUMENT_BOUNDARY = "GET /publish/:id";
export const PUBLISH_FOLDER_BOUNDARY = "GET /publish/d/:id";
export const PUBLISH_FOLDER_NOTE_BOUNDARY = "GET /publish/d/:id/n/:token";

// Non-tool boundaries: [boundary key, operation id, surface]. The keys are the
// frozen coverage rows of the P0 manifest (`test/fixtures/permission-architecture/
// manifest.json`, 182 rows at P0 `f89ec47e` plus the two Task 4 rename and delete
// routes); the rows mirror design §4.2 one for one, with the entry file that wires
// the route named in each comment.
const BOUNDARY_ROWS = Object.freeze([
  // §4.2 "Web note 读取、写入；Base raw/query/patch；Canvas 读取" -> get_note /
  // write_note, get_base / query_base / patch_base, get_canvas.
  ["GET /app/note/*", "get_note", "web"], // routes.js /app/note/* (readGate)
  ["GET /api/web/v1/note", "get_note", "web"],
  ["GET /api/web/v1/link/resolve", "get_note", "web"], // resolves a note link in the current Vault
  ["GET /api/web/v1/base", "get_base", "web"], // base-route.js (readGate)
  ["GET /api/web/v1/base/raw", "get_base", "web"], // base-patch-route.js raw content view
  ["PATCH /api/web/v1/base", "patch_base", "web"], // base-patch-route.js (write class)
  ["GET /app/base/*", "get_base", "web"], // base-page.js shell (readGate)
  ["GET /api/web/v1/canvas", "get_canvas", "web"], // canvas-route.js (readGate)
  ["GET /app/canvas/*", "get_canvas", "web"], // canvas-page.js shell (readGate)
  // §4.2 "search/tree/tags/context" -> search_notes / list_files / list_tags /
  // get_note_context, always against the current Vault.
  ["GET /api/web/v2/search", "search_notes", "web"], // search route (readGate)
  ["GET /api/web/v2/tree", "list_files", "web"], // tree route (readGate)
  ["GET /api/web/v1/notes", "list_notes", "web"], // v1 compatibility note list (readGate)
  ["GET /api/web/v1/tags", "list_tags", "web"], // tags-route.js (readGate)
  ["GET /api/web/v1/note-context/incoming", "get_note_context", "web"], // note-context route (readGate)
  ["GET /api/web/v1/note-context/outgoing", "get_note_context", "web"],
  ["GET /api/web/v1/note-context/unlinked", "get_note_context", "web"],
  // §4.2 "Web 附件 GET/POST；folder POST" -> get_file / write_file / manage_folders.
  ["GET /api/web/v1/asset", "get_file", "web"], // attachments.js (files class)
  ["POST /api/web/v1/asset", "write_file", "web"], // asset-route.js (write class)
  ["POST /api/web/v1/note", "write_note", "web"],
  ["POST /api/web/v1/folder", "manage_folders", "web"],
  // Web rename and safe delete (Task 4) each serve folders and notes from one route, so each
  // boundary names the content mutation the write-class gate decides for.
  // Known gap, for P4: a policy that denies `manage_folders` alone does not block a folder
  // rename or delete here, because one row cannot name two operations. Legacy enforces
  // `obsidian.write` only, so this branch changes no decision.
  ["POST /api/web/v1/rename", "move_note", "web"],
  ["POST /api/web/v1/delete", "delete_note", "web"],
  // §4.2 "Web Publish status/manage".
  ["GET /api/web/v1/publish", "get_publish_status", "web"],
  ["POST /api/web/v1/publish", "manage_publish", "web"],
  // §4.2 "Web Vault 列表 / 切库 / 新建库" -> vault_select / vault_create. The list
  // route carries the legacy read gate; the session routes do not (see the
  // temporal-plane list below).
  ["GET /api/web/v1/session", "vault_select", "web"], // no gate in the legacy plane
  ["GET /api/web/v1/vaults", "vault_list_read", "web"], // routes.js:247, legacy readGate, inside the plane
  ["POST /api/web/v1/vault/select", "vault_select", "web"], // no gate in the legacy plane
  ["POST /api/web/v1/vault", "vault_create", "web"], // write class
  ["GET /api/web/v1/events", "get_note", "web"], // SSE: content-derived read, rechecked per delivery
  ["GET /api/web/v1/themes", "get_note", "web"], // theme reads of the current Vault (gated)
  ["GET /api/web/v1/theme.css", "get_note", "web"],
  ["GET /api/web/v1/theme-asset", "get_note", "web"],
  // Public pages and the app shell are outside account time policy (§9), so they
  // belong to `session_bootstrap` and never to a content operation.
  ["GET /app", "session_bootstrap", "web"], // routes.js /app shell
  ["GET /app/", "session_bootstrap", "web"],
  ["GET /app/language", "session_bootstrap", "web"], // locale-routes.js shell asset
  ["GET /auth/theme.css", "session_bootstrap", "web"], // auth-routes.js public login style asset
  ["GET /auth/theme-asset", "session_bootstrap", "web"], // auth-routes.js public login asset
  ["GET /auth/login", "session_bootstrap", "web"], // auth-routes.js login page (no actor yet)
  ["POST /auth/login", "session_bootstrap", "web"],
  ["POST /auth/logout", "session_bootstrap", "web"],
  // §4.2 "直传 PUT/PATCH -> start_direct_upload / handle 绑定的库". §8 keeps the
  // legacy mcp CONTROL_TOOL semantics, so `surface:mcp` still covers an upload and
  // `surface:web` does not. The `*` row is the other method on the same handle.
  ["PUT /uploads/:uploadId", "start_direct_upload", "mcp"],
  ["PATCH /uploads/:uploadId", "start_direct_upload", "mcp"],
  ["* /uploads/:uploadId", "start_direct_upload", "mcp"],
  // §4.2 anonymous Publish delegation: one loaded publication record.
  [PUBLISH_DOCUMENT_BOUNDARY, "publish_document_read", "publish"],
  // The published folder: its index, and one note inside it by opaque token.
  [PUBLISH_FOLDER_BOUNDARY, "publish_folder_read", "publish"],
  [PUBLISH_FOLDER_NOTE_BOUNDARY, "publish_folder_read", "publish"],
  // §4.2 four MCP resources.
  ["obsidian://vault/index", "vault_index_read", "mcp"],
  ["obsidian://vault/tags", "vault_tags_read", "mcp"],
  ["obsidian://vault/graph", "vault_graph_read", "mcp"],
  ["obsidian://agent/memory-policy", "agent_memory_policy_read", "mcp"],
  // §4.2 Admin: the shell, the audit log and the default-Vault preference read
  // control metadata; the authorization-plane console and the identity/credential
  // rows are the matching admin operations. A default Vault is a preference, not a
  // grant (§7), so `/default-vault` writes stay metadata.
  ["ADMIN GET /assets/:file", "admin_metadata_read", "admin"],
  ["ADMIN GET /login", "admin_metadata_read", "admin"],
  ["ADMIN POST /login", "admin_metadata_read", "admin"],
  ["ADMIN POST /logout", "admin_metadata_read", "admin"],
  ["ADMIN POST /theme", "admin_metadata_read", "admin"],
  ["ADMIN GET /", "admin_metadata_read", "admin"],
  ["ADMIN GET /language", "admin_metadata_read", "admin"],
  ["ADMIN GET /audit/export.csv", "admin_metadata_read", "admin"],
  ["ADMIN POST /audit/clear", "admin_metadata_read", "admin"],
  ["ADMIN GET /access-policy", "admin_metadata_read", "admin"],
  ["ADMIN POST /access-policy/preview", "admin_metadata_read", "admin"],
  ["ADMIN POST /access-policy/subjects", "admin_metadata_read", "admin"],
  ["ADMIN POST /api-key/default-vault", "admin_metadata_read", "admin"],
  ["ADMIN POST /oauth/client/default-vault", "admin_metadata_read", "admin"],
  ["ADMIN POST /oauth/user/default-vault", "admin_metadata_read", "admin"],
  ["ADMIN POST /access-policy/create", "admin_authorization_manage", "admin"],
  ["ADMIN POST /access-policy/delete", "admin_authorization_manage", "admin"],
  ["ADMIN POST /access-policy/repair", "admin_authorization_manage", "admin"],
  ["ADMIN POST /access-policy/toggle", "admin_authorization_manage", "admin"],
  ["ADMIN POST /access-policy/update", "admin_authorization_manage", "admin"],
  // The per-Vault constraint editor (plan Tasks 5 and 6). Every write moves who may do what, on
  // which Vault, so all five are the same control operation as the legacy policy writes above; its
  // `GET` renders that console and is filed with them, not with the read-only metadata rows.
  ["ADMIN GET /authz", "admin_authorization_manage", "admin"],
  ["ADMIN POST /authz/create", "admin_authorization_manage", "admin"],
  ["ADMIN POST /authz/delete", "admin_authorization_manage", "admin"],
  ["ADMIN POST /authz/plane", "admin_authorization_manage", "admin"],
  ["ADMIN POST /authz/toggle", "admin_authorization_manage", "admin"],
  ["ADMIN POST /authz/update", "admin_authorization_manage", "admin"],
  ["ADMIN POST /api-key/create", "admin_authorization_manage", "admin"],
  ["ADMIN POST /api-key/scopes", "admin_authorization_manage", "admin"],
  ["ADMIN POST /api-key/delete", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/user/create", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/user/scopes", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/user/password", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/user/toggle", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/user/delete", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/client/revoke", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/client/delete", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/token/revoke", "admin_authorization_manage", "admin"],
  ["ADMIN POST /oauth/token/cleanup", "admin_authorization_manage", "admin"],
  ["ADMIN GET /vault-git", "admin_git_manage", "admin"], // §4.2 "Admin ... Git 设置"
  ["ADMIN POST /vault-git/refresh", "admin_git_manage", "admin"],
  ["ADMIN POST /vault-git/repair", "admin_git_manage", "admin"],
  ["ADMIN POST /vault-git/save", "admin_git_manage", "admin"],
  ["ADMIN POST /vault-git/verify", "admin_git_manage", "admin"],
  ["ADMIN POST /publish/revoke", "admin_publish_revoke", "admin"],
  // OAuth endpoints (P0 `f89ec47e`, mounted by `mcpAuthRouter` at `/oauth` in `server.js:157`).
  ["GET /oauth/authorize", "oauth_authorize", "oauth"],
  ["POST /oauth/decision", "oauth_authorize", "oauth"],
  ["POST /oauth/token", "oauth_code_exchange", "oauth"],
  ["POST /oauth/register", "oauth_client_register", "oauth"],
  ["POST /oauth/revoke", "oauth_token_revoke", "oauth"],
]);

const declared = new Map();
for (const group of TOOL_GROUPS) {
  for (const tool of group.tools) {
    if (declared.has(tool)) throw new Error(`Authorization catalog lists ${tool} twice`);
    if (!TOOL_NAMES.includes(tool)) throw new Error(`Authorization catalog has unknown tool ${tool}`);
    declared.set(tool, group);
  }
}
const missing = TOOL_NAMES.filter((name) => !declared.has(name));
if (missing.length > 0) throw new Error(`Authorization catalog is missing tools: ${missing.join(", ")}`);
for (const operation of EXTRA_OPERATIONS) {
  if (declared.has(operation.id)) throw new Error(`Authorization catalog lists ${operation.id} twice`);
  declared.set(operation.id, operation);
}

// Boundary index: tool names, resource URIs and `<METHOD> <path>` -> operation.
// `surfaces` of an operation is the set of surfaces its boundaries live on, plus
// the declared surfaces of an operation that has no boundary yet.
const boundaryIndex = new Map();
const boundarySurface = new Map();
function addBoundary(key, operationId, surface) {
  if (boundaryIndex.has(key)) throw new Error(`Authorization catalog maps boundary twice: ${key}`);
  if (!declared.has(operationId)) throw new Error(`Authorization catalog boundary ${key} targets unknown operation ${operationId}`);
  if (!SURFACES.includes(surface)) throw new Error(`Authorization catalog boundary ${key} has unknown surface ${surface}`);
  boundaryIndex.set(key, operationId);
  boundarySurface.set(key, surface);
}
for (const tool of TOOL_NAMES) addBoundary(tool, tool, "mcp");
for (const [key, operationId, surface] of BOUNDARY_ROWS) addBoundary(key, operationId, surface);

const surfacesById = new Map();
for (const id of declared.keys()) {
  const mine = new Set(DECLARED_SURFACES[id] ?? []);
  for (const [key, operationId] of boundaryIndex) {
    if (operationId === id) mine.add(boundarySurface.get(key));
  }
  surfacesById.set(id, Object.freeze(SURFACES.filter((surface) => mine.has(surface))));
}

const descriptors = new Map();
for (const [id, source] of declared) {
  const grantable = source.grantable ?? true;
  descriptors.set(id, Object.freeze({
    id,
    plane: source.plane,
    targetKind: source.targetKind,
    grantable,
    contentEffect: source.contentEffect,
    oauthScopes: source.oauthScopes ?? READ,
    surfaces: surfacesById.get(id),
  }));
}

const operationIds = Object.freeze([...descriptors.keys()].sort());
const boundaryKeys = Object.freeze([...boundaryIndex.keys()].sort());

/** The descriptor for an operation ID, or `null` for anything not cataloged. */
export function authorizationOperation(id) {
  return typeof id === "string" && descriptors.has(id) ? descriptors.get(id) : null;
}

/** The operation ID a boundary performs, or `null` for an unknown boundary. */
export function capabilityForBoundary(boundaryKey) {
  return typeof boundaryKey === "string" && boundaryIndex.has(boundaryKey) ? boundaryIndex.get(boundaryKey) : null;
}

/** Canonical tool operation IDs (test-facing: must equal `TOOL_NAMES`). */
export const catalogToolIds = Object.freeze(TOOL_NAMES.toSorted());

/** Every operation ID in the catalog, sorted. */
export const catalogOperationIds = operationIds;

// Identity, allowlist, public-shell and instance-metadata decisions, not content
// operations: no time constraint may reach them (§9 keeps public pages outside account
// time policy, and A-07 keeps the metadata plane reachable while a principal is
// suspended). The exemption is a property of the OPERATION, so it cannot be selected by
// a request string, and no operation may mix an exempt and a gated boundary:
//   * `vault_select`                 - GET /api/web/v1/session, POST /api/web/v1/vault/select
//   * `session_bootstrap`            - the public auth pages and the app shell
//   * `agent_bootstrap`,
//     `server_info`,
//     `agent_memory_policy_read`     - the instance metadata plane: no Vault content, and the
//                                      tool layer never evaluates it while suspended (A-07)
//   * `vault_list_read`              - GET /api/web/v1/vaults, which carried the legacy read
//                                      gate and therefore stays inside the plane.
// Registration and revocation run before an account subject exists and act on the client and
// token store, so no account's window can gate them.
const TEMPORAL_PLANE_EXEMPT_OPERATIONS = Object.freeze([
  "vault_select",
  "session_bootstrap",
  "agent_bootstrap",
  "server_info",
  "agent_memory_policy_read",
  "oauth_client_register",
  "oauth_token_revoke",
]);

/** True when no time constraint applies to this operation. */
export function isOutsideTemporalPlane(operationId) {
  return typeof operationId === "string" && TEMPORAL_PLANE_EXEMPT_OPERATIONS.includes(operationId);
}

/** The surface a boundary runs on, or `null` for an unknown boundary. */
export function surfaceForBoundary(boundaryKey) {
  return typeof boundaryKey === "string" && boundarySurface.has(boundaryKey) ? boundarySurface.get(boundaryKey) : null;
}

/** Every boundary key in the catalog, sorted (test-facing coverage check). */
export const catalogBoundaryKeys = boundaryKeys;
