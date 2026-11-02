// #624: one precondition semantics for the two Web write faces.
//
// `PATCH /api/web/v1/base` answers a missing precondition with 428
// `precondition-required`; `POST /api/web/v1/note` answered the same situation with
// the classifier's 409 (`Existing notes require a revision`). Same meaning, two
// status codes, so a client had to special-case the surface. This file pins the
// unified three-row table over real HTTP (real router, real session, real CSRF,
// real disk — the #625 harness ships the middleware chain):
//
//   missing precondition + target exists     -> 428 precondition-required (both faces)
//   precondition does not match              -> 409 + the revision on disk (both faces)
//   no precondition + target missing         -> created (unchanged)
//   explicit If-Match: * + target missing    -> 409, nothing written (the caller declared
//     the target exists, so `*` is never a create; one conflict status, not RFC 412)
//
// The revision is `sha256(raw bytes)`; the non-UTF-8 note below is the witness, so a
// "hash the decoded string" regression fails here instead of silently accepting a
// client token that can never match (§#634).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { callRoute, startWebWriteSurface } from "./helpers/web-write-surface-harness.js";

const NOTE_ROUTE = { method: "POST", path: "/api/web/v1/note" };
const BASE_ROUTE = { method: "PATCH", path: "/api/web/v1/base" };
const BASE_DOC = "views:\n  - type: table\n    name: First\n    limit: 10\n";
const LIMIT_25 = [{ op: "set-view-option", view: "First", key: "limit", value: 25 }];
const STALE = `sha256:${"0".repeat(64)}`;
// `# bin\n` + two bytes that are not valid UTF-8: decoding then re-encoding changes them.
const BINARY_NOTE = Buffer.concat([Buffer.from("# bin\n", "utf8"), Buffer.from([0xff, 0xfe])]);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const revisionOf = (buf) => `sha256:${sha(buf)}`;
const noteCall = (body, headers = {}) => ({ ...NOTE_ROUTE, body, headers });
const baseCall = (body, headers = {}) => ({ ...BASE_ROUTE, body, headers });

// One app for the whole file: the harness reads VAULT_PATH/DATA_PATH at module-import
// time, so a second root in this process would be ignored. Tests therefore share the
// surface and never share a file — each one owns its own target.
const app = await startWebWriteSurface({ label: "web-write-preconditions" });
test.after(async () => {
  await app.close();
});
await fs.mkdir(path.join(app.vault, "Boards"), { recursive: true });
await fs.writeFile(path.join(app.vault, "Boards/Plan.base"), BASE_DOC, "utf8");
await fs.writeFile(path.join(app.vault, "Binary.md"), BINARY_NOTE);

/** A pre-existing note with exactly these bytes, for the "target exists" rows. */
const seed = async (rel, content) => {
  await fs.mkdir(path.dirname(path.join(app.vault, rel)), { recursive: true });
  await fs.writeFile(path.join(app.vault, rel), content);
  return content;
};

const readNote = async (notePath) =>
  (await fetch(`${app.base}/api/web/v1/note?path=${encodeURIComponent(notePath)}`, { headers: { Cookie: app.writer.cookie } })).json();
const readBaseRaw = async (basePath) => {
  const response = await fetch(`${app.base}/api/web/v1/base/raw?path=${encodeURIComponent(basePath)}`, { headers: { Cookie: app.writer.cookie } });
  return { status: response.status, etag: response.headers.get("etag"), body: await response.json() };
};

const diskOf = (rel) => fs.readFile(path.join(app.vault, rel));
const tmpLeftovers = async (dir) =>
  (await fs.readdir(path.join(app.vault, dir))).filter((name) => name.includes(".tmp"));

test("① existing note + no precondition ⇒ 428 precondition-required and zero bytes touched", async () => {
  const before = await seed("Blind.md", Buffer.from("# note\n", "utf8"));
  const response = await callRoute(app.base, noteCall({ path: "Blind.md", content: "# blind write\n" }), app.writer);

  assert.equal(response.status, 428);
  assert.equal(response.json.code, "precondition-required");
  assert.equal(response.json.error, "precondition-required");
  assert.deepEqual(Object.keys(response.json).sort(), ["code", "error", "message"]);
  // A client that used to special-case the 409 must be able to tell *why* 428 arrived.
  assert.match(response.json.message, /existing note requires a precondition/i);
  assert.equal(sha(await diskOf("Blind.md")), sha(before), "a refused blind write must not touch the file");
  assert.deepEqual(await tmpLeftovers("."), [], "no temp file survives a refused write");
});

test("② existing note + stale precondition ⇒ 409 carrying the revision on disk (not 'missing')", async () => {
  const disk = await seed("Stale.md", Buffer.from("# stale target\n", "utf8"));
  const bodyStale = await callRoute(app.base, noteCall({ path: "Stale.md", content: "# x\n", ifMatch: STALE }), app.writer);
  assert.equal(bodyStale.status, 409);
  assert.equal(bodyStale.json.error, "Revision conflict");
  assert.equal(bodyStale.json.currentRevision, revisionOf(disk), "the conflict must state the revision on disk");
  assert.equal(sha(await diskOf("Stale.md")), sha(disk), "a 409 must not touch the file");

  const headerStale = await callRoute(app.base, noteCall({ path: "Stale.md", content: "# x\n" }, { "If-Match": STALE }), app.writer);
  assert.equal(headerStale.status, 409);
  assert.equal(headerStale.json.currentRevision, revisionOf(disk));

  // The witness for `sha256(raw bytes)`: this file is not valid UTF-8, so a
  // decoded-then-hashed revision could never produce the token the read face hands out.
  const binary = await readNote("Binary.md");
  assert.equal(binary.revision, revisionOf(BINARY_NOTE));
  const binaryStale = await callRoute(app.base, noteCall({ path: "Binary.md", content: "# x\n", ifMatch: STALE }), app.writer);
  assert.equal(binaryStale.status, 409);
  assert.equal(binaryStale.json.currentRevision, revisionOf(BINARY_NOTE), "the CAS token stays sha256(raw bytes)");
  assert.equal(sha(await diskOf("Binary.md")), sha(BINARY_NOTE));
});

test("③ existing note + matching precondition ⇒ 200 and the revision advances", async () => {
  await seed("Cas.md", Buffer.from("# first\n", "utf8"));
  const live = await readNote("Cas.md");
  assert.equal(live.revision, revisionOf(await diskOf("Cas.md")));
  const response = await callRoute(app.base, noteCall({ path: "Cas.md", content: "# rewritten\n", ifMatch: live.revision }), app.writer);

  assert.equal(response.status, 200);
  assert.equal(response.json.created, false);
  assert.notEqual(response.json.revision, live.revision, "the revision must advance");
  assert.equal(response.json.revision, revisionOf(await diskOf("Cas.md")));
  assert.equal((await diskOf("Cas.md")).toString("utf8"), "# rewritten\n");
});

test("④ target missing + no precondition ⇒ created, exactly as before", async () => {
  const response = await callRoute(app.base, noteCall({ path: "Fresh/New.md", content: "# fresh\n" }), app.writer);

  assert.equal(response.status, 200);
  assert.equal(response.json.created, true);
  assert.equal((await diskOf("Fresh/New.md")).toString("utf8"), "# fresh\n");
  assert.equal(response.json.revision, revisionOf(await diskOf("Fresh/New.md")));
});

test("⑤ the two faces answer 428 with the same body shape and the same code", async () => {
  {
    const noteBytes = await seed("Shape.md", Buffer.from("# shape\n", "utf8"));
    const baseBytes = Buffer.from(BASE_DOC, "utf8");
    const noteMissing = await callRoute(app.base, noteCall({ path: "Shape.md", content: "# x\n" }), app.writer);
    const baseMissing = await callRoute(app.base, baseCall({ path: "Boards/Plan.base", mutations: LIMIT_25 }), app.writer);

    assert.equal(noteMissing.status, 428);
    assert.equal(baseMissing.status, 428);
    assert.deepEqual(Object.keys(noteMissing.json).sort(), Object.keys(baseMissing.json).sort());
    assert.deepEqual(Object.keys(baseMissing.json).sort(), ["code", "error", "message"]);
    assert.equal(noteMissing.json.code, baseMissing.json.code, "one frozen code for both faces");
    assert.equal(noteMissing.json.error, baseMissing.json.error);
    assert.equal(noteMissing.json.error, "precondition-required");
    // Same template, only the route name differs — and each names its own route.
    assert.match(noteMissing.json.message, /POST \/api\/web\/v1\/note requires If-Match \(or body ifMatch\)/);
    assert.match(baseMissing.json.message, /PATCH \/api\/web\/v1\/base requires If-Match \(or body ifMatch\)/);

    assert.equal(sha(await diskOf("Shape.md")), sha(noteBytes));
    assert.equal(sha(await diskOf("Boards/Plan.base")), sha(baseBytes));
  }
});

test("⑥ the If-Match header wins on both faces, from one shared reader", async () => {
  await seed("Priority.md", Buffer.from("# priority\n", "utf8"));
  const note = await readNote("Priority.md");
  // Note face: correct header, stale body ⇒ the header wins (it used to be ignored).
  const byHeader = await callRoute(app.base, noteCall({ path: "Priority.md", content: "# via header\n", ifMatch: STALE }, { "If-Match": note.revision }), app.writer);
  assert.equal(byHeader.status, 200);
  assert.equal((await diskOf("Priority.md")).toString("utf8"), "# via header\n");

  // A quoted ETag (what the read face issues) is the same token for both faces.
  const quoted = await readNote("Priority.md");
  assert.equal((await callRoute(app.base, noteCall({ path: "Priority.md", content: "# etag\n" }, { "If-Match": `"${quoted.revision}"` }), app.writer)).status, 200);
  const baseEtag = await readBaseRaw("Boards/Plan.base");
  assert.equal((await callRoute(app.base, baseCall({ path: "Boards/Plan.base", mutations: LIMIT_25 }, { "If-Match": baseEtag.etag }), app.writer)).status, 200);

  // Base face: stale header, matching body ⇒ the header still wins (reference behaviour).
  const baseNow = await readBaseRaw("Boards/Plan.base");
  const baseHeaderWins = await callRoute(app.base, baseCall({ path: "Boards/Plan.base", mutations: LIMIT_25, ifMatch: baseNow.body.revision }, { "If-Match": STALE }), app.writer);
  assert.equal(baseHeaderWins.status, 409);
  assert.equal(baseHeaderWins.json.code, "BASE_REVISION_CONFLICT");

  // One reader, not one per face: neither route file carries its own copy.
  const shared = await import("../src/app/web-precondition.js");
  assert.equal(typeof shared.readPrecondition, "function");
  assert.equal(shared.readPrecondition({ get: () => undefined, body: {} }), null, "no token at all stays 'none'");
  assert.equal(shared.readPrecondition({ get: () => undefined, body: { ifMatch: "*" } }), "*", "`*` is kept literal, never unwrapped into a revision");
  for (const file of ["routes.js", "base-patch-route.js"]) {
    const source = await fs.readFile(new URL(`../src/app/${file}`, import.meta.url), "utf8");
    assert.match(source, /from "\.\/web-precondition\.js"/, `${file} must import the shared precondition reader`);
    assert.doesNotMatch(source, /function readPrecondition/, `${file} must not carry its own copy of the reader`);
  }
});

test("#624: an explicit If-Match: * against a missing note is refused (409) and writes nothing", async () => {
  const target = "StarTarget/Missing.md";
  const absolute = path.join(app.vault, target);
  await assert.rejects(fs.access(absolute), /ENOENT/, "the target must be absent before the request");

  // The header, which this face only started reading in #624: before that, `*` was
  // ignored here and the same request created the note (the regression this pins).
  const byHeader = await callRoute(app.base, noteCall({ path: target, content: "# created by a star?\n" }, { "If-Match": "*" }), app.writer);
  assert.equal(byHeader.status, 409, "`*` declares the target exists, so a missing one is a conflict, not a create");
  assert.equal(byHeader.json.error, "Revision conflict");
  assert.equal(byHeader.json.code, "WEB_NOTE_REVISION_CONFLICT");
  assert.equal(byHeader.json.expectedRevision, "*", "the face echoes the token the caller sent in the header");
  assert.equal(byHeader.json.currentRevision, null, "nothing is on disk, so there is no revision to report");

  // Zero bytes touched: no note, no parent directory, no temp file anywhere near it.
  await assert.rejects(fs.access(absolute), /ENOENT/, "a refused precondition write must not create the target");
  await assert.rejects(fs.readdir(path.join(app.vault, "StarTarget")), /ENOENT/, "not even the target's directory");
  assert.deepEqual(await tmpLeftovers("."), [], "no temp file survives a refused write");

  // The body form reaches the same row through the same shared reader.
  const byBody = await callRoute(app.base, noteCall({ path: target, content: "# created by a star?\n", ifMatch: "*" }), app.writer);
  assert.equal(byBody.status, 409);
  assert.equal(byBody.json.code, "WEB_NOTE_REVISION_CONFLICT");
  assert.equal(byBody.json.expectedRevision, "*");
  await assert.rejects(fs.access(absolute), /ENOENT/, "the body form must not create the target either");

  // The row that must stay open: no precondition at all still creates (test ④).
  const blindCreate = await callRoute(app.base, noteCall({ path: "StarTarget/Fresh.md", content: "# fresh\n" }), app.writer);
  assert.equal(blindCreate.status, 200, "`*` is refused, but a create with no precondition at all is still allowed");
  assert.equal(blindCreate.json.created, true);
});
