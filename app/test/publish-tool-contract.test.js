// C2 (Wave C) — MCP `manage_publish` / `get_publish_status` surface contract.
//
// Scope: the MCP adapter (`src/tools/publish.js`) mapping PublishService's authoritative
// domain errors onto the frozen §7 codes, plus the #277 revoke lifecycle result. The
// service half (B1) and the characterization probes (A4) live elsewhere; this file pins
// the *MCP* contract:
//
//   * #278 — a non-Markdown / directory / oversize / missing target is a stable
//     structured rejection (`isError` + `structuredContent.code`), never a raw exception;
//   * #277 — revoke is a successful structured result for a missing, orphaned or active
//     target (`revoked: true|false`), never ENOENT / never a 404;
//   * §15 S03 — no publish-tool payload (success or error) exposes a server absolute path.
//
// The handlers run in-process against the real singleton PublishService on a temp Vault,
// which keeps this deterministic; the real HTTP/JSON-RPC transport path is covered by
// `test/publish-surface-errors.test.js` (A4 harness) via the activated CONTRACT probes.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-tool-contract-"));
const vault = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vault, "Notes"), { recursive: true });
// A directory whose name carries the Markdown extension: the §12.2 "directory" reject row
// (an extensionless directory would resolve to `<dir>.md` and read as merely missing).
await fs.mkdir(path.join(vault, "Notes", "weird.md"), { recursive: true });
await fs.writeFile(path.join(vault, "Notes", "ok.md"), "# OK\n", "utf8");
await fs.writeFile(path.join(vault, "Notes", "Upper.MD"), "# Upper\n", "utf8");
await fs.writeFile(path.join(vault, "Notes", "diagram.canvas"), JSON.stringify({ nodes: [] }), "utf8");
await fs.writeFile(path.join(vault, "Notes", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), "utf8");
await fs.writeFile(path.join(vault, "Notes", "huge.md"), "x".repeat(4096), "utf8");
await fs.writeFile(path.join(vault, "Notes", "orphan.md"), "# Orphan\n", "utf8");
await fs.writeFile(path.join(vault, "Notes", "active.md"), "# Active\n", "utf8");
await fs.writeFile(path.join(vault, "Notes", "status.md"), "# Status\n", "utf8");

// Set before the dynamic import: config.js reads these at module load, and the §12.2
// oversize row must be reachable without writing a 10 MB fixture.
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.MAX_READ_BYTES = "2kb";
delete process.env.WEB_VAULTS_ROOT;

const [{ registerPublishTools }, { publishService }] = await Promise.all([
  import("../src/tools/publish.js"),
  import("../src/publish/service.js"),
]);

test.after(async () => fs.rm(root, { force: true, recursive: true }));

const AUTH = { authInfo: { clientId: "c2-test", allowedVaults: ["default"] } };
const tools = new Map();
registerPublishTools({ registerTool: (name, _descriptor, handler) => tools.set(name, handler) });
const call = (name, args, extra = AUTH) => tools.get(name)(args, extra);
const textOf = (result) => (result.content || []).map((item) => item.text ?? "").join("\n");

// §15 S03: every payload spelling is checked — `JSON.stringify` alone would miss Windows
// separators, and the JSON-escaped form too (same rule as the A4 harness).
function assertNoServerPath(result, label) {
  const texts = [JSON.stringify(result), ...(result.content || []).map((item) => item.text ?? "")];
  for (const spelling of [root, root.split(path.sep).join("/"), JSON.stringify(root).slice(1, -1)]) {
    for (const text of texts) {
      assert.ok(!text.includes(spelling), `${label} leaks the server absolute path ${spelling}: ${text}`);
    }
  }
}

function assertStructuredCode(result, code, label) {
  assert.equal(result.isError, true, `${label} must be a rejection: ${textOf(result)}`);
  assert.equal(result.structuredContent?.code, code, `${label} body: ${textOf(result)}`);
  assert.equal(result.structuredContent?.message?.includes(code), false, `${label} text must not be the code itself`);
  assertNoServerPath(result, label);
}

test("#278 / §12.1: publishing a Markdown note returns the anonymous route and stays idempotent", async () => {
  const published = await call("manage_publish", { action: "publish", path: "Notes/ok.md", vaultId: "default" });
  assert.equal(published.isError, undefined, textOf(published));
  assert.equal(published.structuredContent.published, true);
  assert.equal(published.structuredContent.path, "Notes/ok.md");
  assert.equal(published.structuredContent.changed, true);
  assert.equal(published.structuredContent.revoked, undefined, "publish must not report a revoke flag");
  assert.match(published.structuredContent.publicPath, /^\/publish\/[A-Za-z0-9_-]{43}$/);
  assertNoServerPath(published, "publish success payload");

  // Extensionless input canonicalizes to `.md` and resolves to the same opaque id, and an
  // upper-case `.MD` is Markdown too (§12.1 / §6 rule 5).
  const extensionless = await call("manage_publish", { action: "publish", path: "Notes/ok", vaultId: "default" });
  assert.equal(extensionless.structuredContent.path, "Notes/ok.md");
  assert.equal(extensionless.structuredContent.publicPath, published.structuredContent.publicPath);
  assert.equal(extensionless.structuredContent.changed, false, "republishing an active record is idempotent");
  const upper = await call("manage_publish", { action: "publish", path: "Notes/Upper.MD", vaultId: "default" });
  assert.equal(upper.structuredContent.published, true);
  assert.equal(upper.structuredContent.path, "Notes/Upper.MD");
});

test("#278 / §12.2: every rejected publish target carries the frozen code and no server path", async () => {
  const cases = [
    ["Notes/diagram.canvas", "unsupported_publish_target"],
    ["Notes/image.png", "unsupported_publish_target"],
    ["Notes/weird.md", "publish_target_not_a_file"],
    ["Notes/huge.md", "publish_target_too_large"],
    ["Notes/absent.md", "publish_target_missing"],
    ["../escape.md", "invalid_publish_target_path"],
    ["/Notes/ok.md", "invalid_publish_target_path"],
  ];
  for (const [target, code] of cases) {
    const result = await call("manage_publish", { action: "publish", path: target, vaultId: "default" });
    assertStructuredCode(result, code, `publish ${target}`);
    assert.ok(!/ENOENT|realpath|ENOTDIR/i.test(textOf(result)), `publish ${target} relayed a raw IO message: ${textOf(result)}`);
  }

  // Nothing was recorded, so the anonymous surface stayed closed for all of them.
  const recorded = new Set((await publishService.list({ includeInactive: true })).map((record) => record.path));
  for (const [target] of cases) {
    if (target.includes("..") || target.startsWith("/")) continue;
    assert.ok(!recorded.has(target), `${target} must not be recorded`);
  }
});

test("#277 / §13.3: revoke is a structured success for missing, orphaned and active targets", async () => {
  const neverPublished = await call("manage_publish", { action: "revoke", path: "Notes/never-published.md", vaultId: "default" });
  assert.equal(neverPublished.isError, undefined, `unrecorded revoke must not error: ${textOf(neverPublished)}`);
  assert.equal(neverPublished.structuredContent.revoked, false);
  assert.equal(neverPublished.structuredContent.published, false);
  assert.equal(neverPublished.structuredContent.changed, false);
  assert.equal(neverPublished.structuredContent.path, "Notes/never-published.md");
  assertNoServerPath(neverPublished, "unrecorded revoke payload");

  // Orphan: published, then the file disappears before the revoke.
  const published = await call("manage_publish", { action: "publish", path: "Notes/orphan.md", vaultId: "default" });
  assert.equal(published.structuredContent.published, true);
  await fs.rm(path.join(vault, "Notes", "orphan.md"));
  const orphan = await call("manage_publish", { action: "revoke", path: "Notes/orphan.md", vaultId: "default" });
  assert.equal(orphan.isError, undefined, `orphan revoke must succeed: ${textOf(orphan)}`);
  assert.equal(orphan.structuredContent.revoked, true);
  assert.equal(orphan.structuredContent.published, false);
  assert.equal(orphan.structuredContent.changed, true);
  assert.ok(!/ENOENT/i.test(textOf(orphan)), "an orphan revoke must never surface ENOENT");
  assertNoServerPath(orphan, "orphan revoke payload");

  const second = await call("manage_publish", { action: "revoke", path: "Notes/orphan.md", vaultId: "default" });
  assert.equal(second.isError, undefined);
  assert.equal(second.structuredContent.revoked, false, "a second revoke of the same path is a structured false");

  // Active: the file still exists; revoke clears the record without re-stat-ing afterwards.
  await call("manage_publish", { action: "publish", path: "Notes/active.md", vaultId: "default" });
  const active = await call("manage_publish", { action: "revoke", path: "Notes/active.md", vaultId: "default" });
  assert.equal(active.isError, undefined);
  assert.equal(active.structuredContent.revoked, true);
  assert.equal(active.structuredContent.published, false);
  assertNoServerPath(active, "active revoke payload");
});

test("#277: an unsupported revoke target is still a cleanup path, not a #278 publish gate", async () => {
  // Revoke exists to clear records, including historical non-Markdown ones (§9/§12.3), so
  // it must not apply the Markdown-only publish gate. A never-recorded `.canvas` target is
  // therefore a structured `revoked: false`, never `unsupported_publish_target`.
  const result = await call("manage_publish", { action: "revoke", path: "Notes/diagram.canvas", vaultId: "default" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(result.structuredContent.revoked, false);
  assert.equal(result.structuredContent.published, false);
  assertNoServerPath(result, "unsupported revoke payload");
});

test("status: a missing target is classified, never a raw ENOENT; a health status stays structured", async () => {
  const missing = await call("get_publish_status", { path: "Notes/absent-status.md", vaultId: "default" });
  assertStructuredCode(missing, "publish_target_missing", "status of a missing note");
  assert.ok(!/ENOENT|realpath/i.test(textOf(missing)), `status relayed a raw IO message: ${textOf(missing)}`);

  const before = await call("get_publish_status", { path: "Notes/status.md", vaultId: "default" });
  assert.equal(before.isError, undefined, textOf(before));
  assert.equal(before.structuredContent.published, false);
  await call("manage_publish", { action: "publish", path: "Notes/status.md", vaultId: "default" });
  const after = await call("get_publish_status", { path: "Notes/status.md", vaultId: "default" });
  assert.equal(after.structuredContent.published, true);
  assert.match(after.structuredContent.publicPath, /^\/publish\//);
});

test("§15 S06 / §43-4: the adapter reads the request-context Vault and keeps no second allowlist", async () => {
  // Wave C moved the Vault boundary out of this handler: the registrar injects/validates the
  // canonical `vaultId` input and enforces the credential allowlist at request level (the HTTP
  // gate answers 403 before the transport; `test/publish-surface-errors.test.js` pins that over
  // real JSON-RPC). So the adapter must *not* re-check `extra.authInfo.allowedVaults` and must
  // not read the raw argument either — otherwise it would shadow the context the registrar set.
  const { withRequestContextPatch } = await import("../src/request-context.js");

  // No request context in-process ⇒ the primary Vault, and an out-of-scope argument is inert.
  const ignoredArgument = await call("manage_publish", { action: "publish", path: "Notes/ok.md", vaultId: "other" });
  assert.equal(ignoredArgument.isError, undefined, textOf(ignoredArgument));
  assert.equal(ignoredArgument.structuredContent.vaultId, "default", "the raw argument must not select a Vault");

  // The context selection wins, and an authorized-but-unknown id fails closed as *prose*:
  // Vault resolution reuses the ENOENT code, so a §7 mapping that keys on ENOENT alone would
  // misclassify it as `publish_target_missing` — this pins the §15 S06 carve-out.
  const unknownVault = await withRequestContextPatch({ vaultId: "other" }, () =>
    call("manage_publish", { action: "publish", path: "Notes/ok.md", vaultId: "default" }));
  assert.equal(unknownVault.isError, true, textOf(unknownVault));
  assert.equal(unknownVault.structuredContent, undefined, "a Vault-scope refusal stays outside the §7 code namespace");
  assert.match(textOf(unknownVault), /^Error: Vault not found$/);
  assertNoServerPath(unknownVault, "unknown-vault payload");
});

test("#277: the declared output contract stays passthrough so the structured revoke result is wire-valid", async () => {
  // The Wave-1 inventory baseline freezes every historical outputContract digest and has
  // no audited output-widening allowance, so `revoked` cannot be declared in
  // `src/tool-contracts.js` without failing the root-tool-inventory / capability-catalog
  // drift gates. `outputSchemaForTool()` stays passthrough, which is what keeps the field
  // wire-valid (and is exercised end-to-end by test/publish-surface-errors.test.js over
  // real JSON-RPC). If `revoked` is ever declared, do it as one deliberate change together
  // with the inventory baseline assertions -- not by relaxing this pin silently.
  const { outputSchemaForTool } = await import("../src/tool-contracts.js");
  const schema = outputSchemaForTool("manage_publish");
  const parsed = schema.safeParse({
    vaultId: "default",
    path: "Notes/ok.md",
    privatePath: "/app/note/route",
    privateUrl: "/app/note/route",
    published: false,
    changed: false,
    publicPath: null,
    publicUrl: null,
    publishedAt: null,
    revoked: true,
  });
  assert.equal(parsed.success, true, "manage_publish must accept the structured revoke result");
  assert.equal(parsed.data.revoked, true);
  assert.equal(schema.shape?.revoked, undefined, "revoked is undeclared until an audited output widening exists");
});
