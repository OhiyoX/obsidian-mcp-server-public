// The kanban layout is an ON-DEMAND asset: kanban-lazy.js is the eager gate,
// kanban-runtime.js is the board, and `src/app/assets/kanban.js` is the built chunk the
// shell publishes as `data-kanban-src`. These assertions are the contract that keeps the
// first-screen ratchet honest (RECON §6 刀2, the canvas.js precedent):
//   ⓐ the eager bundle carries the gate and NOT the board;
//   ⓑ the asset really is ESM and really does carry the board (+ its CSS);
//   ⓒ zero imports without a kanban view, one with one — and a re-render is not a second
//     load, because the ES module map dedups by URL (the gate keeps no cache). Every one
//     of these has a negative control that turns it red.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { buildKanbanLazily, kanbanChunkUrl, KANBAN_LOAD_ERROR_TEXT } from "../frontend/app/features/bases/kanban-lazy.js";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const ASSETS_DIR = path.join(APP_DIR, "src", "app", "assets");
const RUNTIME_PATH = path.join(APP_DIR, "frontend", "app", "features", "bases", "kanban-runtime.js");
const RUNTIME_URL = new URL(`file:///${RUNTIME_PATH.replaceAll("\\", "/")}`).href;

// A marker only the board implementation carries: if it ever appears in app.js, the eager
// bundle started paying for the layout again (and the two assertions in ⓐ are the pair
// that makes the absence meaningful).
const BOARD_MARKER = "bases-kanban-column-header";

const harness = createDomHarness();
harness.install();
const document = harness.document;

function scriptTag(url = RUNTIME_URL) {
  const script = document.createElement("script");
  if (url !== null) script.setAttribute("data-kanban-src", url);
  document.head.appendChild(script);
  return script;
}

function boardState() {
  return {
    groups: [{ key: "active", keyType: "string", count: 1, rowPaths: ["A.md"] }],
    rows: [{ path: "A.md", values: { name: "A" } }],
  };
}

const COLUMNS = [{ key: "name", label: "Name", kind: "string" }];

test("ⓐ the eager bundle carries the gate, not the board", async () => {
  const eager = await fs.readFile(path.join(ASSETS_DIR, "app.js"), "utf8");
  assert.ok(eager.includes("data-kanban-src"), "the gate must be in the eager bundle (it owns the URL attribute)");
  assert.equal(eager.includes(BOARD_MARKER), false, "the board implementation must not be in the eager bundle");
  assert.equal(eager.includes("--base-kanban-column-width"), false, "the board's CSS must not be in the eager bundle");
  // Negative control: the marker is a real string, so the two assertions above are not
  // passing because the search can never match.
  const runtimeSource = await fs.readFile(RUNTIME_PATH, "utf8");
  assert.ok(runtimeSource.includes(BOARD_MARKER), "the marker must exist somewhere, or the pin above is vacuous");
  assert.ok(runtimeSource.includes("--base-kanban-column-width"));
});

test("ⓑ the published chunk is ESM and carries the board", async () => {
  const chunk = await fs.readFile(path.join(ASSETS_DIR, "kanban.js"), "utf8");
  assert.ok(chunk.includes(BOARD_MARKER), "the built asset must carry the board");
  assert.match(chunk, /export\{|export /, "the asset must be an ES module (the gate dynamic-imports it)");
  // Negative control: the same shape asserted of the wrong asset fails, so the two
  // assertions above are not satisfied by every bundle.
  const css = await fs.readFile(path.join(ASSETS_DIR, "app.css"), "utf8");
  assert.equal(css.includes(BOARD_MARKER), false);
});

test("ⓒ the gate resolves the shell-published URL and imports nothing without one", async () => {
  const published = scriptTag();
  assert.equal(kanbanChunkUrl(document), RUNTIME_URL, "the gate must read the shell's own attribute");
  // Negative control: without the attribute the gate has no URL at all…
  published.removeAttribute("data-kanban-src");
  assert.equal(kanbanChunkUrl(document), "", "no published asset => no URL");
  const wrap = document.createElement("div");
  const built = buildKanbanLazily({
    doc: document, state: boardState(), columns: COLUMNS, options: {}, storedOptions: {},
    host: { rowHost: wrap }, primitives: { createCardItem: () => document.createElement("div") },
  });
  await built.done;
  // …so the import is never attempted, and the failure is explicit (never a table).
  // The reported reason is itself the proof that nothing was imported: an `import("")`
  // attempt would reject and be reported as `chunk-failed` (see the broken-asset test).
  assert.equal(built.wrap.querySelector("[data-kanban-error]").getAttribute("data-kanban-error"), "chunk-unavailable");
  assert.equal(built.wrap.querySelector("[data-kanban-error]").textContent, KANBAN_LOAD_ERROR_TEXT);
  assert.equal(built.wrap.querySelector(".base-table"), null);
  // …and with the attribute back, the real chunk loads and the board really lands.
  published.setAttribute("data-kanban-src", RUNTIME_URL);
  const ok = buildKanbanLazily({
    doc: document, state: boardState(), columns: COLUMNS, options: {}, storedOptions: {},
    host: { rowHost: null }, primitives: { createCardItem: () => document.createElement("div") },
  });
  await ok.done;
  assert.equal(ok.wrap.querySelectorAll(".bases-kanban-column").length, 1);
});

// The gate has NO cache of its own: three renders are one load because the ES module map
// keys by URL, dedups in-flight loads and returns one instance
// (`evidence/probe-import-dedup.mjs` — sequential AND concurrent, real Chromium). This
// test therefore asserts that module-map semantics directly, with the real `import()` and
// no injected importer: `helpers/kanban-runtime-probe.mjs` counts how many times it was
// EVALUATED and re-exports the real runtime, which is the thing a hand-written cache
// would have been faking.
const PROBE_URL = new URL("./helpers/kanban-runtime-probe.mjs", import.meta.url).href;

function render(host, url) {
  return buildKanbanLazily({
    doc: document, url, state: boardState(), columns: COLUMNS, options: {}, storedOptions: {},
    host: { rowHost: host }, primitives: { createCardItem: () => document.createElement("div") },
  });
}

test("ⓒ three renders of the same view evaluate the chunk once (module-map dedup)", async () => {
  const url = `${PROBE_URL}?dedup=1`;
  globalThis.__kanbanRuntimeProbeEvals = 0;
  for (let round = 0; round < 3; round += 1) {
    const built = render(null, url);
    await built.done;
    // The board really landed each round (the probe re-exports the real runtime), so the
    // count below is not "no work happened".
    assert.equal(built.wrap.querySelectorAll(".bases-kanban-column").length, 1, `round ${round} must render the board`);
  }
  assert.equal(globalThis.__kanbanRuntimeProbeEvals, 1, "three renders must EVALUATE the chunk once");
  assert.equal(await import(url), await import(url), "and the module map hands back one instance");
  assert.equal(globalThis.__kanbanRuntimeProbeEvals, 1, "…which is still that one evaluation");
  // Negative control: a different URL is a different module entry (a new evaluation), so
  // the assertion above is not passing because the counter can never move.
  const second = render(null, `${PROBE_URL}?dedup=2`);
  await second.done;
  assert.equal(second.wrap.querySelectorAll(".bases-kanban-column").length, 1);
  assert.equal(globalThis.__kanbanRuntimeProbeEvals, 2, "a different URL must be a second evaluation");
});

test("ⓒ a broken asset is fail-closed, not a table fallback", async () => {
  // A real import failure (no such module), not a stubbed rejection: the gate must not
  // swallow a missing chunk into a table.
  const url = new URL("./helpers/kanban-chunk-that-does-not-exist.mjs", import.meta.url).href;
  const built = render(null, url);
  await built.done;
  assert.equal(built.wrap.querySelector("[data-kanban-error]").getAttribute("data-kanban-error"), "chunk-failed");
  assert.equal(built.wrap.querySelector("[data-kanban-error]").textContent, KANBAN_LOAD_ERROR_TEXT);
  assert.equal(built.wrap.querySelector(".base-table"), null, "a failed chunk must never fall back to the table");
});

test("the shell publishes the versioned kanban asset URL (the request-0/1 publish point)", async () => {
  const { appPage } = await import("../src/app/pages.js");
  const markup = appPage({ username: "kanban-lazy", displayName: "Lazy", csrf: "csrf-token" }, {});
  const hash = createHash("sha256").update(await fs.readFile(path.join(ASSETS_DIR, "kanban.js"))).digest("hex").slice(0, 16);
  const published = `/app/assets/kanban.js?v=${hash}`;
  const attribute = /data-kanban-src="([^"]+)"/.exec(markup)?.[1] ?? null;
  assert.equal(attribute, published, "the shell must publish the content-hashed asset URL");
  // Negative control: the publishing point really follows the file's bytes.
  const other = createHash("sha256").update("not the asset").digest("hex").slice(0, 16);
  assert.notEqual(attribute, `/app/assets/kanban.js?v=${other}`);
  // It is an inert data attribute on the loader script, not a new eager <script src>.
  const scripts = [...markup.matchAll(/<script\b[^>]*?src="\/app\/assets\/([^"?]+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(scripts, ["app-loader.js", "theme-boot.js"], `the shell's eager scripts must not grow: ${scripts.join(", ")}`);
  assert.match(markup, /<script src="\/app\/assets\/app-loader\.js\?v=[0-9a-f]{16}"[^>]*data-kanban-src=/);
});
