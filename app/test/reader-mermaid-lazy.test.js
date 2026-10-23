// Reader Mermaid lazy gate (#482, third item).
//
// Covers the gate on a headless DOM: no fence ⇒ the chunk is never asked for, the shell-published
// versioned URL is what gets imported, a rendered fence replaces its block (so the copy button
// that pass attached goes with it), and both failure shapes (chunk unavailable, diagram rejected)
// keep the code block, keep its copy affordance and add a visible error line. The real-browser
// face (SVG actually painted, chunk requested only on a mermaid page, dark-mode filter) is
// asserted by the lane's Chromium probe, not here. The chunk's own literals are pinned below,
// because its Desktop-derived options are the parity claim.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { attachCopyCodeButtons } from "../frontend/app/features/reader/copy-code-button.js";
import {
  attachMermaidBlocks,
  mermaidChunkUrl,
  mermaidFences,
} from "../frontend/app/features/reader/mermaid-lazy.js";

const dom = createDomHarness();
dom.install();

const CHUNK_URL = "/app/assets/mermaid.js?v=0123456789abcdef";
// The gate caches one load per URL for the page's lifetime, so each case gets its own URL
// (the same contract also keeps a failed load from retrying on every re-render).
const OTHER_URL = "/app/assets/mermaid.js?v=fedcba9876543210";
const chunkSource = await fs.readFile(
  new URL("../frontend/app/features/reader/mermaid-runtime.js", import.meta.url),
  "utf8",
);

function publishChunk(url = CHUNK_URL) {
  for (const node of [...dom.document.head.childNodes]) node.remove?.();
  dom.document.head.childNodes.length = 0;
  const script = dom.createElement("script");
  script.setAttribute("data-mermaid-src", url);
  dom.document.head.appendChild(script);
}

function preview({ mermaid = 0, plain = 0 } = {}) {
  const root = dom.createElement("div");
  root.setAttribute("class", "markdown-preview-view markdown-rendered");
  for (let index = 0; index < mermaid; index += 1) {
    const pre = dom.createElement("pre");
    const code = dom.createElement("code");
    code.setAttribute("class", "language-mermaid");
    code.textContent = `graph TD; A${index}-->B${index};\n`;
    pre.appendChild(code);
    root.appendChild(pre);
  }
  for (let index = 0; index < plain; index += 1) {
    const pre = dom.createElement("pre");
    const code = dom.createElement("code");
    code.setAttribute("class", "language-js");
    code.textContent = `const plain${index} = 1;\n`;
    pre.appendChild(code);
    root.appendChild(pre);
  }
  return root;
}

/** A stand-in for the chunk: the real DOM leg is exercised in Chromium, not in this harness. */
function runtime({ fail = false, calls = [] } = {}) {
  return {
    calls,
    async renderFence(pre, code, doc) {
      calls.push(code.textContent);
      if (fail) throw new Error("syntax error");
      const host = doc.createElement("div");
      host.setAttribute("class", "mermaid");
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      host.appendChild(svg);
      pre.replaceWith(host);
    },
  };
}

function importer(impl) {
  const seen = [];
  return { seen, load: (url) => { seen.push(url); return impl(); } };
}

test("mermaid gate: a document without a fence never asks for the chunk", async () => {
  publishChunk();
  const probe = importer(() => { throw new Error("must not be called"); });
  const root = preview({ plain: 2 });
  const result = await attachMermaidBlocks(root, { chunkUrl: CHUNK_URL, importer: probe.load });
  assert.deepEqual(result, { fences: 0, rendered: 0, failed: 0 });
  assert.deepEqual(probe.seen, [], "an import-less render must not request the chunk");
  assert.equal(root.querySelectorAll(".mermaid").length, 0);
  assert.equal(root.querySelectorAll("pre").length, 2, "the plain blocks are untouched");
});

test("mermaid gate: the chunk URL is the shell-published, content-hashed one", async () => {
  publishChunk();
  assert.equal(mermaidChunkUrl(dom.document), CHUNK_URL);
  const probe = importer(() => runtime());
  const root = preview({ mermaid: 1 });
  await attachMermaidBlocks(root, { importer: probe.load });
  assert.deepEqual(probe.seen, [CHUNK_URL], "the versioned URL is what gets imported");
});

test("mermaid gate: a rendered fence replaces its block, copy button included", async () => {
  publishChunk();
  const fake = runtime();
  const root = preview({ mermaid: 1, plain: 1 });
  attachCopyCodeButtons(root);
  publishChunk(OTHER_URL);
  assert.equal(root.querySelectorAll(".copy-code-button").length, 2, "both blocks start with a button");
  const result = await attachMermaidBlocks(root, { importer: () => fake });
  assert.deepEqual(result, { fences: 1, rendered: 1, failed: 0 });
  assert.equal(root.querySelectorAll(".mermaid").length, 1, "the diagram replaces the fence");
  assert.equal(root.querySelectorAll("pre").length, 1, "only the plain block is left");
  assert.equal(root.querySelectorAll(".copy-code-button").length, 1, "the rendered diagram has no copy button");
  assert.deepEqual(fake.calls, ["graph TD; A0-->B0;\n"], "the fence body reaches the chunk verbatim");
  // Idempotent: the second pass finds no fence to render (the diagram is not a `pre > code`).
  assert.deepEqual(await attachMermaidBlocks(root, { importer: () => fake }), { fences: 0, rendered: 0, failed: 0 });
});

test("mermaid gate: an unavailable chunk keeps the code block, its button and shows the error", async () => {
  publishChunk();
  publishChunk("/app/assets/mermaid.js?v=offline");
  const root = preview({ mermaid: 1 });
  attachCopyCodeButtons(root);
  const result = await attachMermaidBlocks(root, { importer: () => Promise.reject(new Error("offline")) });
  assert.deepEqual(result, { fences: 1, rendered: 0, failed: 1 });
  const pre = root.querySelectorAll("pre")[0];
  assert.ok(pre, "the fence must survive a chunk that could not be fetched");
  assert.equal(pre.getAttribute("data-mermaid"), "error");
  assert.equal(pre.textContent, "graph TD; A0-->B0;\n", "the source is never swallowed");
  assert.equal(root.querySelectorAll(".copy-code-button").length, 1, "the copy affordance stays");
  const notice = root.querySelectorAll(".mermaid-error")[0];
  assert.ok(notice, "the failure must be visible");
  assert.equal(notice.getAttribute("role"), "status");
  assert.match(notice.textContent, /图表渲染失败/);
});

test("mermaid gate: a rejected diagram falls back the same way", async () => {
  publishChunk();
  publishChunk("/app/assets/mermaid.js?v=syntax");
  const root = preview({ mermaid: 2 });
  attachCopyCodeButtons(root);
  const result = await attachMermaidBlocks(root, { importer: () => runtime({ fail: true }) });
  assert.deepEqual(result, { fences: 2, rendered: 0, failed: 2 });
  assert.equal(root.querySelectorAll("pre").length, 2);
  assert.equal(root.querySelectorAll("pre[data-mermaid='error']").length, 2);
  assert.equal(root.querySelectorAll(".mermaid-error").length, 2);
  assert.equal(root.querySelectorAll(".copy-code-button").length, 2);
});

test("mermaid gate: a shell without the published URL fails closed, not open", async () => {
  for (const node of [...dom.document.head.childNodes]) void node;
  dom.document.head.childNodes.length = 0;
  const root = preview({ mermaid: 1 });
  attachCopyCodeButtons(root);
  const probe = importer(() => { throw new Error("must not be called"); });
  const result = await attachMermaidBlocks(root, { importer: probe.load });
  assert.deepEqual(result, { fences: 1, rendered: 0, failed: 1 });
  assert.deepEqual(probe.seen, [], "no URL, no request");
  assert.equal(root.querySelectorAll("pre").length, 1);
  assert.equal(root.querySelectorAll(".mermaid-error").length, 1);
});

test("mermaid gate: only `pre > code.language-mermaid` counts", () => {
  const root = preview({ mermaid: 1 });
  const paragraph = dom.createElement("p");
  const inline = dom.createElement("code");
  inline.setAttribute("class", "language-mermaid");
  paragraph.appendChild(inline);
  root.appendChild(paragraph);
  const orphan = dom.createElement("code");
  orphan.setAttribute("class", "language-mermaid");
  root.appendChild(orphan);
  assert.equal(mermaidFences(root).length, 1, "an inline or parentless language-mermaid is not a fence");
});

// Desktop parity pins for the chunk: the options are copied from the asar's app.js
// (`mermaid.initialize({startOnLoad:!1, securityLevel:"strict", …})`) and the CSS literals from
// app.css@3202/@11875/@12543. They cannot be asserted through the gate, which never sees them.
test("mermaid chunk: Desktop-derived initialize options and CSS literals are pinned", () => {
  for (const literal of [
    "startOnLoad: false",
    'securityLevel: "strict"',
    "themeVariables: { fontFamily: \"var(--font-mermaid)\" }",
    "flowchart: { useMaxWidth: false }",
    "sequence: { useMaxWidth: false }",
    "git: { useMaxWidth: false }",
    "er: { useMaxWidth: false }",
    "gantt: { useMaxWidth: true",
    "journey: { useMaxWidth: true }",
    "class: { useMaxWidth: true }",
    "state: { useMaxWidth: true }",
    "pie: { useMaxWidth: true }",
    ":root{--font-mermaid:var(--font-text)}",
    "filter:invert(100%) hue-rotate(180deg) saturate(1.25)",
    "overflow-x:auto",
    "color:var(--text-error,var(--color-red))",
  ]) {
    assert.ok(chunkSource.includes(literal), `the chunk must keep the Desktop literal: ${literal}`);
  }
});
