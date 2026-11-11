// P2 / Task 12 — the extracted Web READ boundaries.
//
// Contract: design §6.1.4 and §10 P2. Every extracted read route (base page, canvas
// page, base API, canvas API, note context, tags, tree, search) states its own catalog
// boundary key and builds its own gate; one request gives one row. A deny is recorded
// BEFORE any content read, so a denied request can never have touched the Vault, the
// catalog or a cache.
//
// The proof is a real router over real HTTP, twice: an allowing legacy gate (allowed
// rows) and a denying one (denied rows). For every route in both runs the row names
// the catalog capability — no second requirements table.
//
// "Missing route map" behaviour: the catalog lookup is the only map, an unmapped key
// yields no request at all (the shadow never invents an authorization), and the
// existing deny-by-default for an unregistered WRITE route still has to refuse.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW,
  DENY_SUSPEND,
  candidateFor,
  documentRoute,
  prepareEnv,
  startWebApp,
} from "./helpers/web-shadow-app.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-web-read-"));
const { vaultRoot, secondaryRoot } = await prepareEnv(root);
await fs.writeFile(path.join(vaultRoot, "Note.md"), "# Readable note\n", "utf8");
await fs.writeFile(path.join(secondaryRoot, "private.md"), "# Secondary sentinel\n", "utf8");
await fs.writeFile(path.join(vaultRoot, "Board.base"), "filters: []\n", "utf8");
await fs.writeFile(path.join(vaultRoot, "Scene.canvas"), JSON.stringify({ nodes: [], edges: [] }), "utf8");

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const GRANTED = Object.freeze([
  "get_note", "list_notes", "list_files", "search_notes", "list_tags", "get_note_context",
  "get_base", "get_canvas",
]);

/** Every extracted read boundary: the file that owns it, its catalog key, a request. */
async function boundaries() {
  const noteRoute = await documentRoute("vault", "Note.md");
  const baseRoute = await documentRoute("vault", "Board.base");
  const canvasRoute = await documentRoute("vault", "Scene.canvas");
  return [
    { file: "base-page.js", key: "GET /app/base/*", capability: "get_base", url: `/app/base/${baseRoute}`, status: 200 },
    { file: "canvas-page.js", key: "GET /app/canvas/*", capability: "get_canvas", url: `/app/canvas/${canvasRoute}`, status: 200 },
    { file: "base-route.js", key: "GET /api/web/v1/base", capability: "get_base", url: "/api/web/v1/base?path=Board.base" },
    { file: "canvas-route.js", key: "GET /api/web/v1/canvas", capability: "get_canvas", url: "/api/web/v1/canvas?path=Scene.canvas" },
    { file: "note-context.js", key: "GET /api/web/v1/note-context/outgoing", capability: "get_note_context", url: "/api/web/v1/note-context/outgoing?path=Note.md" },
    { file: "note-context.js", key: "GET /api/web/v1/note-context/incoming", capability: "get_note_context", url: "/api/web/v1/note-context/incoming?path=Note.md" },
    { file: "note-context.js", key: "GET /api/web/v1/note-context/unlinked", capability: "get_note_context", url: "/api/web/v1/note-context/unlinked?path=Note.md" },
    { file: "tags-route.js", key: "GET /api/web/v1/tags", capability: "list_tags", url: "/api/web/v1/tags" },
    { file: "web-catalog/tree-route.js", key: "GET /api/web/v2/tree", capability: "list_files", url: "/api/web/v2/tree" },
    { file: "web-catalog/search-route.js", key: "GET /api/web/v2/search", capability: "search_notes", url: "/api/web/v2/search?q=note" },
    { file: "routes.js (note page)", key: "GET /app/note/*", capability: "get_note", url: `/app/note/${noteRoute}`, status: 200 },
  ];
}

test("web_read_shadow_covers_deep_pages_catalog_and_direct_file_reads", async () => {
  const document = await candidateFor(GRANTED);
  const allowing = await startWebApp({ label: "read-allow", legacyDecision: ALLOW, document });
  const denying = await startWebApp({ label: "read-deny", legacyDecision: DENY_SUSPEND, document });
  const plain = await startWebApp({ label: "read-plain", legacyDecision: ALLOW, shadow: false, document });
  try {
    const session = await allowing.newSession();
    const denySession = await denying.newSession();
    const plainSession = await plain.newSession();
    const cases = await boundaries();

    // 1. Every listed boundary has a real ALLOWED row with its catalog capability.
    for (const entry of cases) {
      const before = allowing.summary().compared;
      const response = await allowing.get(entry.url, session.cookie);
      // The gate allowed. A catalog-backed route may then answer its own
      // `catalog-not-ready` 503 in this harness; the row is what this task covers.
      assert.notEqual(response.status, 403, `${entry.file} must not be refused by the temporal gate`);
      if (entry.status) assert.equal(response.status, entry.status, `${entry.file} ${entry.url}: ${response.body.slice(0, 120)}`);
      const after = allowing.summary();
      assert.equal(after.compared, before + 1, `${entry.key} is one request and one row`);
      const row = allowing.rows().at(-1);
      assert.equal(row.boundary, entry.key, `${entry.file} must state its catalog key`);
      assert.equal(row.capability, entry.capability, `${entry.file} must use the catalog capability`);
      assert.equal(row.oldAllowed, true);
      assert.equal(row.newAllowed, true, `${entry.file}: the granted candidate agrees`);
      assert.equal(after.differences, 0, `${entry.file} must not add a difference`);
    }

    // 2. The same boundaries under a denying old gate: a denied row each, and the
    //    deny is decided before any content read (403, never 404/500 for a missing file).
    for (const entry of cases) {
      const before = denying.summary().compared;
      const response = await denying.get(entry.url, denySession.cookie);
      assert.equal(response.status, 403, `${entry.file} must refuse before the read: ${response.body.slice(0, 120)}`);
      assert.match(response.body, /outside_authorized_window/);
      const after = denying.summary();
      assert.equal(after.compared, before + 1);
      const row = denying.rows().at(-1);
      assert.equal(row.boundary, entry.key);
      assert.equal(row.oldAllowed, false);
      assert.equal(row.newAllowed, true, "the candidate has no window, so the model would allow: a real difference");
      assert.equal(row.phase, "web");
    }
    // The denying run says "one difference per denied request" and nothing else.
    assert.equal(denying.summary().compared, cases.length);
    assert.equal(denying.summary().differences, cases.length);

    // 3. A deny precedes the read: an unknown path under a denying gate is a 403, not
    //    the handler's 404. Nothing looked the file up first.
    const missing = await denying.get("/api/web/v1/note-context/outgoing?path=absent.md", denySession.cookie);
    assert.equal(missing.status, 403);

    // 4. With no observer, no row exists and every answer is identical.
    for (const entry of cases) {
      const shadowed = await allowing.get(entry.url, session.cookie);
      const bare = await plain.get(entry.url, plainSession.cookie);
      assert.equal(bare.status, shadowed.status, `${entry.file}: the shadow changes no status`);
    }
    assert.equal(plain.summary().compared, 0, "no observer, no record");

    // 5. An unmapped read key is never authorized: the catalog is the only map.
    const library = await import("../src/authorization/adapters/web.js");
    assert.equal(library.webAuthorizationRequest({ session: { userId: "user-1", credentialId: "web-session:x", vaultId: "vault" }, routeKey: "GET /api/web/v1/not-a-boundary" }), null);
    assert.equal(library.webAuthorizationRequest({ session: { userId: "user-1", credentialId: "web-session:x", vaultId: "vault" }, routeKey: "GET /api/web/v2/unknown" }), null);
    // ... and the deny-by-default for an unregistered WRITE route still fires.
    const { webWriteRouteGate } = await import("../src/app/access-policy.js");
    const gate = webWriteRouteGate(null, "POST /api/web/v1/not-registered");
    const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    let nextCalled = 0;
    await gate({}, res, () => { nextCalled += 1; });
    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "web_write_route_not_registered" });

    // 6. Rows carry no path, query, body or CSRF token.
    const text = JSON.stringify(allowing.summary()) + JSON.stringify(allowing.rows());
    for (const leak of ["Note.md", "Readable note", "Board.base", "Scene.canvas", session.csrf, "oauth-user:"]) {
      assert.equal(text.includes(leak), false, `the record must not carry ${leak}`);
    }
  } finally {
    await allowing.close();
    await denying.close();
    await plain.close();
  }
});
