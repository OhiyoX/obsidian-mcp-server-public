import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relative) {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("editor public entry remains a thin public facade", () => {
  const entry = source("../frontend/app/features/editor/editor.js");
  assert.ok(entry.split(/\r?\n/).length <= 30);
  assert.match(entry, /export \{ createObsidianEditor \}/);
  assert.doesNotMatch(entry, /new EditorView/);
});

test("application entry delegates cross-cutting responsibilities", () => {
  const entry = source("../frontend/app/core/app.js");
  assert.match(entry, /createApiClient/);
  assert.match(entry, /initializeContextPane/);
  assert.match(entry, /bindDocumentNavigation/);
  assert.match(entry, /createVaultEventsController/);
  assert.doesNotMatch(entry, /async function api\(/);
  assert.doesNotMatch(entry, /function handleVaultEvent\(/);
});
