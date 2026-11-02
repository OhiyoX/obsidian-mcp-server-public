// A4 (Wave A) — Publish surface error contract: Web route + MCP `manage_publish`.
//
// Scope of this file is the *surface* contract of contract §7 ("错误契约"), not the
// PublishService core (that is A3/B1) and not the Web/MCP adapters (C1/C2). It contains
// three kinds of tests, in this order:
//
//   1. CHARACTERIZATION (always runs): the surface as it behaves TODAY. B1 (service wiring)
//      landed the #277/#278 service half, so the pins below are re-pinned to the post-B1
//      behaviour: non-Markdown/missing/absolute publish targets are rejected by the
//      authoritative gate and an orphan revoke clears the record. C1/C2 still own the HTTP /
//      JSON-RPC mapping (status + domain code), which the CONTRACT probes pin; each re-pinned
//      case carries an `OLD-RED PIN` comment with the old value and the contract value it is
//      expected to become once C1/C2 land.
//   2. CONTRACT (all probes active): the machine-readable #277/#278 surface contract. B1
//      satisfied four probes (anonymous/Admin/service half); C1 activated the three Web
//      probes (frozen codes + a structured 200 for an orphaned revoke) and C2 activated
//      the three MCP probes. Every probe runs unconditionally and must stay green without
//      further edits.
//   3. NEGATIVE CONTROL (env-gated): `P278_A4_FORCE_PENDING=<key>` (or `all`) runs the
//      PENDING probes at the current BASE so a reviewer can see them fail for real instead
//      of trusting a vacuous assertion. Evidence for those runs lives in
//      `scratch/publish-277-278/A4/evidence/`. Nothing runs the probes without the env var.
//
// Evidence sources used to write the literal pins: `app/src/publish/service.js`,
// `app/src/app/routes.js` (POST/GET `/api/web/v1/publish`, anonymous `/publish/:id`),
// `app/src/app/web-api-error.js`, `app/src/tools/publish.js` + `src/result.js`,
// `app/src/app/vault-registry.js` (`resolveWebVaultPath`/`resolveWebNoteFile`).
// Fixtures and the real-HTTP/real-MCP harness live in
// `app/test/helpers/publish-surface-harness.js`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODE_INVALID_TARGET_PATH,
  CODE_TARGET_MISSING,
  CODE_UNSUPPORTED_TARGET,
  assertNoServerPath,
  cleanup,
  ensureFixture,
  errorCode,
  historicalFixture,
  listForAdmin,
  mcpServer,
  pending,
  recordState,
  resultText,
} from "./helpers/publish-surface-harness.js";

test.after(cleanup);

// =========================================================================================
// 1. CHARACTERIZATION — Web surface as it behaves TODAY at the frozen BASE
// =========================================================================================

test("CHARACTERIZATION Web: non-Markdown targets are a 400 with the frozen code (#278)", async () => {
  // OLD-RED PIN: on BASE `.canvas`/`.png`/`.txt` were recorded and rendered as Markdown
  // (`200 + published:true`); post-B1 the gate rejected them but the surface still had no
  // code. C1 flipped the pin to `400 + unsupported_publish_target`.
  const { web, service, vault, root } = await ensureFixture();
  for (const target of ["Notes/diagram.canvas", "Notes/image.png", "Notes/raw.txt", "Notes/diagram.CANVAS"]) {
    const response = await web.post({ action: "publish", path: target });
    assert.equal(response.status, 400, `${target} must be rejected: ${response.text}`);
    assert.equal(errorCode(response.json), CODE_UNSUPPORTED_TARGET, `${target} body: ${response.text}`);
    assert.ok(
      !(await service.list({ includeInactive: true })).some((record) => record.path.toLowerCase() === target.toLowerCase()),
      `${target} must not be recorded`,
    );
    assertNoServerPath(response.text, [vault, root], `Web unsupported-target rejection for ${target}`);
  }

  // Markdown (including the extensionless canonical form) keeps working, and the private
  // Vault path never appears in a success payload.
  const markdown = await web.post({ action: "publish", path: "Notes/ok.md" });
  assert.equal(markdown.status, 200);
  const extensionless = await web.post({ action: "publish", path: "Notes/ok" });
  assert.equal(extensionless.status, 200);
  assert.equal(extensionless.json.path, "Notes/ok.md");
  assert.equal(extensionless.json.publicPath, markdown.json.publicPath, "extensionless publish stays idempotent");
  assertNoServerPath(markdown.text, [vault], "Web publish success payload");
});

test("CHARACTERIZATION Web: a missing publish target is a 404 with the frozen code", async () => {
  // OLD-RED PIN: on BASE a missing target was a flat `404 {"error":"Not found"}`; post-B1 the
  // service answered `publish_target_missing` but the surface had no code. C1 flipped the pin
  // to `404 + publish_target_missing`. B1 answers the domain code; C1 maps it.
  const { web, service } = await ensureFixture();
  for (const target of ["Notes/missing.md", "Notes/missing", "Notes"]) {
    const response = await web.post({ action: "publish", path: target });
    assert.equal(response.status, 404, `${target}: ${response.status} ${response.text}`);
    assert.equal(errorCode(response.json), CODE_TARGET_MISSING, `${target}: body ${response.text}`);
    assert.ok(!(await service.list({ includeInactive: true })).some((record) => record.path === target), `${target} must not be recorded`);
  }
});

test("CHARACTERIZATION Web: traversal and empty paths are a 400 with invalid_publish_target_path", async () => {
  // OLD-RED PIN: on BASE all three were a flat `400 {"error":"Invalid path"}` with no code.
  // A1 rejects them in the input layer; C1 flipped the pin to `400 + invalid_publish_target_path`.
  const { web, vault, root } = await ensureFixture();
  for (const target of ["../escape.md", "", ".."]) {
    const response = await web.post({ action: "publish", path: target });
    assert.equal(response.status, 400, `${JSON.stringify(target)}: ${response.status} ${response.text}`);
    assert.equal(errorCode(response.json), CODE_INVALID_TARGET_PATH, `${JSON.stringify(target)}: body ${response.text}`);
    assertNoServerPath(response.text, [vault, root], `Web path rejection for ${JSON.stringify(target)}`);
  }
});

test("CHARACTERIZATION Web: a leading-slash path is a 400 with invalid_publish_target_path instead of being re-rooted", async () => {
  // OLD-RED PIN (§12.2 "absolute path" reject row): on BASE `normalizeVaultInput()` stripped
  // the leading slash, so `/Notes/ok.md` silently published `Notes/ok.md` and `/etc/passwd.md`
  // degraded to a plain 404. A1's input layer refuses absolute/UNC targets with
  // `invalid_publish_target_path`; C1 maps the code to a 400. B1 flipped the rejection,
  // C1 flipped the code.
  const { web, service, vault, root } = await ensureFixture();
  const before = (await service.list({ includeInactive: true })).length;
  for (const target of ["/Notes/ok.md", "/etc/passwd.md"]) {
    const response = await web.post({ action: "publish", path: target });
    assert.equal(response.status, 400, `${target}: ${response.status} ${response.text}`);
    assert.equal(errorCode(response.json), CODE_INVALID_TARGET_PATH, `${target}: body ${response.text}`);
    assertNoServerPath(response.text, [vault, root, "/etc"], `Web absolute-path rejection for ${target}`);
  }
  assert.equal((await service.list({ includeInactive: true })).length, before, "absolute spellings must not change the registry");
});

test("CHARACTERIZATION Web: revoking an orphaned target is a structured 200 and clears the record (#277)", async () => {
  // OLD-RED PIN: on BASE `revoke()` called `status()` first, so an observed orphan raised
  // ENOENT → `404 {"error":"Not found"}` and the record survived forever. B1 made the
  // service revoke path-independent; post-B1 the Web route still answered 404 because it
  // re-statted after the mutation. C1 flipped the pin to `200 + {revoked:true}`.
  const { web, service, vault, root } = await ensureFixture();
  const published = await web.post({ action: "publish", path: "Notes/gone.md" });
  assert.equal(published.status, 200);
  const id = published.json.publicPath.split("/").pop();

  await fs.rm(path.join(vault, "Notes", "gone.md"));
  assert.equal((await web.anonymous(id)).status, 404, "the old id already 404s while the file is missing");

  const revoked = await web.post({ action: "revoke", path: "Notes/gone.md" });
  assert.equal(revoked.status, 200, `an orphaned revoke must not surface ENOENT: ${revoked.text}`);
  assert.equal(revoked.json.revoked, true, `revoked must be reported structurally: ${revoked.text}`);
  assert.equal(revoked.json.published, false);
  assert.ok(!(await service.list({ includeInactive: true })).some((record) => record.id === id), "the orphan record must now be cleared");

  const listed = await service.list({ includeInactive: true });
  assert.ok(listed.every((record) => !path.isAbsolute(record.path)), "list() paths stay Vault-relative (§15 S03)");
  assertNoServerPath(JSON.stringify(listed), [vault, root], "Web list payload");
});

test("CHARACTERIZATION Web: a hand-written v1 state is classified and fails closed (§12.3 / §15 S07)", async () => {
  // OLD-RED PIN: on BASE the v1 file loaded all three records unclassified and a non-Markdown
  // record rendered anonymously (`200`). B1 migrates v1 → v2, classifies on first observation
  // (non-Markdown → invalid, missing → orphaned, healthy → active) and fails closed.
  const fixture = await historicalFixture("characterization");
  assert.deepEqual(
    (await fixture.service.list({ includeInactive: true })).map((record) => record.path).sort(),
    ["Notes/diagram.canvas", "Notes/ghost.md", "Notes/ok.md"],
    "the service starts and lists every v1 record for Admin",
  );
  assert.deepEqual(
    (await fixture.service.list()).map((record) => record.path),
    ["Notes/ok.md"],
    "the default (published candidate) view keeps only active records",
  );

  const nonMarkdown = await fixture.session.anonymous(fixture.ids.nonMarkdown);
  assert.equal(nonMarkdown.status, 404, "a non-Markdown record must fail closed anonymously (§15 S07)");
  assert.equal(errorCode(nonMarkdown.text), null);

  const orphan = await fixture.session.anonymous(fixture.ids.orphan);
  assert.equal(orphan.status, 404, "a historical record whose file is missing fails closed");
  const healthy = await fixture.session.anonymous(fixture.ids.healthy);
  assert.equal(healthy.status, 200, "a healthy historical record still serves");

  const listed = await fixture.service.list({ includeInactive: true });
  const nonMarkdownRecord = listed.find((record) => record.id === fixture.ids.nonMarkdown);
  assert.ok(nonMarkdownRecord, "Admin still sees the non-Markdown record so it can be cleaned up (§9)");
  assert.equal(recordState(nonMarkdownRecord), "invalid", "…classified invalid, not silently active");

  // Revoke can clear the historical record by canonical path — even though the target is not
  // Markdown (revoke is a cleanup path, not a publish target).
  assert.deepEqual(await fixture.service.revokeById(fixture.ids.nonMarkdown), nonMarkdownRecord);
  assert.equal((await fixture.session.anonymous(fixture.ids.nonMarkdown)).status, 404);
  assert.ok(!(await fixture.service.list({ includeInactive: true })).some((record) => record.id === fixture.ids.nonMarkdown));
});

// =========================================================================================
// 2. CHARACTERIZATION — MCP surface as it behaves TODAY at the frozen BASE
// =========================================================================================

test("CHARACTERIZATION MCP: a non-Markdown target is rejected with a structured frozen code (#278)", async () => {
  // OLD-RED PIN: on BASE `manage_publish` accepted `.canvas`/`.png` and returned
  // `published:true` with no code. B1 rejected them in the service but the envelope stayed
  // prose-only; C2 flipped the envelope to `isError` + `structuredContent.code`
  // (`unsupported_publish_target`), pinned by the CONTRACT probe below.
  const { callTool, root } = await mcpServer();
  for (const target of ["Notes/diagram.canvas", "Notes/image.png"]) {
    const result = await callTool("manage_publish", { action: "publish", path: target });
    assert.equal(result.isError, true, `${target} must be rejected by the service gate: ${resultText(result)}`);
    assert.equal(result.structuredContent?.code, CODE_UNSUPPORTED_TARGET, `${target}: ${resultText(result)}`);
    assert.match(resultText(result), /Publish target must be a Markdown/);
    assertNoServerPath(result, [root], `MCP unsupported-target rejection for ${target}`);
  }
});

test("CHARACTERIZATION MCP: missing targets are classified and revoke answers structured revoked flags (#277)", async () => {
  // OLD-RED PIN: on BASE this path leaked `ENOENT … realpath '<server abs path>'`, and the
  // revoke half called `status()` after the mutation, so an orphan revoke raised ENOENT.
  // B1 made the service revoke path-independent; C2 classifies the missing-target error
  // (`publish_target_missing`) and returns the structured `revoked` flag without re-stat-ing.
  const { callTool, vault: mcpVault } = await mcpServer();

  const missing = await callTool("manage_publish", { action: "publish", path: "Notes/missing.md" });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent?.code, CODE_TARGET_MISSING, "C2 classifies the missing publish target");
  assert.match(resultText(missing), /^(?:Error: )?Publish target not found/);
  assertNoServerPath(missing, [mcpVault, os.tmpdir()], "MCP missing-target publish");

  const neverPublished = await callTool("manage_publish", { action: "revoke", path: "Notes/missing.md" });
  assert.equal(neverPublished.isError, undefined, "revoking an unrecorded path is a structured success");
  assert.equal(neverPublished.structuredContent.revoked, false);

  const orphanPublish = await callTool("manage_publish", { action: "publish", path: "Notes/orphan.md" });
  assert.equal(orphanPublish.structuredContent.published, true);
  await fs.rm(path.join(mcpVault, "Notes", "orphan.md"));
  const orphanRevoke = await callTool("manage_publish", { action: "revoke", path: "Notes/orphan.md" });
  assert.equal(orphanRevoke.isError, undefined, "an orphan revoke is a structured success");
  assert.equal(orphanRevoke.structuredContent.revoked, true);

  const statusAfter = await callTool("get_publish_status", { action: "status", path: "Notes/orphan.md" });
  assert.equal(statusAfter.isError, true, "C2 classifies the missing status target instead of passing ENOENT through");
  assert.equal(statusAfter.structuredContent?.code, CODE_TARGET_MISSING, "the status half carries the same frozen code");
  assertNoServerPath(statusAfter, [mcpVault, os.tmpdir()], "MCP missing-target status");
});

test("CHARACTERIZATION MCP: domain rejections carry a code; the Vault-scope denial stays outside the §7 code namespace", async () => {
  const { callTool, callToolRaw } = await mcpServer();

  const traversal = await callTool("manage_publish", { action: "publish", path: "../escape.md" });
  assert.equal(traversal.isError, true);
  assert.match(resultText(traversal), /^Error: Invalid Vault path/);
  assert.equal(traversal.structuredContent?.code, CODE_INVALID_TARGET_PATH, "C2 classifies the domain path refusal");

  // Wave C moved the Vault boundary out of the handler (contract §7.3/§9/§43-4): an unauthorized
  // `vaultId` is now refused by the HTTP credential gate before the MCP transport, so there is no
  // tool result and no prose classification at all for this rejection.
  const denied = await callToolRaw("manage_publish", { action: "publish", path: "Notes/ok.md", vaultId: "other" });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.payload, { error: "access_denied", error_description: "Vault access denied" });

  // §15 S06 is an authorization boundary, not a §7 publish-domain code: the refusal body is an
  // OAuth-shaped `{error, error_description}` pair with no `code` field at all (exact-body equality
  // above already pins that), so a §7 consumer can never mistake it for a publish target failure.
  assert.equal(Object.hasOwn(denied.payload, "code"), false, "vault-denied exposes no code field");
});

// =========================================================================================
// 3. CONTRACT — §7 surface contract (skipped until B1/C1/C2 land)
// =========================================================================================

test("CONTRACT Web: publishing a non-Markdown target is a 400 with the frozen target code (#278)",
  async () => {
    const { web, service, vault, root } = await ensureFixture();
    // Fixture self-check (cross-platform): the `.CANVAS` variant asserted below must exist as a
    // real file, because the surface stats the target before the extension gate. `fs.stat` is
    // case-sensitive on Linux (a missing variant would throw here instead of silently resolving)
    // and case-insensitive on Windows, so this pins the *fixture* rather than the host's path
    // resolution. Without it the 400 would be a Windows-only artefact.
    await fs.stat(path.join(vault, "Notes", "diagram.CANVAS"));
    for (const target of ["Notes/diagram.canvas", "Notes/image.png", "Notes/raw.txt", "Notes/diagram.CANVAS"]) {
      const response = await web.post({ action: "publish", path: target });
      assert.equal(response.status, 400, `${target} must be rejected: ${response.text}`);
      assert.equal(errorCode(response.json), CODE_UNSUPPORTED_TARGET, `${target} body: ${response.text}`);
      assertNoServerPath(response.text, [vault, root], `Web unsupported-target rejection for ${target}`);
    }
    // Nothing was recorded and the anonymous surface stayed closed.
    const listed = await service.list();
    for (const target of ["Notes/diagram.canvas", "Notes/image.png", "Notes/raw.txt"]) {
      assert.ok(!listed.some((record) => record.path === target), `${target} must not be recorded`);
    }
  });

test("CONTRACT Web: an unsupported revoke target is 400 and a missing one is 404 with a code",
  async () => {
    const { web } = await ensureFixture();
    const missing = await web.post({ action: "publish", path: "Notes/absent.md" });
    assert.equal(missing.status, 404, `missing target: ${missing.text}`);
    assert.equal(errorCode(missing.json), CODE_TARGET_MISSING, `missing target body: ${missing.text}`);

    const unsupportedRevoke = await web.post({ action: "revoke", path: "Notes/diagram.canvas" });
    assert.equal(unsupportedRevoke.status, 400, `unsupported revoke target: ${unsupportedRevoke.text}`);
    assert.equal(errorCode(unsupportedRevoke.json), CODE_UNSUPPORTED_TARGET);
  });

test("CONTRACT Web: revoking an orphaned target answers 200 with a structured result, never ENOENT/404 (#277)",
  async () => {
    const { web, service, vault, root } = await ensureFixture();
    const published = await web.post({ action: "publish", path: "Notes/orphan.md" });
    assert.equal(published.status, 200, `fixture publish failed: ${published.text}`);
    const id = published.json.publicPath.split("/").pop();
    await fs.rm(path.join(vault, "Notes", "orphan.md"));

    const revoked = await web.post({ action: "revoke", path: "Notes/orphan.md" });
    assert.equal(revoked.status, 200, `orphan revoke must not surface ENOENT: ${revoked.text}`);
    assert.equal(revoked.json.revoked, true, `revoked must be reported structurally: ${revoked.text}`);
    assert.equal(revoked.json.published, false);
    assertNoServerPath(revoked.text, [vault, root], "Web orphan revoke payload");
    assert.equal((await web.anonymous(id)).status, 404);
    assert.ok(!(await service.list()).some((record) => record.id === id), "the orphan record must be cleared");

    // Idempotence: the second revoke is a structured false, still not a 404.
    const second = await web.post({ action: "revoke", path: "Notes/orphan.md" });
    assert.equal(second.status, 200, `second orphan revoke: ${second.text}`);
    assert.equal(second.json.revoked, false);
  });

test("CONTRACT Web: an orphaned id stays 404 after the path is recreated and republishing mints a new id (#277, B1)",
  async () => {
    const { web, vault } = await ensureFixture();
    await fs.writeFile(path.join(vault, "Notes", "revive.md"), "# v1\n", "utf8");
    const published = await web.post({ action: "publish", path: "Notes/revive.md" });
    assert.equal(published.status, 200, `fixture publish failed: ${published.text}`);
    const oldId = published.json.publicPath.split("/").pop();

    await fs.rm(path.join(vault, "Notes", "revive.md"));
    assert.equal((await web.anonymous(oldId)).status, 404, "observed missing → the id must 404");

    await fs.writeFile(path.join(vault, "Notes", "revive.md"), "# v2\n", "utf8");
    assert.equal((await web.anonymous(oldId)).status, 404, "a recreated path may never revive the old id");

    const republished = await web.post({ action: "publish", path: "Notes/revive.md" });
    assert.equal(republished.status, 200, `republish failed: ${republished.text}`);
    const newId = republished.json.publicPath.split("/").pop();
    assert.notEqual(newId, oldId, "explicit republish must mint a new opaque id");
    assert.equal((await web.anonymous(newId)).status, 200);
    await fs.rm(path.join(vault, "Notes", "revive.md"));
  });

test("CONTRACT Web: anonymous resolve of a non-Markdown record fails closed 404 (§12.3 / §15 S07, B1)",
  async () => {
    const fixture = await historicalFixture("anon-contract");
    const { vault, root } = await ensureFixture();
    const response = await fixture.session.anonymous(fixture.ids.nonMarkdown);
    assert.equal(response.status, 404, "a non-Markdown record may never render anonymously");
    assertNoServerPath(response.text, [vault, root], "anonymous non-Markdown rejection");
    assert.equal((await fixture.session.anonymous(fixture.ids.healthy)).status, 200, "healthy records keep serving");
  });

test("CONTRACT Web: §12.3 historical fixture — service starts, Admin sees a non-active classification, revoke clears (B1)",
  async () => {
    const fixture = await historicalFixture("list-contract");
    const admin = await listForAdmin(fixture.service);
    const nonMarkdown = admin.find((record) => record.id === fixture.ids.nonMarkdown);
    const orphan = admin.find((record) => record.id === fixture.ids.orphan);
    assert.ok(nonMarkdown, "Admin must still see the non-Markdown record so it can be cleaned up (§9)");
    assert.ok(orphan, "Admin must still see the orphan record so it can be cleaned up (§9)");
    assert.equal(recordState(nonMarkdown), "invalid", "the non-Markdown record must be classified invalid");
    assert.equal(recordState(orphan), "orphaned", "the missing-target record must be classified orphaned");
    assert.equal(recordState(admin.find((record) => record.id === fixture.ids.healthy)), "active");

    // The active-only candidate list (whatever C3 names it) must exclude both.
    if (typeof fixture.service.listActive === "function") {
      const active = await fixture.service.listActive();
      assert.deepEqual(active.map((record) => record.id), [fixture.ids.healthy], "published: candidates are active only (§9)");
    }

    const revoked = await fixture.service.revoke("default", "Notes/diagram.canvas");
    assert.equal(revoked.revoked, true, "a non-Markdown historical record must be revocable by canonical path");
    assert.ok(!(await listForAdmin(fixture.service)).some((record) => record.id === fixture.ids.nonMarkdown));
    assert.equal((await fixture.session.anonymous(fixture.ids.nonMarkdown)).status, 404);

    // Reloading the file must not resurrect it and must not fail the service.
    const { PublishService } = await ensureFixture();
    const reloaded = new PublishService({ file: fixture.file });
    await reloaded.ready;
    assert.ok(!(await listForAdmin(reloaded)).some((record) => record.id === fixture.ids.nonMarkdown));
  });

test("CONTRACT Web: publish-surface errors never contain the server absolute path (§15 S03, B1)",
  async () => {
    const { web, vault, root } = await ensureFixture();
    const [missingPublish, traversal, unsupported, missingRevoke] = [
      await web.post({ action: "publish", path: "Notes/absent.md" }),
      await web.post({ action: "publish", path: "../escape.md" }),
      await web.post({ action: "publish", path: "Notes/diagram.canvas" }),
      await web.post({ action: "revoke", path: "Notes/absent.md" }),
    ];
    assert.ok(
      [missingPublish, traversal, unsupported].every((response) => response.status >= 400),
      "each publish probe must be a rejection",
    );
    // §13.3 / §7: revoking a never-published (and missing) path is a structured 200, not an
    // error. C1 removed the post-mutation re-stat, so the no-leak check must cover that shape
    // as well instead of pinning the pre-C1 `>= 400` behaviour.
    assert.equal(missingRevoke.status, 200, `missing revoke: ${missingRevoke.text}`);
    assert.equal(missingRevoke.json.revoked, false);
    for (const response of [missingPublish, traversal, unsupported, missingRevoke]) {
      assertNoServerPath(response.text, [vault, root, os.tmpdir()], `Web error body (${response.status})`);
    }
  });

test("CONTRACT MCP: publishing a non-Markdown target returns a stable structured error with a code (#278)",
  async () => {
    const { callTool, root } = await mcpServer();
    for (const target of ["Notes/diagram.canvas", "Notes/image.png"]) {
      const result = await callTool("manage_publish", { action: "publish", path: target });
      assert.equal(result.isError, true, `${target} must be rejected: ${resultText(result)}`);
      const code = result.structuredContent?.code ?? result.structuredContent?.error?.code ?? errorCode(result);
      assert.equal(code, CODE_UNSUPPORTED_TARGET, `${target} must carry the frozen code: ${resultText(result)}`);
      assertNoServerPath(result, [root, os.tmpdir()], `MCP unsupported-target rejection for ${target}`);
    }
  });

test("CONTRACT MCP: revoking a missing or orphaned path succeeds with revoked true/false (#277)",
  async () => {
    const { callTool, vault: mcpVault } = await mcpServer();

    const neverPublished = await callTool("manage_publish", { action: "revoke", path: "Notes/never-published.md" });
    assert.equal(neverPublished.isError, undefined, `unrecorded revoke must not error: ${resultText(neverPublished)}`);
    assert.equal(neverPublished.structuredContent.revoked, false);
    assert.equal(neverPublished.structuredContent.published, false);

    await fs.writeFile(path.join(mcpVault, "Notes", "contract-orphan.md"), "# Orphan\n", "utf8");
    const published = await callTool("manage_publish", { action: "publish", path: "Notes/contract-orphan.md" });
    assert.equal(published.structuredContent.published, true, `fixture publish failed: ${resultText(published)}`);
    await fs.rm(path.join(mcpVault, "Notes", "contract-orphan.md"));

    const orphanRevoke = await callTool("manage_publish", { action: "revoke", path: "Notes/contract-orphan.md" });
    assert.equal(orphanRevoke.isError, undefined, `orphan revoke must succeed: ${resultText(orphanRevoke)}`);
    assert.equal(orphanRevoke.structuredContent.revoked, true);

    const second = await callTool("manage_publish", { action: "revoke", path: "Notes/contract-orphan.md" });
    assert.equal(second.isError, undefined);
    assert.equal(second.structuredContent.revoked, false);
  });

test("CONTRACT MCP: no publish-tool error payload exposes an absolute server path (§15 S03)",
  async () => {
    const { callTool, root } = await mcpServer();
    const rejections = [
      await callTool("manage_publish", { action: "publish", path: "Notes/absent.md" }),
      await callTool("get_publish_status", { path: "Notes/absent.md" }),
      await callTool("manage_publish", { action: "publish", path: "../escape.md" }),
    ];
    for (const result of rejections) {
      assert.equal(result.isError, true, `probe must be a rejection: ${resultText(result)}`);
      assertNoServerPath(result, [root, os.tmpdir()], "MCP error payload");
    }

    // #277 pinned `revoke` of a missing path as a *success* (`revoked:false`), so the
    // pre-C2 `isError` expectation for this fourth probe contradicted the probe above;
    // the coverage is the same or stronger — the structured success payload must also
    // stay free of the server absolute path.
    const revoke = await callTool("manage_publish", { action: "revoke", path: "Notes/absent.md" });
    assert.equal(revoke.isError, undefined, `a missing revoke is a structured success: ${resultText(revoke)}`);
    assert.equal(revoke.structuredContent.revoked, false, "and it reports revoked:false");
    assertNoServerPath(revoke, [root, os.tmpdir()], "MCP missing-revoke payload");
  });
