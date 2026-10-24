// Phase 2B-1b-ii source-contract test for the lazy renderer.
//
// The repo has no DOM test library, so real DOM behavior is asserted by the real
// Chromium harness (2B-2). This locks the renderer's contract: it renders one level
// at a time from the per-parent children map, exposes an expand toggle that loads on
// demand, a per-parent load-more sentinel, and keeps the inline-create restore.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(new URL("../frontend/app/features/explorer/tree.js", import.meta.url), "utf8");
const draftSource = await fs.readFile(new URL("../frontend/app/features/explorer/create-draft.js", import.meta.url), "utf8");

test("renderLazyExplorer renders from the per-parent children map", () => {
  assert.match(source, /export function renderLazyExplorer\(/);
  assert.match(source, /model\.childrenByParent\.get\(parent\)/);
  assert.match(source, /renderLevel\("", host\)/);
  assert.match(source, /row\.onclick = \(\) => onToggle\?\.\(item\.path\)/);
});

test("renderLazyExplorer exposes a per-parent load-more sentinel", () => {
  assert.match(source, /model\.nextCursorByParent\.get\(parent\)/);
  assert.match(source, /button\.className = "tree-load-more"/);
  assert.match(source, /onLoadMore\?\.\(parent\)/);
});

test("the load-more sentinel is appended exactly once per parent", () => {
  // renderLevel() is the single sentinel exit; renderFolder() must not add a second.
  assert.doesNotMatch(source, /renderLoadMore\(item\.path, children\)/);
  assert.equal((source.match(/renderLoadMore\(/g) ?? []).length, 2, "definition + the single call in renderLevel");
});

test("a loading sentinel is disabled so it cannot re-fire the same request", () => {
  assert.match(source, /const loading = model\.loadingParents\.has\(parent\)/);
  assert.match(source, /button\.disabled = loading/);
});

test("the lazy folder add handler re-resolves the container after a lazy load", () => {
  // A collapsed+unloaded folder's first `+` must load the level, then insert the
  // inline editor into the LIVE children container (not the pre-render one).
  assert.match(source, /add\.onclick = async \(event\) =>/);
  assert.match(source, /await onEnsureExpanded\?\.\(item\.path\)/);
  assert.match(source, /openDraft\(\{ host, scope: item\.path,/);
  // The container is resolved after the await (never from the pre-render DOM).
  assert.match(source, /await onEnsureExpanded\?\.\(item\.path\);\s*openDraft\(\{ host, scope: item\.path,/);
  assert.match(source, /function draftContainer\(host, scope\) \{\s*if \(!scope\) return host;/);
});

test("the lazy folder add handler expands once and does not double-call onEnsureExpanded", () => {
  assert.match(source, /row\.setAttribute\("aria-expanded", "true"\)/);
});

test("renderLazyExplorer keeps the inline-create restore and smooth reveal", () => {
  assert.match(source, /renderDraft\(\{ host, phase: "folder", preserved \}\)/);
  assert.match(source, /scrollIntoView\(\{[\s\S]*?behavior:\s*"smooth"[\s\S]*?block:\s*"center"/);
  assert.doesNotMatch(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
});

test("the v1 renderExplorer is still present (not removed in this slice)", () => {
  assert.match(source, /export function renderExplorer\(/);
});

// --- U6 / #427: the inline draft row ----------------------------------------

test("the inline draft row is shared by all three create entries, with no prompt", () => {
  assert.match(draftSource, /export function beginDraft\(/);
  assert.match(draftSource, /export function hasActiveDraft\(/);
  assert.match(draftSource, /row\.className = isFolder \? "note-create-row folder-create-row" : "note-create-row"/);
  assert.match(draftSource, /input\.className = isFolder \? "note-create-input folder-create-input" : "note-create-input"/);
  assert.match(draftSource, /input\.placeholder = isFolder \? "文件夹名称" : "笔记名称"/);
  assert.match(draftSource, /const created = await draft\.onCommit\?\.\(/);
  assert.doesNotMatch(draftSource, /prompt\(/);
});

test("the draft survives a background re-render and does not hide the empty state", () => {
  // The draft is rebuilt from module state on every render, restored with focus.
  assert.match(draftSource, /export function preserveActiveDraft\(\)/);
  assert.match(draftSource, /isDraftInput\(globalThis\.document\?\.activeElement\)/);
  assert.match(draftSource, /if \(preserved\) \{\s*input\.focus\(\);/);
  assert.match(source, /const preserved = preserveActiveDraft\(\);/);
  assert.match(source, /renderDraft\(\{ host, phase: "root", preserved \}\)/);
  // An empty/loading root still renders the draft above the placeholder.
  assert.match(source, /if \(!hasRootDraft\(\)\) host\.innerHTML = '<div class="empty">没有找到笔记<\/div>'/);
  assert.match(source, /else if \(!hasRootDraft\(\)\) \{\s*host\.innerHTML = '<div class="empty">正在加载…<\/div>'/);
});

// --- BASE nodes (Wave B / B2) -----------------------------------------------

test("renderLevel dispatches a BASE node to its own renderer, not renderNote", () => {
  // Each renderer also receives the level depth (the row's own horizontal geometry).
  assert.match(source, /if \(item\.kind === "directory"\) renderFolder\(item, container, depth\)/);
  assert.match(source, /else if \(item\.kind === "base"\) renderBase\(item, container, depth\)/);
  assert.match(source, /else renderNote\(item, container, depth\)/);
  assert.match(source, /function renderBase\(item, container, depth\)/);
});

test("a BASE row is an ordinary file row plus a right-aligned BASE tag", () => {
  // Desktop parity: no bespoke glyph, a trailing muted `BASE` tag instead.
  assert.doesNotMatch(source, /BASE_ICON/);
  assert.match(source, /const BASE_TAG_TEXT = "BASE"/);
  assert.match(source, /<span class="note-badge">\$\{BASE_TAG_TEXT\}<\/span>/);
  assert.match(source, /button\.className = `note note-base\$\{active \? " active" : ""\}`/);
  assert.match(source, /button\.dataset\.kind = "base"/);
});

test("a BASE row shows the stem but exposes the full .base path for title/aria", () => {
  assert.match(source, /button\.title = item\.path;/);
  assert.match(source, /button\.setAttribute\("aria-label", item\.path\)/);
  assert.match(source, /class="note-title">\$\{escapeHtml\(item\.title \?\? item\.name \?\? item\.path\)\}/);
});

test("clicking a BASE row calls onOpenBase({ path }) and never onNote", () => {
  const baseFn = source.match(/function renderBase\(item, container, depth\) \{[\s\S]*?\n  \}/);
  assert.ok(baseFn, "renderBase is defined");
  assert.match(baseFn[0], /button\.onclick = \(\) => onOpenBase\?\.\(\{ path: item\.path \}\)/);
  assert.doesNotMatch(baseFn[0], /onNote/);
});

test("the Base active check never reuses the note `.md`-stripping identity", () => {
  assert.match(source, /function isCurrentBase\(basePath, currentPath\)/);
  const baseFn = source.match(/function isCurrentBase\(basePath, currentPath\) \{[\s\S]*?\n\}/);
  assert.ok(baseFn);
  assert.doesNotMatch(baseFn[0], /\\.md/);
  assert.match(source, /const active = isCurrentBase\(item\.path, currentPath\)/);
});

test("a note row keeps its existing render and onNote wiring", () => {
  assert.match(source, /button\.className = `note\$\{active \? " active" : ""\}`/);
  assert.match(source, /button\.onclick = \(\) => onNote\?\.\(item\.path\)/);
  assert.match(source, /<div class="note-title">\$\{escapeHtml\(item\.title \?\? item\.name \?\? item\.path\)\}<\/div>/);
});
