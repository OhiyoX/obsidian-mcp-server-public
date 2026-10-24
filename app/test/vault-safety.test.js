import assert from "node:assert/strict";
import test from "node:test";
import { assertNotVaultRoot, resolveVaultPath } from "../src/vault.js";

test("folder deletion guard rejects the vault root", () => {
  assert.throws(() => assertNotVaultRoot(resolveVaultPath("")), /vault root/);
  assert.throws(() => assertNotVaultRoot(resolveVaultPath("/")), /vault root/);
});

test("folder deletion guard accepts a nested vault path", () => {
  assert.doesNotThrow(() => assertNotVaultRoot(resolveVaultPath("nested")));
});


test("assumeMarkdown appends .md to dotted note basenames", () => {
  assert.equal(
    resolveVaultPath("Version 1.2", { assumeMarkdown: true }),
    resolveVaultPath("Version 1.2.md"),
  );
});

test("assumeMarkdown appends .md when a dotted note basename ends with title text", () => {
  assert.equal(
    resolveVaultPath("2026-09-25 v2026.09.25.11 发布与 NAS 部署", { assumeMarkdown: true }),
    resolveVaultPath("2026-09-25 v2026.09.25.11 发布与 NAS 部署.md"),
  );
});

test("assumeMarkdown prefers a Markdown note over an extension-like basename", () => {
  assert.equal(
    resolveVaultPath("Runbook.conf", { assumeMarkdown: true }),
    resolveVaultPath("Runbook.conf.md"),
  );
});

test("assumeMarkdown does not duplicate an explicit Markdown extension", () => {
  assert.equal(
    resolveVaultPath("Version 1.2.md", { assumeMarkdown: true }),
    resolveVaultPath("Version 1.2.md"),
  );
});
