// Review D1–D4: the behaviours the independent review found broken, pinned so they cannot come
// back. Each assertion is written to be RED on the defect that was just fixed.
//
//   D1  409 must adopt the server's `currentRevision` (so a retry sends the NEW If-Match) and must
//       not claim "already reloaded" when it did not. The dedupe must not swallow a legitimate
//       retry. The production path must be the writer that adopts — not a dead export.
//   D2  Leaving the page with Esc/back restores focus to the ROW's chevron, not the toolbar button.
//   D3  The chevron's `aria-expanded` tracks state (true while its page is up, false on return).
//   D4  A missing/failing chunk keeps the panel chrome (back/close) and paints inside the panel.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { buildPropertyEditPanel } from "../frontend/app/features/bases/panel-property-edit.js";
import { buildPropertiesPanel } from "../frontend/app/features/bases/panel-properties.js";
import { buildPropertyEditPageLazily, PROPERTY_EDIT_LOAD_ERROR_TEXT } from "../frontend/app/features/bases/property-edit-lazy.js";
import { createBaseToolbar } from "../frontend/app/features/bases/toolbar.js";
import { createPropertyWriter, patchPropertyDisplayName } from "../frontend/app/features/bases/property-write.js";

const harness = createDomHarness();
harness.install();
const document = harness.document;
if (typeof document.createElementNS !== "function") {
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
}

const ENTRY = { key: "status", label: "status", kind: "text", declaredType: null, displayName: null, checked: true, source: "column" };
const CONTEXT = { doc: document, columns: [ENTRY], visibleColumns: [ENTRY], propertyCatalog: [ENTRY], config: {} };

function find(node, attribute) {
  if (typeof node?.querySelector === "function") {
    const hit = node.querySelector(`[${attribute}]`);
    if (hit) return hit;
  }
  for (const child of node?.childNodes ?? []) {
    if (child?.getAttribute?.(attribute) !== null && child?.getAttribute) return child;
    const deeper = find(child, attribute);
    if (deeper) return deeper;
  }
  return null;
}

/** A transport whose revision really moves when the writer adopts a 409. */
function revisionTransport() {
  const state = { path: "A.base", revision: "rev-1" };
  return {
    state,
    transport: {
      fetch: null, // replaced per test
      path: () => state.path,
      revision: () => state.revision,
      onRevision: (value) => { state.revision = value; },
      reload: () => {},
    },
  };
}

// ── D1 ──────────────────────────────────────────────────────────────────────

test("D1: a 409 adopts currentRevision and the SAME text then sends a PATCH with the NEW revision", async () => {
  const { state, transport } = revisionTransport();
  const calls = [];
  let attempt = 0;
  transport.fetch = async (url, options) => {
    attempt += 1;
    calls.push({ url, ifMatch: options.headers["if-match"], body: JSON.parse(options.body) });
    if (attempt === 1) {
      return { ok: false, status: 409, json: async () => ({ error: "revision-conflict", code: "revision-conflict", currentRevision: "rev-2" }) };
    }
    return { ok: true, status: 200, json: async () => ({ revision: "rev-3" }) };
  };
  const write = createPropertyWriter({ fetchImpl: () => transport.fetch, state, reload: () => {}, copy: {} });
  await assert.rejects(() => write({ property: "status", value: "状态Y" }), (error) => error.status === 409 && error.recovered === true);
  assert.equal(state.revision, "rev-2", "the 409's currentRevision is adopted (the review's defect: it was dropped)");
  const second = await write({ property: "status", value: "状态Y" });
  assert.equal(second.revision, "rev-3");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].ifMatch, '"rev-1"');
  // Red on the defect: before the fix the retry re-sent `rev-1` and looped on 409.
  assert.equal(calls[1].ifMatch, '"rev-2"', "the retry must carry the revision the server just gave");
  assert.equal(state.revision, "rev-3");
});

test("D1: the page allows a retry after a refusal — the dedupe is keyed on the revision it would send", async () => {
  const sent = [];
  let revision = "rev-1";
  let fail = true;
  const panel = buildPropertyEditPanel({}, CONTEXT, {
    entry: ENTRY,
    onSubmit: async (payload) => {
      sent.push({ ...payload, revision });
      if (fail) {
        fail = false;
        revision = "rev-2"; // the transport adopted the 409's currentRevision
        const error = new Error("stale");
        error.status = 409;
        throw error;
      }
      return { revision: "rev-3" };
    },
  });
  const input = find(panel, "data-prop-display-name");
  input.value = "状态Y";
  input.onblur();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sent.length, 1, "first submit goes out");
  const error = find(panel, "data-prop-edit-error");
  assert.equal(error.hidden, false);

  // Same text again — the review measured 0 PATCH here. It must go out with the NEW revision.
  input.onblur();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sent.map((one) => one.revision), ["rev-1", "rev-2"], "the retry is sent with the adopted revision");
  assert.equal(error.hidden, true, "and a successful retry clears the line");
});

test("D1: the 409 copy never claims a reload that did not happen", async () => {
  const { createPropertyWriter: makeWriter } = await import("../frontend/app/features/bases/property-write.js");
  const state = { path: "A.base", revision: "rev-1" };
  const stale = { ok: false, status: 409, json: async () => ({ error: "revision-conflict", code: "revision-conflict" }) };
  const write = makeWriter({ fetchImpl: () => async () => stale, state, reload: () => {}, copy: {} });
  const error = await write({ property: "status", value: "x" }).then(() => null, (cause) => cause);
  assert.equal(error.status, 409);
  assert.equal(error.recovered, false);
  assert.equal(error.currentRevision, null);
  assert.equal(state.revision, "rev-1", "nothing to adopt: the revision must not be touched");
  assert.match(error.message, /未取回|could not be fetched|reopen|重新打开/, "the copy must say the revision was NOT refreshed");
  assert.doesNotMatch(error.message, /已取回最新 revision|latest revision was fetched/, "and must not claim it was");
});

test("D1: the shipping page routes its write through the adopting writer (no dead code path)", async () => {
  // Red on the defect: the reviewed head had `createPropertyWriter` exported but unused, so the page
  // called the raw PATCH and could never refresh its revision.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../frontend/app/features/bases/property-edit-runtime.js", import.meta.url), "utf8"));
  assert.match(source, /createPropertyWriter\(/, "the chunk must call the writer that adopts a 409");
  assert.doesNotMatch(source, /patchPropertyDisplayName\(/, "and must not call the raw PATCH behind its back");
});

// ── D2 / D3 ─────────────────────────────────────────────────────────────────

function toolbarHarness() {
  const host = document.createElement("div");
  const toolbar = createBaseToolbar({ doc: document, onRenameProperty: () => {} });
  const state = { columns: [ENTRY], visibleColumns: [ENTRY], totalMatched: 1, rows: [], viewType: "table" };
  const context = { ...CONTEXT, allColumns: [ENTRY] };
  const render = () => {
    const next = toolbar.render(state, context);
    host.replaceChildren(next);
    toolbar.afterMount(next, render);
  };
  render();
  return { host, toolbar };
}

test("D3: the chevron's aria-expanded is true while its page is up and false again after returning", () => {
  const { host, toolbar } = toolbarHarness();
  find(host, 'data-base-action="properties"').onclick();
  const rowAction = find(host, "data-prop-action-icon");
  assert.equal(rowAction.getAttribute("aria-expanded"), "false");
  rowAction.onclick({ preventDefault() {}, stopPropagation() {} });
  // The dialog it owns is now open (the row itself leaves the document while the page shows).
  assert.equal(rowAction.getAttribute("aria-expanded"), "true", "pushing the page must flip the control it came from");
  assert.equal(toolbar.getPanelDepth(), 2);
  // Back re-renders the list from scratch: the fresh row is closed again.
  document.dispatchEvent?.({ type: "keydown", key: "Escape", composedPath: () => [] });
  assert.equal(toolbar.getPanelDepth(), 1);
  assert.equal(find(host, "data-prop-action-icon").getAttribute("aria-expanded"), "false", "a returned list is closed");
  toolbar.destroy();
});

test("D2: leaving the page returns focus to that row's chevron, not the toolbar action", () => {
  const { host, toolbar } = toolbarHarness();
  find(host, 'data-base-action="properties"').onclick();
  const rowAction = find(host, "data-prop-action-icon");
  rowAction.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(toolbar.getPanelDepth(), 2);
  // Esc / the header's back runs `back()` through the same path.
  document.dispatchEvent?.({ type: "keydown", key: "Escape", composedPath: () => [] });
  assert.equal(toolbar.getPanelDepth(), 1, "Escape pops the page, not the whole menu");
  const restored = host.querySelector?.('[data-focus="prop-edit-status"]') ?? find(host, 'data-focus="prop-edit-status"');
  assert.ok(restored, "the row's chevron is back in the list");
  assert.equal(document.activeElement?.getAttribute?.("data-focus"), "prop-edit-status", "and it holds the focus");
  toolbar.destroy();
});

// ── D4 ──────────────────────────────────────────────────────────────────────

test("D4: a failing chunk keeps the panel chrome and paints the error inside the panel body", async () => {
  const page = buildPropertyEditPageLazily({ doc: document, entry: ENTRY, url: "/missing.js", load: () => Promise.reject(new Error("boom")) });
  // The chrome the pages menu adds around the gate's shell.
  const header = document.createElement("div");
  header.setAttribute("data-base-panel-header", "");
  const back = document.createElement("button");
  back.setAttribute("data-base-panel-back", "");
  const close = document.createElement("button");
  close.setAttribute("data-base-panel-close", "");
  header.appendChild(back);
  header.appendChild(close);
  page.panel.insertBefore(header, page.panel.firstChild);
  await page.done;
  assert.ok(find(page.panel, "data-base-panel-back"), "the back control must survive the failure (review D4)");
  assert.ok(find(page.panel, "data-base-panel-close"), "and so must close");
  const error = find(page.panel, "data-prop-edit-error");
  assert.ok(error, "the failure line is visible");
  assert.equal(error.textContent, PROPERTY_EDIT_LOAD_ERROR_TEXT);
  assert.equal(error.parentNode?.getAttribute?.("data-base-panel-scroll") !== undefined, true, "it lives in the panel's own body");
  assert.equal(page.panel.getAttribute("data-prop-edit-loading"), null);
});

test("D4: a chunk that arrives keeps the same chrome (it fills the body, never replaces the panel)", async () => {
  const page = buildPropertyEditPageLazily({
    doc: document,
    entry: ENTRY,
    url: "/ok.js",
    load: async () => ({
      fillPropertyPage: (panel, { doc, entry }) => {
        const body = panel.querySelector("[data-base-panel-scroll]");
        body.replaceChildren();
        const marker = doc.createElement("div");
        marker.setAttribute("data-prop-edit-page", entry.key);
        body.appendChild(marker);
        return panel;
      },
    }),
  });
  const header = document.createElement("div");
  header.setAttribute("data-base-panel-header", "");
  page.panel.insertBefore(header, page.panel.firstChild);
  await page.done;
  assert.ok(find(page.panel, "data-base-panel-header"), "the header survives a successful load too");
  assert.ok(find(page.panel, "data-prop-edit-page"), "and the page body arrived");
});

test("the raw PATCH keeps its own shape for callers that have no writer", async () => {
  const calls = [];
  await patchPropertyDisplayName({
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ revision: "rev-2" }) }; },
    path: "A.base",
    revision: "rev-1",
    property: "status",
    value: "x",
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).ifMatch, "rev-1");
});
