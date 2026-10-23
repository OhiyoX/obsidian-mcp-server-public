import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { register } from "node:module";
import { createDomHarness } from "./helpers/base-dom.mjs";

register("./css-stub-loader.mjs", import.meta.url);
const dom = createDomHarness();
dom.install();

const { createPropertiesPanel } = await import("../frontend/app/features/document/properties-panel.js");
const { propertiesHtml } = await import("../frontend/app/features/reader/reader.js");

const panelSource = await fs.promises.readFile(
  new URL("../frontend/app/features/document/properties-panel.js", import.meta.url),
  "utf8",
);
const widgetSource = await fs.promises.readFile(
  new URL("../frontend/app/features/editor/properties-widget.js", import.meta.url),
  "utf8",
);

function rowFor(root, key) {
  return root.querySelectorAll(".document-property-row")
    .find((row) => row.querySelector(".metadata-property-key")?.textContent === key) || null;
}

function tagPillLabels(root, key) {
  const row = rowFor(root, key);
  assert.ok(row, `row ${key} exists`);
  return row.querySelectorAll(".cm-live-tag-pill").map((pill) => pill.firstElementChild);
}

test("Live tags pills expose data-tag and route the click to onSearchTag", () => {
  const searches = [];
  const root = createPropertiesPanel({
    data: { tags: ["alpha", "beta"], aliases: ["Alias A"], cssclasses: ["wide"] },
    onSearchTag: (value) => searches.push(value),
    editable: true,
  });

  const labels = tagPillLabels(root, "tags");
  assert.deepEqual(labels.map((label) => label.dataset.tag), ["alpha", "beta"]);
  assert.equal(labels[0].title, "在标签里搜索 alpha");
  assert.equal(labels[0].textContent, "alpha");

  labels[1].click();
  assert.deepEqual(searches, ["beta"], "clicking the label searches for that tag");

  // Semantics that must NOT be tag searches: aliases open a note, cssclasses is not a tag.
  for (const key of ["aliases", "cssclasses"]) {
    const other = tagPillLabels(root, key);
    assert.equal(other.length, 1, `${key} renders one pill`);
    assert.equal(other[0].dataset.tag, undefined, `${key} pill stays unclickable as a tag`);
    other[0].click();
  }
  assert.deepEqual(searches, ["beta"], "aliases / cssclasses clicks never search a tag");
});

test("Live pill remove button still edits without triggering a tag search", () => {
  const commits = [];
  const searches = [];
  const root = createPropertiesPanel({
    data: { tags: ["alpha", "beta"] },
    onChange: (next) => commits.push(next),
    onSearchTag: (value) => searches.push(value),
    editable: true,
  });

  const row = rowFor(root, "tags");
  const remove = row.querySelector(".cm-live-property-pill-remove");
  assert.ok(remove, "the remove button survives next to the clickable label");
  remove.click();
  assert.deepEqual(commits.at(-1), { tags: ["beta"] });
  assert.deepEqual(searches, [], "removal is not a tag search");
});

test("Live tags pills stay inert without an onSearchTag wiring", () => {
  const searches = [];
  const root = createPropertiesPanel({ data: { tags: ["alpha"] } });
  const labels = tagPillLabels(root, "tags");
  assert.equal(labels[0].dataset.tag, undefined);
  labels[0].click();
  assert.deepEqual(searches, []);
});

test("Live panel wiring reuses the editor obsidian-navigate detail seam", () => {
  assert.match(widgetSource, /onSearchTag/);
  assert.match(widgetSource, /OBSIDIAN_NAVIGATE_EVENT/);
  assert.match(widgetSource, /detail: \{[^}]*vaultId[^}]*sourcePath[^}]*tag/);
  assert.match(panelSource, /onSearchTag/);
});

test("Reading tags pills render as tag links with data-tag, only for tags", () => {
  const html = propertiesHtml([
    ["tags", ["alpha", "beta"]],
    ["aliases", ["Alias A"]],
    ["cssclasses", ["wide"]],
    ["tag", ["gamma"]],
  ]);

  assert.match(
    html,
    /<a class="tag property-pill multi-select-pill" href="#alpha" data-tag="alpha" data-internal-link="true">alpha<\/a>/,
  );
  assert.match(html, /href="#beta" data-tag="beta"/);
  assert.match(html, /href="#gamma" data-tag="gamma"/, "singular tag key is a tag too");
  assert.equal(/data-tag="Alias A"/.test(html), false, "aliases are not tag searches");
  assert.equal(/data-tag="wide"/.test(html), false, "cssclasses is not a tag");
  assert.match(html, /<span class="property-pill multi-select-pill">Alias A<\/span>/);
  assert.match(html, /<span class="property-pill multi-select-pill">wide<\/span>/);
});

test("Reading tag links escape the value into the attribute", () => {
  const html = propertiesHtml([["tags", ['a<b>"c']]]);
  assert.match(html, /data-tag="a&lt;b&gt;&quot;c"/);
  assert.equal(html.includes('data-tag="a<b>"c"'), false);
});
