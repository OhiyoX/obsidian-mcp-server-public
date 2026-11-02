// C1 (Wave C) — the Web Publish surface matrix over real HTTP.
//
// Contract: `Web/DEVELOPMENT - Issues 277-278 Publish 生命周期与 Markdown-only 边界收口.md`
// §7 (error codes), §12.1 Accept / §12.2 Reject, §13.3 revoke idempotence, §15 S02/S03.
//
// This file pins the *Web adapter* half of #277/#278: the route must translate the
// authoritative `PublishService` outcome into the frozen HTTP status + machine-readable
// `code`, must never serve or echo a server path, and must not re-stat the target after a
// revoke mutation. The service contract itself is pinned by
// `publish-service-lifecycle.test.js` (B1) and the surface probes by
// `publish-surface-errors.test.js` (A4 + C1 activation).
//
// Real HTTP throughout: a temp Vault, an in-process express router, a real session login
// and a real CSRF token (see `helpers/publish-surface-harness.js`), plus the anonymous
// `/publish/:id` page.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODE_INVALID_TARGET_PATH,
  CODE_TARGET_MISSING,
  CODE_TARGET_NOT_A_FILE,
  CODE_TARGET_TOO_LARGE,
  CODE_UNSUPPORTED_TARGET,
  assertNoServerPath,
  cleanup,
  ensureFixture,
  errorCode,
} from "./helpers/publish-surface-harness.js";

test.after(cleanup);

const NOTES = (...segments) => path.join(...segments);

async function registrySnapshot(service) {
  return (await service.list({ includeInactive: true }))
    .map((record) => `${record.path}:${record.lifecycle ?? record.state ?? "?"}`)
    .sort();
}

test("§12.1 Accept: .md / .MD / extensionless publish is idempotent and the anonymous page serves", async () => {
  const { web, service, vault, root } = await ensureFixture();
  await fs.writeFile(NOTES(vault, "Notes", "accept.md"), "# Accept\n\naccept-body-marker\n", "utf8");
  await fs.writeFile(NOTES(vault, "Notes", "upper.MD"), "# Upper\n\nupper-body-marker\n", "utf8");

  const markdown = await web.post({ action: "publish", path: "Notes/accept.md" });
  assert.equal(markdown.status, 200, markdown.text);
  assert.equal(markdown.json.published, true);
  assert.equal(markdown.json.path, "Notes/accept.md");
  assert.match(markdown.json.publicPath, /^\/publish\/[A-Za-z0-9_-]{43}$/);
  assertNoServerPath(markdown.text, [vault, root], "publish success payload");

  // Idempotent re-publish of the same canonical target reuses the opaque id.
  const again = await web.post({ action: "publish", path: "Notes/accept.md" });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.publicPath, markdown.json.publicPath);

  // Extensionless input resolves through the canonical resolver to the same record.
  const extensionless = await web.post({ action: "publish", path: "Notes/accept" });
  assert.equal(extensionless.status, 200, extensionless.text);
  assert.equal(extensionless.json.path, "Notes/accept.md");
  assert.equal(extensionless.json.publicPath, markdown.json.publicPath);

  // Case-insensitive `.MD` is Markdown (§6 rule 5).
  const uppercase = await web.post({ action: "publish", path: "Notes/upper.MD" });
  assert.equal(uppercase.status, 200, uppercase.text);
  assert.equal(uppercase.json.path, "Notes/upper.MD");

  const page = await web.anonymous(markdown.json.publicPath.split("/").pop());
  assert.equal(page.status, 200, "an accepted Markdown record serves anonymously");
  assert.match(page.text, /accept-body-marker/);

  const listed = await service.list();
  assert.deepEqual(listed.map((record) => record.path).sort(), ["Notes/accept.md", "Notes/upper.MD"]);
});

test("§12.1 the write entry is authenticated: an anonymous POST is 401 and records nothing", async () => {
  const { web, service } = await ensureFixture();
  const before = await registrySnapshot(service);
  const response = await fetch(`${web.base}/api/web/v1/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "publish", path: "Notes/ok.md" }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Login required" });
  assert.deepEqual(await registrySnapshot(service), before, "an unauthenticated request must not mutate the registry");
});

test("§12.2 Reject: every non-Markdown extension is 400 + unsupported_publish_target and never recorded", async () => {
  const { web, service, vault, root } = await ensureFixture();
  await fs.writeFile(NOTES(vault, "Notes", "board.base"), "{}", "utf8");
  await fs.writeFile(NOTES(vault, "Notes", "data.json"), "{}", "utf8");
  const before = await registrySnapshot(service);

  // Existing files of each rejected kind (the fixture already has .canvas/.txt/.png).
  for (const target of ["Notes/diagram.canvas", "Notes/board.base", "Notes/data.json", "Notes/raw.txt", "Notes/image.png"]) {
    const response = await web.post({ action: "publish", path: target });
    assert.equal(response.status, 400, `${target}: ${response.status} ${response.text}`);
    assert.equal(errorCode(response.json), CODE_UNSUPPORTED_TARGET, `${target}: ${response.text}`);
    assertNoServerPath(response.text, [vault, root], `unsupported target rejection for ${target}`);
  }
  assert.deepEqual(await registrySnapshot(service), before, "rejected targets must not enter the registry");

  // A missing non-Markdown spelling reports the missing-target code, not unsupported.
  const missingNonMarkdown = await web.post({ action: "publish", path: "Notes/absent.canvas" });
  assert.equal(missingNonMarkdown.status, 404, missingNonMarkdown.text);
  assert.equal(errorCode(missingNonMarkdown.json), CODE_TARGET_MISSING);
});

test("§12.2 Reject: a missing target is 404 + publish_target_missing, including the extensionless form", async () => {
  const { web, service } = await ensureFixture();
  const before = await registrySnapshot(service);
  for (const target of ["Notes/absent.md", "Notes/absent"]) {
    const response = await web.post({ action: "publish", path: target });
    assert.equal(response.status, 404, `${target}: ${response.status} ${response.text}`);
    assert.equal(errorCode(response.json), CODE_TARGET_MISSING, `${target}: ${response.text}`);
  }
  assert.deepEqual(await registrySnapshot(service), before);
});

test("§12.2 Reject: a directory target is 400 + publish_target_not_a_file", async () => {
  const { web, service, vault, root } = await ensureFixture();
  await fs.mkdir(NOTES(vault, "Notes", "folder.md"), { recursive: true });
  const before = await registrySnapshot(service);

  const response = await web.post({ action: "publish", path: "Notes/folder.md" });
  assert.equal(response.status, 400, response.text);
  assert.equal(errorCode(response.json), CODE_TARGET_NOT_A_FILE, response.text);
  assertNoServerPath(response.text, [vault, root], "directory rejection");
  assert.deepEqual(await registrySnapshot(service), before);
});

test("§12.2 Reject: an oversize Markdown target is 400 + publish_target_too_large", async () => {
  const { web, service, vault, root } = await ensureFixture();
  const { MAX_READ_BYTES } = await import("../src/config.js");
  const huge = NOTES(vault, "Notes", "huge.md");
  await fs.writeFile(huge, "", "utf8");
  await fs.truncate(huge, MAX_READ_BYTES + 1);
  const before = await registrySnapshot(service);

  const response = await web.post({ action: "publish", path: "Notes/huge.md" });
  assert.equal(response.status, 400, response.text);
  assert.equal(errorCode(response.json), CODE_TARGET_TOO_LARGE, response.text);
  assertNoServerPath(response.text, [vault, root], "oversize rejection");
  assert.deepEqual(await registrySnapshot(service), before);
});

test("§12.2 / §15 S02: traversal, absolute, UNC and blank spellings are 400 + invalid_publish_target_path", async () => {
  const { web, service, vault, root } = await ensureFixture();
  const before = await registrySnapshot(service);

  for (const target of ["../escape.md", "/Notes/ok.md", "/etc/passwd.md", "\\\\server\\share\\x.md", "", "   ", ".."]) {
    const response = await web.post({ action: "publish", path: target });
    assert.equal(response.status, 400, `${JSON.stringify(target)}: ${response.status} ${response.text}`);
    assert.equal(errorCode(response.json), CODE_INVALID_TARGET_PATH, `${JSON.stringify(target)}: ${response.text}`);
    assertNoServerPath(response.text, [vault, root, "/etc", os.tmpdir()], `path rejection for ${JSON.stringify(target)}`);
  }
  assert.deepEqual(await registrySnapshot(service), before, "rejected spellings must not change the registry");
});

test("§7 / §13.3 revoke: a non-Markdown target is 400, an unknown Markdown path is a structured 200", async () => {
  const { web, service, vault, root } = await ensureFixture();
  const before = await registrySnapshot(service);

  // The service revoke stays permissive so Admin can clean historical non-Markdown records
  // (B1 §7); the Web surface refuses such an input itself (§7 "unsupported target → 400").
  const unsupported = await web.post({ action: "revoke", path: "Notes/diagram.canvas" });
  assert.equal(unsupported.status, 400, unsupported.text);
  assert.equal(errorCode(unsupported.json), CODE_UNSUPPORTED_TARGET, unsupported.text);
  assert.deepEqual(await registrySnapshot(service), before, "a refused revoke must not mutate the registry");

  const traversal = await web.post({ action: "revoke", path: "../escape.md" });
  assert.equal(traversal.status, 400, traversal.text);
  assert.equal(errorCode(traversal.json), CODE_INVALID_TARGET_PATH, traversal.text);

  // A missing and never-published Markdown path is an idempotent structured 200 (§13.3).
  const missing = await web.post({ action: "revoke", path: "Notes/never-published.md" });
  assert.equal(missing.status, 200, missing.text);
  assert.equal(missing.json.revoked, false);
  assert.equal(missing.json.published, false);
  assert.equal(missing.json.path, "Notes/never-published.md");
  assertNoServerPath(missing.text, [vault, root], "missing revoke payload");

  const orphan = await web.post({ action: "publish", path: "Notes/ok.md" });
  assert.equal(orphan.status, 200, orphan.text);
  const id = orphan.json.publicPath.split("/").pop();
  await fs.rm(NOTES(vault, "Notes", "ok.md"));

  const revoked = await web.post({ action: "revoke", path: "Notes/ok.md" });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.revoked, true);
  assert.equal(await (await fetch(`${web.base}/publish/${id}`)).status, 404);
  assert.ok(!(await service.list()).some((record) => record.id === id), "the orphan record must be cleared");

  const second = await web.post({ action: "revoke", path: "Notes/ok.md" });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.revoked, false);
});
