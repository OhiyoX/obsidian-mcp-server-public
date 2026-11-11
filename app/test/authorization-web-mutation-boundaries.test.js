// P2 / Task 13 — the extracted Web MUTATION boundaries.
//
// Contract: design §6.1.4 and §10 P2. The asset upload (`POST /api/web/v1/asset`)
// and the Base write face (`GET /api/web/v1/base/raw` + `PATCH /api/web/v1/base`)
// state their own catalog boundary keys (`write_file`, `get_base`, `patch_base`) and
// build their own gate. The old gate alone decides; the row is recorded before the
// write, and a refused request changes no bytes, no revision and no journal entry.
//
// The old contracts stay exactly as they are: the asset route keeps its read+write
// Scope pair and gains NO `obsidian.files` requirement, and the Base patch keeps its
// CSRF, 428, 409 and scope families.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW,
  DEFAULT_USER,
  DENY_SUSPEND,
  candidateFor,
  prepareEnv,
  startWebApp,
} from "./helpers/web-shadow-app.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-web-mutation-"));
const { vaultRoot } = await prepareEnv(root);

const PLAN_BASE = [
  "views:\n",
  "  - type: table\n",
  "    name: First\n",
  "    limit: 10\n",
  "  - type: table\n",
  "    name: Second\n",
  "    limit: 5\n",
].join("");
const PLAN_PATH = "Boards/Plan.base";
const planFile = path.join(vaultRoot, PLAN_PATH);
await fs.mkdir(path.join(vaultRoot, "Boards"), { recursive: true });
await fs.writeFile(planFile, PLAN_BASE, "utf8");
await fs.writeFile(path.join(vaultRoot, "Note.md"), "# Source note\n", "utf8");

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const sha256 = (text) => `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
const readPlan = () => fs.readFile(planFile, "utf8");
const GRANTED = Object.freeze(["get_base", "patch_base", "write_file", "get_note"]);

async function app(options) {
  const document = await candidateFor(GRANTED);
  return startWebApp({ document, ...options });
}

/** The ETag of a `.base` document, from the raw view that exists for exactly this. */
async function rawEtag(instance, cookie) {
  const response = await instance.get(`/api/web/v1/base/raw?path=${encodeURIComponent(PLAN_PATH)}`, cookie);
  assert.equal(response.status, 200, response.body.slice(0, 160));
  const tag = response.headers.get("etag");
  assert.ok(tag, "the raw view must publish an ETag");
  return tag;
}

test("web_mutation_shadow_keeps_asset_and_base_scope_contracts", async () => {
  const allowing = await app({ label: "mutate-allow", legacyDecision: ALLOW });
  const denying = await app({ label: "mutate-deny", legacyDecision: DENY_SUSPEND });
  const readOnlyUser = await app({
    label: "mutate-readonly",
    legacyDecision: ALLOW,
    user: { ...DEFAULT_USER, id: "user-reader", username: "reader", allowedScopes: ["obsidian.read"] },
  });
  try {
    const session = await allowing.newSession();
    const denySession = await denying.newSession();
    const readerSession = await readOnlyUser.newSession();

    // 1. The asset upload keeps its read+write Scope pair: this session holds NO
    //    `obsidian.files`, and the write still succeeds. No `files` requirement is added.
    assert.equal(DEFAULT_USER.allowedScopes.includes("obsidian.files"), false);
    const before = allowing.summary().compared;
    const uploaded = await allowing.post("/api/web/v1/asset?from=Note.md", {
      cookie: session.cookie,
      csrf: session.csrf,
      body: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
      contentType: "application/octet-stream",
      headers: { "x-file-name": "picture.png" },
    });
    assert.ok([200, 201].includes(uploaded.status), `the asset write must land: ${uploaded.status} ${uploaded.body.slice(0, 160)}`);
    assert.equal(allowing.summary().compared, before + 1, "one asset write is one row");
    const assetRow = allowing.rows().at(-1);
    assert.equal(assetRow.boundary, "POST /api/web/v1/asset");
    assert.equal(assetRow.capability, "write_file");
    assert.equal(assetRow.oldAllowed, true);
    assert.equal(assetRow.newAllowed, true);
    assert.equal(allowing.summary().differences, 0);

    // 2. The Base raw view and the PATCH: each is one row, with its catalog capability.
    const etag = await rawEtag(allowing, session.cookie);
    const rawRow = allowing.rows().at(-1);
    assert.equal(rawRow.boundary, "GET /api/web/v1/base/raw");
    assert.equal(rawRow.capability, "get_base");

    const patched = await allowing.patch("/api/web/v1/base", {
      cookie: session.cookie,
      csrf: session.csrf,
      body: { path: PLAN_PATH, mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 42 }] },
      headers: { "If-Match": etag },
    });
    assert.equal(patched.status, 200, patched.body.slice(0, 200));
    assert.equal(JSON.parse(patched.body).changed, true);
    assert.match(await readPlan(), /limit: 42/, "the patch landed on disk");
    const patchRow = allowing.rows().at(-1);
    assert.equal(patchRow.boundary, "PATCH /api/web/v1/base");
    assert.equal(patchRow.capability, "patch_base");
    assert.equal(patchRow.oldAllowed, true);
    assert.equal(patchRow.newAllowed, true);

    // 3. The old Base error families are unchanged, and each still records one row.
    const bytesAfterPatch = await readPlan();
    const stale = await allowing.patch("/api/web/v1/base", {
      cookie: session.cookie, csrf: session.csrf,
      body: { path: PLAN_PATH, mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 7 }] },
      headers: { "If-Match": etag }, method: "PATCH",
    });
    assert.equal(stale.status, 409, "a stale precondition is a 409");
    assert.equal(await readPlan(), bytesAfterPatch, "a 409 writes nothing");

    const blind = await allowing.patch("/api/web/v1/base", {
      cookie: session.cookie, csrf: session.csrf,
      body: { path: PLAN_PATH, mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 8 }] },
    });
    assert.equal(blind.status, 428, "a blind write is a 428");
    assert.equal(await readPlan(), bytesAfterPatch);

    const countBeforeCsrf = allowing.summary().compared;
    const noCsrf = await allowing.patch("/api/web/v1/base", {
      cookie: session.cookie,
      body: { path: PLAN_PATH, mutations: [] },
      headers: { "If-Match": sha256(bytesAfterPatch) },
    });
    assert.equal(noCsrf.status, 403, "CSRF is refused first");
    assert.equal(allowing.summary().compared, countBeforeCsrf, "a CSRF refusal records no authorization row");
    assert.equal(await readPlan(), bytesAfterPatch);

    // 4. The legacy scope rule still refuses the write for a read-only account: the
    //    asset route answers "write permission", not "file permission".
    const readOnlyAsset = await readOnlyUser.post("/api/web/v1/asset", {
      cookie: readerSession.cookie, csrf: readerSession.csrf,
      body: Buffer.from("nope"), contentType: "application/octet-stream",
    });
    assert.equal(readOnlyAsset.status, 403);
    assert.deepEqual(JSON.parse(readOnlyAsset.body), { error: "Account does not have write permission" });

    // 5. A temporal deny: the write never happens, and the row names a real difference.
    const planBeforeDeny = await readPlan();
    const deniedPatch = await denying.patch("/api/web/v1/base", {
      cookie: denySession.cookie, csrf: denySession.csrf,
      body: { path: PLAN_PATH, mutations: [{ op: "set-view-option", view: "First", key: "limit", value: 3 }] },
      headers: { "If-Match": sha256(planBeforeDeny) },
    });
    assert.equal(deniedPatch.status, 403);
    assert.match(deniedPatch.body, /outside_authorized_window/);
    assert.equal(await readPlan(), planBeforeDeny, "a refused patch writes no bytes");
    assert.equal(denying.summary().compared, 1);
    assert.equal(denying.rows()[0].capability, "patch_base");
    assert.equal(denying.rows()[0].oldAllowed, false);
    assert.equal(denying.rows()[0].newAllowed, true, "the candidate has no window: a real difference");
    assert.equal(denying.audits.filter((entry) => entry.action === "web.base.patch").length, 0, "no patch audit for a refused write");

    const attachmentsBefore = await fs.readdir(path.join(vaultRoot, "attachments")).catch(() => []);
    const deniedAsset = await denying.post("/api/web/v1/asset", {
      cookie: denySession.cookie, csrf: denySession.csrf,
      body: Buffer.from("nope"), contentType: "application/octet-stream",
    });
    assert.equal(deniedAsset.status, 403);
    assert.equal(denying.summary().compared, 2);
    assert.equal(denying.rows()[1].capability, "write_file");
    assert.equal(denying.audits.filter((entry) => entry.action === "web.asset.create").length, 0);
    const attachmentsAfter = await fs.readdir(path.join(vaultRoot, "attachments")).catch(() => []);
    assert.deepEqual(attachmentsAfter, attachmentsBefore, "a refused upload creates no asset");

    // 6. No path, body or scope leaked into the record.
    const text = JSON.stringify(allowing.summary()) + JSON.stringify(allowing.rows()) + JSON.stringify(denying.rows());
    for (const leak of ["Plan.base", "picture.png", "oauth-user:", session.csrf]) {
      assert.equal(text.includes(leak), false, `the record must not carry ${leak}`);
    }
  } finally {
    await allowing.close();
    await denying.close();
    await readOnlyUser.close();
  }
});
