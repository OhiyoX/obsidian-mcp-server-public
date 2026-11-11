// P2 / Task 16 — the anonymous Publish link as an exact delegation.
//
// Contract: design §6.1.6 and §10 P2. A public link delegates exactly ONE record: its
// own Vault and its own path, read from the service's verified record. The publisher's
// account is never consulted, so narrowing the publisher cannot revoke a link, and the
// link can never lend its publisher's rights to another document or another Vault.
//
// The row is recorded after the record passed its lifecycle check and BEFORE the body
// is read, so a refusal never happens after content I/O, and every row names the
// publication target.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ALLOW, DEFAULT_USER, candidateFor, prepareEnv, startWebApp } from "./helpers/web-shadow-app.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-publish-"));
const { vaultRoot } = await prepareEnv(root);
await fs.writeFile(path.join(vaultRoot, "Note.md"), "# Published note\n\nbody\n", "utf8");
await fs.writeFile(path.join(vaultRoot, "Other.md"), "# Other note: never public\n", "utf8");

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const GRANTED = Object.freeze(["get_note", "write_note", "manage_publish", "get_publish_status"]);

/** Publish `Note.md` through the real Web write path and return its public id. */
async function publish(app, session) {
  const written = await app.post("/api/web/v1/publish", {
    cookie: session.cookie,
    csrf: session.csrf,
    body: { path: "Note.md", action: "publish" },
  });
  assert.equal(written.status, 200, written.body.slice(0, 160));
  const payload = JSON.parse(written.body);
  assert.equal(payload.published, true);
  return payload.publicPath;
}

/** A public read outside the Web app (no cookie): the anonymous contract. */
async function publicRead(app, publicPath) {
  const response = await app.get(publicPath);
  return { status: response.status, body: response.body };
}

test("publication_delegation_reads_one_active_record_and_no_other_vault_content", async () => {
  const document = await candidateFor(GRANTED);
  const app = await startWebApp({ label: "publish", legacyDecision: ALLOW, document });
  const baseline = await startWebApp({ label: "publish-baseline", legacyDecision: ALLOW, shadow: false, document });
  try {
    const session = await app.newSession();
    const baselineSession = await baseline.newSession();
    const publicPath = await publish(app, session);
    const baselinePath = await publish(baseline, baselineSession);

    // 1. The active link serves its own note, and records ONE publication row.
    const before = app.summary().compared;
    const served = await publicRead(app, publicPath);
    assert.equal(served.status, 200);
    assert.match(served.body, /Published note/);
    assert.equal(served.body.includes("never public"), false, "no other Vault content is ever read");
    const after = app.summary();
    assert.equal(after.compared, before + 1, "one public read is one authorization unit");
    const row = app.rows().at(-1);
    assert.equal(row.boundary, "GET /publish/:id");
    assert.equal(row.phase, "publish");
    assert.equal(row.surface, "publish");
    assert.equal(row.capability, "publish_document_read");
    assert.equal(row.targetKind, "publication");
    assert.equal(row.oldAllowed, true);
    assert.equal(row.newAllowed, true);
    assert.equal(after.differences, 0);
    // The baseline answers the same and records nothing.
    const baselineServed = await publicRead(baseline, baselinePath);
    assert.equal(baselineServed.status, 200);
    assert.equal(baselineServed.body.split("Published note").length, served.body.split("Published note").length);
    assert.equal(baseline.summary().compared, 0);

    // 2. An unknown or malformed id is a 404 with no row at all: no verified record, no
    //    authorization unit, no target.
    const rowsBeforeUnknown = app.summary().compared;
    assert.equal((await publicRead(app, "/publish/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status, 404);
    assert.equal((await publicRead(app, "/publish/not-an-id")).status, 404);
    assert.equal(app.summary().compared, rowsBeforeUnknown, "an unknown id has no authorization target");

    // 3. A revoked record answers 404 and never serves the body; the shadow keeps it dead.
    const revoked = await app.post("/api/web/v1/publish", {
      cookie: session.cookie, csrf: session.csrf, body: { path: "Note.md", action: "revoke" },
    });
    assert.equal(revoked.status, 200, revoked.body.slice(0, 160));
    const retired = await publicRead(app, publicPath);
    assert.equal(retired.status, 404);
    assert.equal(retired.body.includes("Published note"), false);

    // 4. Narrowing the PUBLISHER does not revoke a live link: the delegation is the
    //    record, not the account. Re-publish first (a live link), then narrow, then read.
    const secondPath = await publish(app, session);
    assert.equal((await publicRead(app, secondPath)).status, 200);
    app.user.allowedScopes = ["obsidian.read"];
    const afterNarrowing = await publicRead(app, secondPath);
    assert.equal(afterNarrowing.status, 200, "a narrowed publisher does not take the link down");
    assert.match(afterNarrowing.body, /Published note/);
    assert.equal(app.summary().differences, 0, "the delegation never consults the publisher");

    // 5. The delegation cannot name a Vault or a path, and it carries no subject: the
    //    adapter builds the actor from the record id alone.
    const { publicationAuthorizationRequest, publicationVerifiedActor } = await import("../src/authorization/adapters/publish.js");
    const request = publicationAuthorizationRequest({ id: "A".repeat(43) });
    assert.deepEqual(request.target, { kind: "publication", id: "A".repeat(43) });
    assert.equal(request.surface, "publish");
    assert.equal(request.capability, "publish_document_read");
    assert.deepEqual(request.actor.subjectIds, [], "a link is not a person's credential");
    assert.deepEqual(request.actor.proof, { kind: "publication", id: "A".repeat(43) });
    assert.equal(publicationVerifiedActor({ id: "" }), null);
    // A URL-shaped id stays an opaque publication id: it can never become a Vault target
    // or a path, so a link cannot point the delegation at another document.
    const odd = publicationAuthorizationRequest({ id: "vault/../../Other.md" });
    assert.equal(odd.target.kind, "publication");
    assert.equal(odd.target.vaultId, undefined);

    // 6. No path, digest or publisher subject enters the record.
    const text = JSON.stringify(app.summary()) + JSON.stringify(app.rows());
    for (const leak of ["Note.md", "Published note", "oauth-user:", DEFAULT_USER.id]) {
      assert.equal(text.includes(leak), false, `the record must not carry ${leak}`);
    }
  } finally {
    await app.close();
    await baseline.close();
  }
});
