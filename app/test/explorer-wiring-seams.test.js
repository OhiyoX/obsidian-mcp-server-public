// The shell wiring builds the explorer controller itself, so a seam it does not name is silently
// dropped: `pathMoved` reached `core/app.js` but never the controller, and a rename left the
// document session on the old path (409 on the next save). This checks the two places that must
// name it. It cannot prove the behaviour; `explorer-rename-draft.test.js` does that.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIRING = readFileSync(path.join(APP_ROOT, "frontend/app/core/explorer-wiring.js"), "utf8");
const CONTROLLER = readFileSync(path.join(APP_ROOT, "frontend/app/features/explorer/controller.js"), "utf8");

test("the explorer wiring accepts and forwards pathMoved", () => {
  assert.match(WIRING, /^\s+pathMoved,$/m, "the parameter must be destructured");
  assert.match(WIRING, /pathMoved: \(from, to\) => pathMoved\?\.\(from, to\)/, "and forwarded to the controller");
  // The rename reload passes `{ reason: "moved" }`; a one-argument wrapper drops it silently.
  assert.match(WIRING, /openNote: \(path, options\) => openNote\(path, options\)/, "openNote must pass its options");
});

test("the controller takes pathMoved and calls it", () => {
  assert.match(CONTROLLER, /pathMoved = null \}/, "the seam must be in the controller options");
  assert.match(CONTROLLER, /pathMoved\?\.\(target\\.path, destination\)/.source
    ? /pathMoved\?\.\(target\.path, destination\)/ : /pathMoved/, "and called with the entry pair");
});

// `to` is the entry that moved. The editor and the header need the note's own path, which only
// the session knows after the rebase: with a folder rename they would show the folder.
test("moveOpenDocument renders the session path, not the entry path", async () => {
  const app = readFileSync(path.join(APP_ROOT, "frontend/app/core/app.js"), "utf8");
  const body = app.slice(app.indexOf("function moveOpenDocument"), app.indexOf("async function openNote"));
  assert.match(body, /session\.rebasePath\(from, to\)/);
  assert.match(body, /const path = session\.path/, "the path comes from the session");
  assert.match(body, /setSourcePath\?\.\(path,/, "the editor follows the note");
  assert.match(body, /pathBreadcrumb\.render\(path\)/, "the header follows the note");
  assert.doesNotMatch(body, /setSourcePath\?\.\(to/, "never the entry path");
});
