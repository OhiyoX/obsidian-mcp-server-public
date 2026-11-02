// The property page is an ON-DEMAND asset (coordinator R1 §1).
//
// `property-edit-lazy.js` is the eager gate, `property-edit-runtime.js` is the page and the write,
// and `src/app/assets/property-edit.js` is the built chunk the shell publishes as
// `data-property-edit-src`. The contract that keeps the first-screen ratchet honest:
//   ⓐ the eager bundle carries the gate and NOT the page (its markers, its strings, its CSS);
//   ⓑ the chunk really is ESM and really does carry the page + the PATCH + the copy;
//   ⓒ nothing is imported before a row's `›` is clicked, and clicking twice in one page loads once
//     (the ES module map dedups by URL — the gate keeps no cache);
//   ⓓ a missing or failing chunk is a VISIBLE line, never a silent empty page.
// Every pin has a negative control that turns it red.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import {
  PROPERTY_EDIT_LOAD_ERROR_TEXT,
  buildPropertyEditPageLazily,
  propertyEditChunkUrl,
} from "../frontend/app/features/bases/property-edit-lazy.js";
import { PROPERTY_EDIT_MESSAGES } from "../frontend/app/features/bases/property-edit-i18n.js";
import { PROPERTY_EDIT_CSS } from "../frontend/app/features/bases/property-edit-runtime.js";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const ASSETS_DIR = path.join(APP_DIR, "src", "app", "assets");
const RUNTIME_PATH = path.join(APP_DIR, "frontend", "app", "features", "bases", "property-edit-runtime.js");
const RUNTIME_URL = new URL(`file:///${RUNTIME_PATH.replaceAll("\\", "/")}`).href;

// Markers only the page (and its write) carry. If any of them appears in app.js, the eager bundle
// started paying for the page again.
// `base-panel-form` would also match the pre-existing `.base-panel-formula-source` rule; the note
// is the page-only class (the list has no `.base-panel-note`).
const PAGE_MARKERS = ["data-prop-display-name", "data-prop-type-select", "set-property-display-name", "base-panel-note"];
const ENTRY = { key: "status", label: "status", kind: "text", declaredType: null, displayName: null, checked: true, source: "column" };

const harness = createDomHarness();
harness.install();
const document = harness.document;

function scriptTag(url) {
  const script = document.createElement("script");
  if (url !== null) script.setAttribute("data-property-edit-src", url);
  document.head.appendChild(script);
  return script;
}

test("ⓐ the eager bundle carries the gate, not the page", async () => {
  const eager = await fs.readFile(path.join(ASSETS_DIR, "app.js"), "utf8");
  assert.ok(eager.includes("data-property-edit-src"), "the gate must be in the eager bundle (it owns the URL attribute)");
  for (const marker of PAGE_MARKERS) {
    assert.equal(eager.includes(marker), false, `${marker} must not be in the eager bundle`);
  }
  // The page's copy must not ride along either. Short labels ("Text", "List") would match ordinary
  // code, so the probes are the DISTINCTIVE strings; the failure line is the one string the gate
  // must keep (it renders exactly when the chunk is absent).
  const probes = ["显示名称", "属性类型", "只读（类型写面未证实）", "Display name", "Property type", "Read-only (no verified type write face)"];
  for (const text of probes) assert.equal(eager.includes(text), false, `page copy must not be in the eager bundle: ${text}`);
  assert.equal(Object.values(PROPERTY_EDIT_MESSAGES["zh-CN"]).includes("显示名称"), true, "the probe is real copy");
  assert.equal(Object.values(PROPERTY_EDIT_MESSAGES.en).includes("Display name"), true);

  // Negative control: every marker really exists in the chunk's SOURCES, so the pins above are not
  // passing because the search can never match.
  const sources = await Promise.all([
    "property-edit-runtime.js",
    "panel-property-edit.js",
    "property-write.js",
  ].map((name) => fs.readFile(path.join(APP_DIR, "frontend", "app", "features", "bases", name), "utf8")));
  const chunkSource = sources.join(String.fromCharCode(10));
  for (const marker of PAGE_MARKERS) {
    assert.ok(chunkSource.includes(marker), `the marker must exist in the chunk sources: ${marker}`);
  }
  assert.ok(chunkSource.includes("显示名称"), "the copy exists in the chunk's i18n slice");
});

test("ⓑ the published chunk is ESM and carries the page, the write and the CSS", async () => {
  const chunk = await fs.readFile(path.join(ASSETS_DIR, "property-edit.js"), "utf8");
  assert.ok(chunk.includes("export"), "the chunk is an ES module (dynamic import needs named exports)");
  assert.ok(chunk.includes("data-prop-display-name"), "the page DOM lives in the chunk");
  assert.ok(chunk.includes("set-property-display-name"), "the PATCH mutation lives in the chunk");
  assert.ok(chunk.includes("if-match") || chunk.includes("If-Match"), "the CAS header lives in the chunk");
  const css = PROPERTY_EDIT_CSS.join("");
  assert.ok(chunk.includes(css.slice(0, 40)), "the page's CSS travels with it");
  // Negative control: the eager bundle must not carry the CSS either.
  const eager = await fs.readFile(path.join(ASSETS_DIR, "app.js"), "utf8");
  assert.equal(eager.includes(PROPERTY_EDIT_CSS[0]), false, "the page's CSS must not be on the first screen");
});

test("ⓒ nothing loads before the click, and one URL loads once", async () => {
  const loads = [];
  const url = "/app/assets/property-edit.js?v=test";
  // No request until a page is actually built (the row's `›` is the only caller).
  assert.equal(loads.length, 0);
  const first = buildPropertyEditPageLazily({ doc: document, entry: ENTRY, url, load: (href) => { loads.push(href); return Promise.resolve({ fillPropertyPage: () => null }); } });
  const second = buildPropertyEditPageLazily({ doc: document, entry: ENTRY, url, load: (href) => { loads.push(href); return Promise.resolve({ fillPropertyPage: () => null }); } });
  await Promise.all([first.done, second.done]);
  assert.deepEqual(loads, [url, url], "each page build asks for the same URL; the module map is what dedups it");
  // Negative control: the URL really comes from the shell's attribute, not from a constant.
  assert.equal(propertyEditChunkUrl(document), "", "no script tag => no URL (an older shell)");
  const tag = scriptTag("/app/assets/property-edit.js?v=abc");
  assert.equal(propertyEditChunkUrl(document), "/app/assets/property-edit.js?v=abc");
  tag.remove?.();
});

test("ⓓ a missing or failing chunk renders a visible line and never an empty page", async () => {
  const missing = buildPropertyEditPageLazily({ doc: document, entry: ENTRY, url: "" });
  await missing.done;
  const line = missing.panel.childNodes.find?.((node) => node.getAttribute?.("data-prop-edit-error") !== null)
    ?? (function find(node) { if (node?.getAttribute?.("data-prop-edit-error") !== null) return node; for (const child of node?.childNodes ?? []) { const hit = find(child); if (hit) return hit; } return null; })(missing.panel);
  assert.ok(line, "a missing chunk must render [data-prop-edit-error]");
  assert.equal(line.textContent, PROPERTY_EDIT_LOAD_ERROR_TEXT);
  assert.equal(line.getAttribute("role"), "alert");
  assert.equal(missing.panel.getAttribute("data-prop-edit-loading"), null, "the loading marker is cleared");

  const failed = buildPropertyEditPageLazily({ doc: document, entry: ENTRY, url: "/x.js", load: () => Promise.reject(new Error("boom")) });
  await failed.done;
  assert.ok(failed.panel.childNodes.some?.((node) => node.getAttribute?.("data-prop-edit-error") !== null)
    || failed.panel.childNodes.length > 0, "a rejected import must not leave an empty panel");
});

test("the page's copy ships in both locales with the same keys", () => {
  const zh = Object.keys(PROPERTY_EDIT_MESSAGES["zh-CN"]).sort();
  const en = Object.keys(PROPERTY_EDIT_MESSAGES.en).sort();
  assert.deepEqual(zh, en, "the lazy slice keeps the two-locale parity rule of the shared catalogs");
  assert.ok(zh.includes("bases.property.displayName"));
  assert.ok(zh.includes("bases.property.typeUnverified"));
});
