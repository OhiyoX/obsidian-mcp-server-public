// A3 (#277/#278) — Publish lifecycle / Markdown-only characterization.
//
// Contract (authoritative):
//   _Workspace/40-Projects/obsidian_mcp_server/Web/
//     DEVELOPMENT - Issues 277-278 Publish 生命周期与 Markdown-only 边界收口.md
//   §1.1 current PublishService facts · §5.1 target transitions · §7 error codes ·
//   §8.1 v1→v2 evaluation points · §9 list/Admin/published consistency ·
//   §10 Wave A/A3 · §12 #278 matrix · §13.1/§13.3/§13.4 #277 lifecycle · §14 old red.
//
// Wave A / A3 is characterization only: this file adds no production code and
// changes no production behaviour. It drives the real PublishService (BASE
// `app/src/publish/service.js`) through the real Web vault registry backed by a
// temporary vault, so every observation below is a live behaviour, not a stub.
//
// The four pre-repair behaviours ("old red", §14) are frozen as explicit PENDING
// cases. Each PENDING case is gated by a *behavioural* probe executed at module
// scope against the production modules; the probe recomputes on every run, so
// each case activates by itself once B1 lands the fix. Nothing here checks for a
// missing file or returns early to fake a pass.
//
// Old-red evidence captured on the frozen BASE lives in
// `scratch/publish-277-278/A3/evidence/`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-characterization-"));
const vaultRoot = path.join(root, "vault");
const dataRoot = path.join(root, "data");
await fs.mkdir(vaultRoot, { recursive: true });
process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = dataRoot;
process.env.GIT_ENABLED = "false";
delete process.env.WEB_VAULTS_ROOT;

const { PublishService, decodeDocumentRoute, encodeDocumentRoute } = await import("../src/publish/service.js");

after(() => fs.rm(root, { recursive: true, force: true }));

const VAULT_ID = "default";
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
// Synthetic fixtures only: a 1x1 transparent PNG and short Markdown bodies.
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let stateSeq = 0;
const newService = () => new PublishService({ file: path.join(dataRoot, "publish", `probe-${++stateSeq}.json`) });
const absolute = (relative) => path.join(vaultRoot, ...relative.split("/"));
const writeNote = async (relative, content) => {
  await fs.mkdir(path.dirname(absolute(relative)), { recursive: true });
  await fs.writeFile(absolute(relative), content, "utf8");
};
const removeNote = (relative) => fs.rm(absolute(relative), { force: true });
const noteExists = async (relative) => {
  try {
    await fs.stat(absolute(relative));
    return true;
  } catch {
    return false;
  }
};
const attempt = async (run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, message: error?.message ?? String(error) };
  }
};
const hasRecord = (records, id) => Array.isArray(records) && records.some((record) => record.id === id);
const stateFileRecords = async (file) => JSON.parse(await fs.readFile(file, "utf8")).records ?? [];

// ---------------------------------------------------------------------------
// Behavioural probes (module scope, real production calls)
// ---------------------------------------------------------------------------

// Probe 1 (§12.2 / §14.1-2): is the Markdown-only gate enforced by the service?
const CANVAS = "Notes/diagram.canvas";
const PNG = "Notes/pixel.png";
await writeNote(CANVAS, JSON.stringify({ nodes: [], edges: [] }));
await fs.mkdir(path.dirname(absolute(PNG)), { recursive: true });
await fs.writeFile(absolute(PNG), Buffer.from(PNG_1PX, "base64"));

const gateService = newService();
const canvasPublish = await attempt(() => gateService.publish(VAULT_ID, CANVAS, { actor: "a3-probe" }));
const pngPublish = await attempt(() => gateService.publish(VAULT_ID, PNG, { actor: "a3-probe" }));
const canvasResolve = canvasPublish.ok ? await attempt(() => gateService.resolve(canvasPublish.value.id)) : { ok: false };
const pngResolve = pngPublish.ok ? await attempt(() => gateService.resolve(pngPublish.value.id)) : { ok: false };
const gateRecords = await gateService.list();
const nonMarkdownProbe = {
  canvasAccepted: canvasPublish.ok,
  pngAccepted: pngPublish.ok,
  canvasId: canvasPublish.ok ? canvasPublish.value.id : null,
  pngId: pngPublish.ok ? pngPublish.value.id : null,
  canvasRejectCode: canvasPublish.ok ? null : canvasPublish.code,
  pngRejectCode: pngPublish.ok ? null : pngPublish.code,
  canvasRecordListed: canvasPublish.ok && hasRecord(gateRecords, canvasPublish.value.id),
  canvasServedAsMarkdown: canvasPublish.ok && canvasResolve.ok && Boolean(canvasResolve.value),
  pngServedAsGarbage: pngPublish.ok && pngResolve.ok && Boolean(pngResolve.value)
    && pngResolve.value.note.content.includes("\uFFFD"),
};
nonMarkdownProbe.gateEnforced = !nonMarkdownProbe.canvasAccepted && !nonMarkdownProbe.pngAccepted;
const isMarkdownGateEnforced = () => nonMarkdownProbe.gateEnforced;

// Probe 2 (§13.3 / §14.3): does revoke() of a missing target stop throwing ENOENT?
const REVOKE_MISSING = "Notes/revoke-missing.md";
await writeNote(REVOKE_MISSING, "# revoke missing\n\nfixture body\n");
const revokeService = newService();
const missingRecord = await revokeService.publish(VAULT_ID, REVOKE_MISSING, { actor: "a3-probe" });
await removeNote(REVOKE_MISSING);
const statAfterDelete = await attempt(() => fs.stat(absolute(REVOKE_MISSING)));
const missingRevoke = await attempt(() => revokeService.revoke(VAULT_ID, REVOKE_MISSING));
const revokeMissingProbe = {
  recordExisted: Boolean(missingRecord?.id),
  targetMissing: !statAfterDelete.ok && statAfterDelete.code === "ENOENT",
  threw: !missingRevoke.ok,
  errorCode: missingRevoke.ok ? null : missingRevoke.code,
  revoked: missingRevoke.ok ? missingRevoke.value?.revoked : null,
  recordsAfter: (await stateFileRecords(revokeService.file)).length,
};
revokeMissingProbe.safe = !revokeMissingProbe.threw && revokeMissingProbe.revoked === true;
const isRevokeMissingSafe = () => revokeMissingProbe.safe;

// Probe 3 (§5.1 / §13.1 / §14.4): does an observed delete keep the old id dead?
const REVIVE = "Notes/revive.md";
await writeNote(REVIVE, "# first incarnation\n");
const reviveService = newService();
const firstPublish = await reviveService.publish(VAULT_ID, REVIVE, { actor: "a3-probe" });
const beforeDelete = await reviveService.resolve(firstPublish.id);
await removeNote(REVIVE);
const afterDelete = await reviveService.resolve(firstPublish.id); // §5.1: observe the missing target
await writeNote(REVIVE, "# second incarnation\n"); // recreate the very same path
const afterRecreate = await reviveService.resolve(firstPublish.id);
const republish = await attempt(() => reviveService.publish(VAULT_ID, REVIVE, { actor: "a3-probe" }));
const reviveProbe = {
  firstId: firstPublish.id,
  servedBeforeDelete: Boolean(beforeDelete),
  observedMissing: afterDelete === null,
  recreated: await noteExists(REVIVE),
  revived: Boolean(afterRecreate),
  revivedServesNewBody: Boolean(afterRecreate?.note?.content?.includes("second incarnation")),
  republishId: republish.ok ? republish.value.id : null,
  republishCreated: republish.ok ? republish.value.created : null,
  recordsAfter: (await stateFileRecords(reviveService.file)).length,
};
reviveProbe.oldIdStaysDead = !reviveProbe.revived
  && reviveProbe.republishId !== reviveProbe.firstId
  && reviveProbe.republishCreated === true;
const isObservedDeleteSticky = () => reviveProbe.oldIdStaysDead;

// Probe 4 (§8.1 / §9): does list() keep orphan records out of the public view?
const LIST_ORPHAN = "Notes/list-orphan.md";
await writeNote(LIST_ORPHAN, "# orphan\n");
const listService = newService();
const orphanRecord = await listService.publish(VAULT_ID, LIST_ORPHAN, { actor: "a3-probe" });
await removeNote(LIST_ORPHAN);
const adminView = await attempt(() => listService.list({ includeInactive: true }));
// §9 allows either a default-active list() or an explicit listActive(); accept both.
const publicView = await attempt(() => (typeof listService.listActive === "function" ? listService.listActive() : listService.list()));
const listProbe = {
  stateFileHoldsRecord: hasRecord(await stateFileRecords(listService.file), orphanRecord.id),
  adminViewIncludesOrphan: adminView.ok && hasRecord(adminView.value, orphanRecord.id),
  publicViewExcludesOrphan: publicView.ok && !hasRecord(publicView.value, orphanRecord.id),
  publicViewCount: publicView.ok ? publicView.value.length : null,
  publicViewError: publicView.ok ? null : publicView.message,
};
const isPublicListActiveOnly = () => listProbe.publicViewExcludesOrphan;

// ---------------------------------------------------------------------------
// PENDING skip reasons (behavioural probe failure, activated by B1)
// ---------------------------------------------------------------------------

const PENDING = {
  nonMarkdown: "PENDING §12.2 / §14.1-2: probe isMarkdownGateEnforced() = false — on BASE PublishService still accepts "
    + ".canvas and .png targets and serves them through the Markdown reader; activated by B1 (authoritative gate)",
  revokeMissing: "PENDING §13.3 / §14.3: probe isRevokeMissingSafe() = false — on BASE revoke() stats the current file "
    + "first, so a missing target raises ENOENT instead of reporting revoked; activated by B1",
  revive: "PENDING §5.1 / §13.1 / §14.4: probe isObservedDeleteSticky() = false — on BASE an observed delete does not "
    + "retire the record, so recreating the same path revives the old id and publish() reuses it; activated by B1",
  listActive: "PENDING §8.1 / §9: probe isPublicListActiveOnly() = false — on BASE list() still counts an orphan whose "
    + "file was deleted as a public candidate; activated by B1",
};

// ---------------------------------------------------------------------------
// Old-red cases: skip on BASE, active after B1
// ---------------------------------------------------------------------------

test("non-Markdown publish targets are rejected by the authoritative gate (§12.2 / §14.1-2)", {
  skip: isMarkdownGateEnforced() ? false : PENDING.nonMarkdown,
}, () => {
  const accepted = [];
  if (nonMarkdownProbe.canvasAccepted) accepted.push(`.canvas → id ${nonMarkdownProbe.canvasId}`);
  if (nonMarkdownProbe.pngAccepted) accepted.push(`.png → id ${nonMarkdownProbe.pngId} (garbage render: ${nonMarkdownProbe.pngServedAsGarbage})`);
  assert.deepEqual(accepted, [],
    `§12.2: .canvas/.base/.json/.txt/.png must be unsupported_publish_target, not publishable; observed ${JSON.stringify(accepted)}`);
  assert.equal(nonMarkdownProbe.canvasRejectCode, "unsupported_publish_target", "§7: the .canvas rejection must carry the domain code");
  assert.equal(nonMarkdownProbe.pngRejectCode, "unsupported_publish_target", "§7: the .png rejection must carry the domain code");
});

test("revoking a missing publish target succeeds without ENOENT (§13.3 / §14.3)", {
  skip: isRevokeMissingSafe() ? false : PENDING.revokeMissing,
}, () => {
  assert.equal(revokeMissingProbe.threw, false,
    `§13.3: revoke() must not depend on the current file; observed error=${revokeMissingProbe.errorCode} `
    + `(the record is still ${revokeMissingProbe.recordsAfter === 1 ? "present" : "gone"} in the state file)`);
  assert.equal(revokeMissingProbe.revoked, true, "§13.3: an orphan revoke must report revoked: true");
});

test("an observed delete keeps the old id dead after the path is recreated (§5.1 / §13.1 / §14.4)", {
  skip: isObservedDeleteSticky() ? false : PENDING.revive,
}, () => {
  assert.equal(reviveProbe.revived, false,
    `§5.1: after an observed missing the old id must stay 404; observed revived=${reviveProbe.revived} `
    + `serving the new body=${reviveProbe.revivedServesNewBody} republishId=${reviveProbe.republishId} `
    + `(first id=${reviveProbe.firstId}) republishCreated=${reviveProbe.republishCreated}`);
  assert.notEqual(reviveProbe.republishId, reviveProbe.firstId,
    `§13.1: an explicit republish must mint a new opaque id; observed republishId=${reviveProbe.republishId}`);
  assert.equal(reviveProbe.republishCreated, true, "§13.1: the explicit republish must create a new record");
});

test("list() does not expose an orphan record as a public candidate (§8.1 / §9)", {
  skip: isPublicListActiveOnly() ? false : PENDING.listActive,
}, () => {
  assert.equal(listProbe.publicViewExcludesOrphan, true,
    `§9: the published candidate view must not contain a record whose file was deleted; observed `
    + `error=${listProbe.publicViewError} publicViewCount=${listProbe.publicViewCount}`);
});

// ---------------------------------------------------------------------------
// Cross-validation — current behaviour that must stay green across the wave
// ---------------------------------------------------------------------------

test("Markdown publish is idempotent and keeps serving live edits (§13.4)", async () => {
  const service = newService();
  const livePath = "Notes/live.md";
  await writeNote(livePath, "# live\n\nfirst body\n");
  const first = await service.publish(VAULT_ID, livePath, { actor: "a3" });
  assert.equal(first.created, true);
  assert.match(first.id, OPAQUE_ID);
  assert.equal(first.path, livePath);
  const second = await service.publish(VAULT_ID, livePath, { actor: "a3" });
  assert.equal(second.id, first.id, "repeated publish of an active target must be idempotent");
  assert.equal(second.created, false);
  const served = await service.resolve(first.id);
  assert.equal(served.record.id, first.id);
  assert.match(served.note.content, /first body/);
  await writeNote(livePath, "# live\n\nsecond body\n");
  const servedAgain = await service.resolve(first.id);
  assert.match(servedAgain.note.content, /second body/, "§13.4: an actively edited document keeps the same id");
});

test("Uppercase .MD and extensionless targets resolve to their Markdown document (§12.1)", async () => {
  const service = newService();
  await writeNote("Notes/Upper.MD", "# upper\n");
  await writeNote("Notes/ext.md", "# extensionless\n");
  const upper = await service.publish(VAULT_ID, "Notes/Upper.MD", { actor: "a3" });
  assert.equal(upper.path, "Notes/Upper.MD");
  const extensionless = await service.publish(VAULT_ID, "Notes/ext", { actor: "a3" });
  assert.equal(extensionless.path, "Notes/ext.md", "§12.1: the canonical resolver appends .md to an extensionless target");
  assert.equal((await service.resolve(extensionless.id)).record.path, "Notes/ext.md");
});

test("Active revoke is idempotent and never revives the retired id (§13.3)", async () => {
  const service = newService();
  const activePath = "Notes/revoke-active.md";
  await writeNote(activePath, "# active\n");
  const record = await service.publish(VAULT_ID, activePath, { actor: "a3" });
  const revoked = await service.revoke(VAULT_ID, activePath);
  assert.equal(revoked.revoked, true);
  assert.equal(await service.resolve(record.id), null);
  const second = await service.revoke(VAULT_ID, activePath);
  assert.equal(second.revoked, false, "§13.3: a second revoke of the same path reports revoked: false");
});

test("opaque document routes still round trip (§15 S04 cross-validation)", () => {
  const encoded = encodeDocumentRoute(VAULT_ID, "Notes/live.md");
  assert.deepEqual(decodeDocumentRoute(encoded), { vaultId: VAULT_ID, path: "Notes/live.md" });
  assert.throws(() => decodeDocumentRoute(`${encoded}!`), /Invalid document route/);
});

test("non-Markdown probe reaches the real publish/resolve path (§14 cross-validation)", () => {
  if (nonMarkdownProbe.canvasAccepted) {
    assert.match(nonMarkdownProbe.canvasId, OPAQUE_ID, "on BASE .canvas is accepted with a real opaque id");
    assert.equal(nonMarkdownProbe.canvasRecordListed, true, "on BASE the .canvas record is a real published record");
    assert.equal(nonMarkdownProbe.canvasServedAsMarkdown, true, "on BASE the .canvas target is served by the anonymous reader");
    assert.equal(nonMarkdownProbe.pngServedAsGarbage, true, "§14.2: on BASE the .png record is served as garbage UTF-8");
  } else {
    assert.equal(nonMarkdownProbe.canvasRejectCode, "unsupported_publish_target", "§7: the gate must emit the domain code");
    assert.equal(nonMarkdownProbe.pngRejectCode, "unsupported_publish_target", "§7: the gate must emit the domain code");
  }
});

test("missing-revoke probe really deleted a real published target (§14.3 cross-validation)", () => {
  assert.equal(revokeMissingProbe.recordExisted, true, "the probe must publish before revoking");
  assert.equal(revokeMissingProbe.targetMissing, true, "the probe must delete the file before revoking");
  const expectedRecords = revokeMissingProbe.threw ? 1 : 0;
  assert.equal(revokeMissingProbe.recordsAfter, expectedRecords,
    "the probe must observe the real persisted state file (record survives a throwing revoke, disappears after a successful one)");
});

test("delete/recreate probe really observed the missing state (§13.1 cross-validation)", () => {
  assert.match(reviveProbe.firstId, OPAQUE_ID);
  assert.equal(reviveProbe.servedBeforeDelete, true, "the first incarnation must be served before the delete");
  assert.equal(reviveProbe.observedMissing, true, "§5.1: the probe must resolve the old id while the target is missing");
  assert.equal(reviveProbe.recreated, true, "the probe must recreate the same path");
  assert.ok(reviveProbe.recordsAfter >= 1, "the probe must read the real state file");
});

test("list probe keeps the orphan visible to the Admin view and on disk (§9 cross-validation)", () => {
  assert.equal(listProbe.stateFileHoldsRecord, true, "the orphan record must really be persisted, not merely synthesised");
  assert.equal(listProbe.adminViewIncludesOrphan, true, "§9: Admin must still be able to find and clean up the orphan");
});
