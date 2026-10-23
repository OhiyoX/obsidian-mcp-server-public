// B4 source contract: the Base document surface must be wired without coupling
// app.js to Markdown internals or the Base module to the note save stack.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const app = read("../frontend/app/core/app.js");
const wiring = read("../frontend/app/features/navigation/base-navigation.js");
const kind = read("../frontend/app/features/bases/document-kind.js");
const bind = read("../frontend/app/features/navigation/bind-navigation.js");
const shortcuts = read("../frontend/app/features/navigation/keyboard-shortcuts.js");

// Comments may legitimately name the APIs we forbid; scan code only.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("app.js stays within the architecture line budget", () => {
  assert.ok(app.split(/\r?\n/).length <= 500, "app.js must stay within the local 500-line cap");
});

test("app.js wires documentKind navigation through the dedicated modules", () => {
  assert.match(app, /import \{ createBaseNavigation \} from "\.\.\/features\/navigation\/base-navigation\.js"/);
  assert.match(app, /createBaseNavigation\(\{/);
  assert.match(app, /getDocumentKind: \(\) => state\.documentKind/);
  assert.match(app, /openBase: \(options\) => baseNavigation\.openBase\(options\)/);
  assert.match(app, /onOpenBase: \(\{ path \} = \{\}\) => baseNavigation\.openBase\(\{ path \}\)/);
  assert.doesNotMatch(app, /features\/bases|createBaseSurface/, "Base internals stay behind base-navigation.js");
});

test("Ctrl+S is a proven no-op on Base documents", () => {
  // #226 extracted the shared document keydown handler out of app.js into
  // keyboard-shortcuts.js; the Base guard now lives there and app.js must supply the
  // documentKind accessor. Both halves stay asserted.
  assert.match(shortcuts, /event\.key === "s"[\s\S]{0,160}getDocumentKind\(\) === "base"[\s\S]{0,80}onSave\?\.\(\)/);
  assert.match(app, /initializeKeyboardShortcuts\(\{[\s\S]{0,300}getDocumentKind: \(\) => state\.documentKind/);
});

test("app.js reads the Base deep-link meta and switches on initial load", () => {
  assert.match(app, /initialDeepLink\(\)/);
  assert.match(app, /baseNavigation\.openBase\(\{ \.\.\.initialBase, historyMode: "replace"/);
});

test("base-navigation injects BASE_SURFACE_CSS and hosts the surface", () => {
  assert.match(wiring, /import \{ BASE_SURFACE_CSS, createBaseSurface \} from "\.\.\/bases\/index\.js"/);
  assert.match(wiring, /style\.textContent = BASE_SURFACE_CSS/);
  assert.match(wiring, /style\.setAttribute\("data-base-surface", ""\)/);
  assert.match(wiring, /getElementById\("base-host"\)/);
});

test("base-navigation never touches the Markdown editor, save queue or Publish", () => {
  const code = stripComments(wiring);
  assert.doesNotMatch(code, /markdownEditor/);
  assert.doesNotMatch(code, /setValue/);
  assert.doesNotMatch(code, /enqueueSave|createSaveMutation/);
  assert.doesNotMatch(code, /publishController/);
  assert.doesNotMatch(code, /\/api\/web\/v1\/note/);
});

test("document-kind keeps the explicit null|note|base state machine", () => {
  assert.match(kind, /DOCUMENT_KIND_NOTE = "note"/);
  assert.match(kind, /DOCUMENT_KIND_BASE = "base"/);
  assert.match(kind, /readInitialBaseTarget/);
  assert.match(kind, /initial-base-path/);
  assert.doesNotMatch(stripComments(kind), /\.innerHTML\b/);
});

test("document-kind hides and restores the Markdown-only chrome on Base", () => {
  // Capture, hide and restore are structural: same list, same index as `disabled`.
  assert.match(kind, /hidden: list\.map\(\(node\) => Boolean\(node\.hidden\)\)/);
  assert.match(kind, /node\.disabled = true;\s*node\.hidden = true;/);
  assert.match(kind, /captured\.hidden\[index\] !== undefined\) list\[index\]\.hidden = captured\.hidden\[index\]/);
  // app.js supplies the chrome controls without a second selector list.
  assert.match(app, /controls: \{[\s\S]{0,400}topbarStatus: \$\("\.topbar-status"\)/);
});

test("the topbar path label is Base-aware and restores the note label", () => {
  assert.match(kind, /pathLabelText: pathLabel \? String\(pathLabel\.textContent \?\? ""\) : null/);
  assert.match(kind, /pathLabel\.textContent = basePathText/);
  assert.match(kind, /pathLabel\.textContent === basePathText/);
  assert.match(wiring, /pathLabel/);
  assert.match(wiring, /kind\.enterBase\(path\)/);
  assert.match(app, /openNote, pathLabel,/);
});

test("bind-navigation routes Base entries through openBase on popstate", () => {
  assert.match(bind, /getDocumentKind = \(\) => "note"/);
  assert.match(bind, /openBase = async \(\) => false/);
  assert.match(bind, /target\.documentKind === "base" \? "base" : "note"/);
  assert.match(bind, /targetKind === "base"[\s\S]{0,200}await openBase\(/);
});
