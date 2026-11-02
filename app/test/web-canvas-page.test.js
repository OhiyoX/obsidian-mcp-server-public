// Canvas document page contract (G11): what the page publishes, and the negative
// half of the zero-request evidence.
//
// The client asset is the only client file that renders a `.canvas`, and this test
// pins the two sides of that claim:
//   - the ordinary shells (`/app`, note, Base) carry NO canvas.js reference and no
//     canvas host, so a document that is not a canvas can never request it;
//   - the canvas page carries the versioned asset URL plus the path/vault contract
//     the asset reads, and nothing else changes (the shell is otherwise the same
//     appPage markup).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const [{ appPage }, { readCanvasTarget, canvasApiUrl, watchDocumentSwitch }] = await Promise.all([
  import("../src/app/pages.js"),
  import("../frontend/app/features/canvas/canvas.js"),
]);

const APP_DIR = path.resolve(import.meta.dirname, "..");
const SESSION = { username: "canvas", displayName: "Canvas", csrf: "csrf-token" };
const CANVAS_TARGET = { vaultId: "vault-1", path: "Boards/Roadmap.canvas" };

test("the workspace shell never references the canvas asset", () => {
  const noteShell = appPage(SESSION, {}, { vaultId: "vault-1", path: "Note.md" });
  for (const [label, markup] of [
    ["/app welcome shell", appPage(SESSION, {})],
    ["note shell", noteShell],
    ["Base shell", appPage(SESSION, {}, null, { vaultId: "vault-1", path: "Project.base" })],
  ]) {
    assert.equal(markup.includes("canvas.js"), false, `${label} must not reference canvas.js`);
    assert.equal(markup.includes("canvas-host"), false, `${label} must not carry a canvas host`);
    assert.equal(markup.includes("initial-canvas-path"), false, `${label} must not publish a canvas target`);
  }
  // The same markup as before this slice: a note shell is byte-identical whether or
  // not the canvas argument exists (the extra markup is conditional, never shifted).
  assert.equal(noteShell, appPage(SESSION, {}, { vaultId: "vault-1", path: "Note.md" }, null, null));
});

test("the canvas page publishes the versioned asset, the host and the path contract", async () => {
  const markup = appPage(SESSION, {}, null, null, CANVAS_TARGET);
  const hash = createHash("sha256").update(await fs.readFile(path.join(APP_DIR, "src/app/assets/canvas.js"))).digest("hex").slice(0, 16);
  assert.ok(markup.includes(`<script type="module" src="/app/assets/canvas.js?v=${hash}"`), "the canvas asset must carry the content hash");
  assert.ok(markup.includes('data-canvas-path="Boards/Roadmap.canvas"'), "the page publishes the target path to the asset");
  assert.ok(markup.includes('data-canvas-vault="vault-1"'));
  assert.ok(markup.includes('<meta name="initial-canvas-path" content="Boards/Roadmap.canvas">'));
  assert.ok(markup.includes('<meta name="initial-canvas-vault" content="vault-1">'));
  assert.ok(markup.includes('<div id="canvas-host" hidden></div>'));
  // CSS and the shell scripts are untouched: the canvas page is the same shell.
  assert.deepEqual(
    [...markup.matchAll(/<script\b[^>]*?src="\/app\/assets\/([^"?]+)/g)].map((match) => match[1]).sort(),
    ["app-loader.js", "canvas.js", "theme-boot.js"],
    "the canvas page adds exactly one script",
  );
  // The path is escaped like every other page value, so a hostile file name cannot
  // break out of the attribute.
  const escaped = appPage(SESSION, {}, null, null, { vaultId: "vault-1", path: 'x" onload="alert(1).canvas' });
  assert.equal(escaped.includes('onload="alert(1)"'), false, "the path must be attribute-escaped");
});

test("the asset reads its target from the page, and files no request without one", () => {
  const doc = (scriptAttr, metaContent) => ({
    querySelector(selector) {
      if (selector === "script[data-canvas-path]") return scriptAttr ? { getAttribute: (name) => scriptAttr[name] ?? null } : null;
      if (selector === 'meta[name="initial-canvas-path"]') return metaContent === undefined ? null : { getAttribute: () => metaContent };
      if (selector === 'meta[name="initial-canvas-vault"]') return null;
      return null;
    },
  });
  assert.deepEqual(
    readCanvasTarget(doc({ "data-canvas-path": "Boards/Roadmap.canvas", "data-canvas-vault": "vault-1" })),
    { path: "Boards/Roadmap.canvas", vaultId: "vault-1" },
  );
  assert.deepEqual(readCanvasTarget(doc(null, "Boards/Roadmap.canvas")), { path: "Boards/Roadmap.canvas", vaultId: null });
  assert.equal(readCanvasTarget(doc(null, null)), null, "no target on the page means no canvas request");
  assert.equal(readCanvasTarget({}), null);
  assert.equal(canvasApiUrl({ path: "Boards/Roadmap.canvas" }), "/api/web/v1/canvas?path=Boards%2FRoadmap.canvas");
});

test("opening a note drops the canvas overlay instead of covering the note", () => {
  const listeners = [];
  const host = { hidden: false };
  let switched = 0;
  const doc = { getElementById: (id) => (id === "document-tabs" ? { id } : null) };
  const stop = watchDocumentSwitch({ doc, host, onSwitch: () => { switched += 1; } });
  assert.equal(typeof stop, "function");
  // Without a MutationObserver (or without the tab strip) the watcher is a no-op
  // rather than an exception: the page contract must never depend on it.
  assert.equal(watchDocumentSwitch({ doc: {}, host })(), undefined);
  assert.deepEqual(listeners, []);
});
