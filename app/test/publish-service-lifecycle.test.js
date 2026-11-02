// B1 — PublishService integration: #278 Markdown-only gate + #277 lifecycle wiring.
//
// Contract (authoritative):
//   _Workspace/40-Projects/obsidian_mcp_server/Web/
//     DEVELOPMENT - Issues 277-278 Publish 生命周期与 Markdown-only 边界收口.md
//   §7 error codes · §8 persistence/migration · §12 #278 matrix · §13 #277 lifecycle ·
//   §14 old red · §15 invariants · §22 DoD.
//
// This file drives the *real* PublishService against a temporary Vault (no stubs): the
// authoritative gate now lives in the service, so every row below is the production path
// a Web route / MCP tool delegates to. The A3 characterization file owns the old-red
// evidence; this file owns the wired contract + the two env-gated negative controls.
//
// Negative controls: `P278_B1_NEGATIVE=<key>|all` runs an old-red probe that MUST fail
// against the wired service, proving the green assertions are real detectors.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-b1-"));
const vaultRoot = path.join(root, "vault");
const dataRoot = path.join(root, "data");
await fs.mkdir(path.join(vaultRoot, "Notes"), { recursive: true });
process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = dataRoot;
// A 2 KiB read limit keeps the §12.2 oversize row cheap and deterministic.
process.env.MAX_READ_BYTES = "2048";
process.env.GIT_ENABLED = "false";
delete process.env.WEB_VAULTS_ROOT;

const { PublishService } = await import("../src/publish/service.js");
const target = await import("../src/publish/target.js");
const lifecycle = await import("../src/publish/lifecycle.js");

test.after(() => fs.rm(root, { recursive: true, force: true }));

const VAULT = "default";
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
let sequence = 0;
const newService = () => new PublishService({ file: path.join(dataRoot, "publish", `state-${++sequence}.json`) });
const abs = (relative) => path.join(vaultRoot, ...relative.split("/"));
const write = async (relative, content) => {
  await fs.mkdir(path.dirname(abs(relative)), { recursive: true });
  await fs.writeFile(abs(relative), content);
};
const remove = (relative) => fs.rm(abs(relative), { force: true });
const attempt = async (run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, error };
  }
};
const persistedLifecycle = async (file, id) => {
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  return state.records.find((record) => record.id === id)?.lifecycle ?? null;
};

// ---------------------------------------------------------------- §12 target gate

test("§12.1 accepts Markdown (uppercase + extensionless) and reports the canonical path", async () => {
  await write("Notes/a.md", "# a\n");
  await write("Notes/Upper.MD", "# upper\n");
  await write("Notes/ext.md", "# ext\n");
  const service = newService();

  const a = await service.publish(VAULT, "Notes/a.md");
  assert.match(a.id, OPAQUE);
  assert.equal(a.path, "Notes/a.md");
  assert.equal(a.created, true);
  assert.equal(a.lifecycle, "active");

  assert.equal((await service.publish(VAULT, "Notes/Upper.MD")).path, "Notes/Upper.MD");
  assert.equal((await service.publish(VAULT, "Notes/ext")).path, "Notes/ext.md", "§12.1: assumeMarkdown appends .md");

  const again = await service.publish(VAULT, "Notes/a");
  assert.equal(again.id, a.id, "an active target stays idempotent (§13.4)");
  assert.equal(again.created, false);
  assert.deepEqual((await service.list()).map((record) => record.path).sort(), ["Notes/Upper.MD", "Notes/a.md", "Notes/ext.md"]);
});

test("§12.2 rejects non-Markdown/missing/directory/oversize/absolute targets with the frozen codes", async () => {
  await write("Notes/diagram.canvas", "{}");
  await write("Notes/x.base", "{}");
  await write("Notes/x.json", "{}");
  await write("Notes/x.txt", "text\n");
  await write("Notes/x.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await write("Notes/huge.md", "x".repeat(4096));
  await fs.mkdir(abs("Notes/dir.md"), { recursive: true });
  const service = newService();

  for (const relative of ["Notes/diagram.canvas", "Notes/x.base", "Notes/x.json", "Notes/x.txt", "Notes/x.png"]) {
    assert.equal((await attempt(() => service.publish(VAULT, relative))).code, "unsupported_publish_target", relative);
  }
  for (const relative of ["Notes/missing.md", "Notes/missing", "Notes/nope.md"]) {
    assert.equal((await attempt(() => service.publish(VAULT, relative))).code, "publish_target_missing", relative);
  }
  assert.equal((await attempt(() => service.publish(VAULT, "Notes/dir.md"))).code, "publish_target_not_a_file", "a directory is not a file");
  assert.equal((await attempt(() => service.publish(VAULT, "Notes/huge.md"))).code, "publish_target_too_large", "oversize target");
  for (const relative of ["../escape.md", "/etc/passwd.md", "C:/x.md", "\\\\server\\share\\x.md", "", "   "]) {
    assert.equal((await attempt(() => service.publish(VAULT, relative))).code, "invalid_publish_target_path", JSON.stringify(relative));
  }
  assert.deepEqual(await service.list({ includeInactive: true }), [], "no rejected target may be recorded");
});

test("§12.3 a v1 state migrates fail-closed and persists as v2", async () => {
  await write("Notes/ok.md", "# ok\n");
  await write("Notes/diagram.canvas", "{}");
  const file = path.join(dataRoot, "publish", "legacy.json");
  const stamp = "2026-01-01T00:00:00.000Z";
  const ids = { nonMd: "A".repeat(43), orphan: "B".repeat(43), healthy: "C".repeat(43) };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    records: [
      { id: ids.nonMd, vaultId: VAULT, path: "Notes/diagram.canvas", createdAt: stamp, updatedAt: stamp, createdBy: "legacy" },
      { id: ids.orphan, vaultId: VAULT, path: "Notes/ghost.md", createdAt: stamp, updatedAt: stamp, createdBy: "legacy" },
      { id: ids.healthy, vaultId: VAULT, path: "Notes/ok.md", createdAt: stamp, updatedAt: stamp, createdBy: "legacy" },
    ],
  }));
  const service = new PublishService({ file });
  await service.ready;

  // A v1 record is NEVER assumed active: the first observation decides (§8.1).
  assert.deepEqual(
    (await service.list({ includeInactive: true })).map((record) => [record.path, record.lifecycle]).sort(),
    [["Notes/diagram.canvas", "invalid"], ["Notes/ghost.md", "orphaned"], ["Notes/ok.md", "active"]],
  );
  assert.deepEqual((await service.list()).map((record) => record.path), ["Notes/ok.md"], "published candidates are active only (§9)");

  assert.equal(await service.resolve(ids.nonMd), null, "a non-Markdown record fails closed (§15 S07)");
  assert.equal(await service.resolve(ids.orphan), null, "a missing record fails closed");
  assert.equal((await service.resolve(ids.healthy)).record.id, ids.healthy);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).version, 2, "the migrated state is persisted as v2");
});

test("§8.1 a single bad record is dropped without stopping the service; a broken file is fatal", async () => {
  const file = path.join(dataRoot, "publish", "partial.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    records: [
      { id: "", vaultId: VAULT, path: "Notes/ok.md" },
      { id: "D".repeat(43), vaultId: VAULT, path: "Notes/ok.md" },
    ],
  }));
  const service = new PublishService({ file });
  await service.ready;
  assert.equal((await service.list({ includeInactive: true })).length, 1, "the good record still loads");
  assert.ok(service.migrationIssues.some((issue) => /record_id_missing/.test(issue)), "the drop is reported, not silent");

  const broken = path.join(dataRoot, "publish", "broken.json");
  await fs.writeFile(broken, JSON.stringify({ version: 1, records: "nope" }));
  await assert.rejects(new PublishService({ file: broken }).ready, /Cannot load publish state/);
  await fs.writeFile(broken, "{not json");
  await assert.rejects(new PublishService({ file: broken }).ready, /Cannot load publish state/);
  await fs.writeFile(broken, JSON.stringify({ version: 9, records: [] }));
  await assert.rejects(new PublishService({ file: broken }).ready, /unsupported state version/);
});

// ---------------------------------------------------------------- §13 lifecycle

test("§13.1 an observed delete retires the record; the old id never revives and restart keeps it dead", async () => {
  await write("Notes/life.md", "# v1\n");
  const service = newService();
  const first = await service.publish(VAULT, "Notes/life.md");
  assert.match((await service.resolve(first.id)).note.content, /v1/);

  await remove("Notes/life.md");
  assert.equal(await service.resolve(first.id), null, "an observed missing → 404");
  assert.equal(await persistedLifecycle(service.file, first.id), "orphaned", "the transition is persisted");

  await write("Notes/life.md", "# v2\n");
  assert.equal(await service.resolve(first.id), null, "a recreated path may never revive the old id");
  const second = await service.publish(VAULT, "Notes/life.md");
  assert.notEqual(second.id, first.id, "an explicit republish mints a new opaque id (§13.1)");
  assert.equal(second.created, true);
  assert.match((await service.resolve(second.id)).note.content, /v2/);

  const restarted = new PublishService({ file: service.file });
  await restarted.ready;
  assert.equal(await restarted.resolve(first.id), null, "the retired id stays dead across a restart");
});

test("§13.2 a rename is revocable by the old path; the new path is not auto-published", async () => {
  await write("Notes/b.md", "# b\n");
  const service = newService();
  const record = await service.publish(VAULT, "Notes/b.md");

  await fs.rename(abs("Notes/b.md"), abs("Notes/b-renamed.md"));
  assert.equal(await service.resolve(record.id), null, "the old id 404s once the target moved");
  assert.equal((await service.revoke(VAULT, "Notes/b.md")).revoked, true, "the old path is revocable although the file is gone");
  assert.equal((await service.status(VAULT, "Notes/b-renamed.md")).record, null, "the new path is not auto-published");

  const republished = await service.publish(VAULT, "Notes/b-renamed.md");
  assert.notEqual(republished.id, record.id);
  assert.equal((await service.resolve(republished.id)).record.path, "Notes/b-renamed.md");
});

test("§13.3 revoke is idempotent and never fails on a missing/unrecorded path", async () => {
  await write("Notes/r.md", "# r\n");
  const service = newService();
  const record = await service.publish(VAULT, "Notes/r.md");

  assert.equal((await service.revoke(VAULT, "Notes/r.md")).revoked, true, "active revoke → true");
  assert.equal((await service.revoke(VAULT, "Notes/r.md")).revoked, false, "second revoke → false");
  assert.equal(await service.resolve(record.id), null);

  await write("Notes/o.md", "# o\n");
  const orphan = await service.publish(VAULT, "Notes/o.md");
  await remove("Notes/o.md");
  assert.equal((await service.revoke(VAULT, "Notes/o.md")).revoked, true, "orphan revoke → true, no ENOENT");
  assert.equal(await persistedLifecycle(service.file, orphan.id), null, "the orphan record is physically removed");

  assert.equal((await service.revoke(VAULT, "Notes/never-published.md")).revoked, false, "unrecorded missing path → false, not 404");
});

test("§13.4 live edits keep the id and are never served from a cache", async () => {
  await write("Notes/live.md", "# live\n\nfirst\n");
  const service = newService();
  const record = await service.publish(VAULT, "Notes/live.md");
  await write("Notes/live.md", "# live\n\nsecond\n");
  assert.match((await service.resolve(record.id)).note.content, /second/, "the current body is re-read, not cached (§15 S08)");
  assert.equal((await service.publish(VAULT, "Notes/live.md")).id, record.id);
});

// ---------------------------------------------------------------- §13.5 concurrency (deterministic)

test("§13.5 deterministic concurrency: simultaneous publishes collapse; queued revoke/resolve keep one order", async () => {
  await write("Notes/c.md", "# c\n");
  const service = newService();
  const results = await Promise.all(Array.from({ length: 8 }, () => service.publish(VAULT, "Notes/c.md")));
  assert.equal(new Set(results.map((item) => item.id)).size, 1, "two simultaneous publishes share one id");
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(JSON.parse(await fs.readFile(service.file, "utf8")).records.length, 1);

  const first = results[0];
  await remove("Notes/c.md");
  // Both calls are enqueued in this tick, so the queue runs resolve before revoke: resolve
  // observes the missing target (retiring the record) and revoke then removes it.
  const [observed, revoked] = await Promise.all([service.resolve(first.id), service.revoke(VAULT, "Notes/c.md")]);
  assert.equal(observed, null);
  assert.equal(revoked.revoked, true);
  assert.equal(await service.resolve(first.id), null);

  await write("Notes/c.md", "# c2\n");
  assert.notEqual((await service.publish(VAULT, "Notes/c.md")).id, first.id, "recovery is republish → new id");

  const second = newService();
  await write("Notes/d.md", "# d\n");
  const original = await second.publish(VAULT, "Notes/d.md");
  const [published, revokedAgain] = await Promise.all([second.publish(VAULT, "Notes/d.md"), second.revoke(VAULT, "Notes/d.md")]);
  assert.equal(published.id, original.id, "the queued publish reuses the active id");
  assert.equal(revokedAgain.revoked, true);
  assert.equal(await second.resolve(original.id), null);
});

test("§13.5 a save failure surfaces instead of silently losing the mutation", async () => {
  const dir = path.join(dataRoot, "savable");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "state.json");
  const service = new PublishService({ file });
  await service.ready;

  await fs.rmdir(dir);
  await fs.writeFile(dir, "blocker");
  await write("Notes/save.md", "# save\n");
  const result = await attempt(() => service.publish(VAULT, "Notes/save.md"));
  assert.equal(result.ok, false, "the failed save must reject the mutation");
  assert.ok(["EEXIST", "ENOTDIR"].includes(result.code), `unexpected save error ${result.code}`);
  assert.equal(await fs.readFile(file, "utf8").then(() => true, () => false), false, "no half-written state file is left behind");
});

test("§9 a record whose Vault is unresolvable stays visible to Admin instead of breaking the listing", async () => {
  const file = path.join(dataRoot, "publish", "stale-vault.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    version: 2,
    records: [{ id: "E".repeat(43), vaultId: "not-a-vault", path: "Notes/ok.md", lifecycle: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", createdBy: "fixture" }],
  }));
  const service = new PublishService({ file });
  await service.ready;
  assert.equal((await service.list({ includeInactive: true })).length, 1, "Admin can still see and clean up the stale record");
  assert.equal((await service.list()).length, 1, "…and it remains an active candidate because its state could not be re-observed");
});

// ---------------------------------------------------------------- §16 wiring + §7 code agreement

test("§16 the service consumes the A1/A2 helpers and their frozen codes agree", async () => {
  assert.equal(lifecycle.PUBLISH_ERROR_CODES.UNSUPPORTED_PUBLISH_TARGET, target.UNSUPPORTED_PUBLISH_TARGET);
  assert.equal(lifecycle.PUBLISH_ERROR_CODES.PUBLISH_TARGET_MISSING, target.PUBLISH_TARGET_MISSING);

  const service = newService();
  const failure = await attempt(() => service.publish(VAULT, "Notes/diagram.canvas"));
  assert.equal(target.isPublishTargetError(failure.error), true, "the gate error is a domain PublishTargetError");

  const source = await fs.readFile(path.join(APP_ROOT, "src", "publish", "service.js"), "utf8");
  assert.match(source, /from "\.\/target\.js"/, "PublishService must import the target helper (§16)");
  assert.match(source, /from "\.\/lifecycle\.js"/, "PublishService must import the lifecycle model (§16)");
  assert.match(source, /assertPublishableTarget|normalizePublishTarget/);
  assert.match(source, /planPublish|planResolve|planRevoke/);
});

// ---------------------------------------------------------------- negative controls (env-gated)

const NEGATIVE = String(process.env.P278_B1_NEGATIVE || "").trim();
const negativeSkip = (key) => (NEGATIVE === "all" || NEGATIVE === key ? false : `env-gated: P278_B1_NEGATIVE=${key}|all`);

test("NEGATIVE CONTROL gate-non-markdown: old-red .canvas publish must not succeed", { skip: negativeSkip("gate-non-markdown") }, async () => {
  await write("Notes/diagram.canvas", "{}");
  const service = newService();
  const result = await attempt(() => service.publish(VAULT, "Notes/diagram.canvas"));
  assert.equal(result.ok, true, "OLD-RED no longer reproduces: BASE accepted a .canvas target");
});

test("NEGATIVE CONTROL revoke-orphan: old-red missing-target revoke must not throw ENOENT", { skip: negativeSkip("revoke-orphan") }, async () => {
  await write("Notes/neg.md", "# neg\n");
  const service = newService();
  await service.publish(VAULT, "Notes/neg.md");
  await remove("Notes/neg.md");
  const result = await attempt(() => service.revoke(VAULT, "Notes/neg.md"));
  assert.equal(result.ok, false, "OLD-RED no longer reproduces: BASE revoke() stat-ed the missing file");
});
