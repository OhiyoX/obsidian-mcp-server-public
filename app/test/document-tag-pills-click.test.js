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
    /<a class="tag property-pill multi-select-pill" href="#alpha" data-tag="alpha" data-internal-link="true"><span class="multi-select-pill-content">alpha<\/span><\/a>/,
  );
  assert.match(html, /href="#beta" data-tag="beta"/);
  assert.match(html, /href="#gamma" data-tag="gamma"/, "singular tag key is a tag too");
  assert.equal(/data-tag="Alias A"/.test(html), false, "aliases are not tag searches");
  assert.equal(/data-tag="wide"/.test(html), false, "cssclasses is not a tag");
  assert.match(html, /<span class="property-pill multi-select-pill"><span class="multi-select-pill-content">Alias A<\/span><\/span>/);
  assert.match(html, /<span class="property-pill multi-select-pill"><span class="multi-select-pill-content">wide<\/span><\/span>/);
  // Lane pill-max-width: every pill holds desktop's `.multi-select-pill-content` box (asar
  // app.js@1845965), which is the node the pill's `max-width` clamp sizes, so the label wraps inside
  // the pill instead of widening the value column.
  assert.equal((html.match(/class="multi-select-pill-content"/g) ?? []).length, 5, "one content box per pill (5 values across 4 rows)");
});

// Lane note-pills-gap: a multi-value property row in the reading view must be one desktop
// `.multi-select-container`, not a space-joined inline flow. Before this pin, `valueHtml()` joined
// the pills with `join(" ")` inside the plain block value cell, so the wrap distance was the line
// box: measured in real Chromium (1440x900, dark, 9 tags) the two lines sat 21.5px apart for a
// 21.5px pill (line gap 0.00px) and neighbouring pills on one line were 3.56px apart (the width of
// one space at 13px). Desktop 1.14.4 `app.css` lays the same row out as
// `.multi-select-container { display: inline-flex; vertical-align: top; flex-wrap: wrap;
// flex: 1 1 auto; gap: var(--size-2-3); min-height: var(--input-height) }` with
// `--size-2-3: 6px`, i.e. 6px in both axes. Single-value rows are NOT wrapped: they keep their own
// inline box, height and click behaviour.
test("reading list values wrap in one desktop multi-select-container", () => {
  const html = propertiesHtml([
    ["tags", ["alpha", "beta"]],
    ["aliases", ["Alias A"]],
    ["created", new Date("2026-10-20T00:00:00.000Z")],
    ["flag", true],
    ["mcp_author", { client: "probe" }],
    ["project", "note-pills-gap"],
  ]);
  const rows = new Map([...html.matchAll(
    /<div class="metadata-property-key">.*?<span>([^<]+)<\/span><\/div><div class="metadata-property-value">(.*?)<\/div><\/div>/g,
  )].map((match) => [match[1], match[2]]));
  assert.deepEqual([...rows.keys()], ["tags", "aliases", "created", "flag", "mcp_author", "project"], "the row parser must see every property");

  // List values: exactly one container, pills adjacent (no space text node anywhere).
  assert.match(rows.get("tags"), /^<span class="multi-select-container"><a class="tag property-pill multi-select-pill" href="#alpha"/, "the tags row opens with the container, not with a space-separated pill flow");
  assert.match(rows.get("tags"), /alpha<\/span><\/a><a class="tag property-pill multi-select-pill" href="#beta"/, "pills must be adjacent: the gap is the container's, not a text space");
  assert.match(rows.get("tags"), /beta<\/span><\/a><\/span>$/, "the container must close right after the last pill");
  assert.equal((rows.get("tags").match(/class="multi-select-container"/g) ?? []).length, 1, "one container per list row");
  assert.match(rows.get("aliases"), /^<span class="multi-select-container"><span class="property-pill multi-select-pill"><span class="multi-select-pill-content">Alias A<\/span><\/span><\/span>$/);

  // Single values: untouched. Wrapping them would change their line box and click target.
  assert.match(rows.get("created"), /^<time class="metadata-property-date" datetime="/, "a date row keeps its own inline time box");
  assert.equal(rows.get("flag"), "<span class=\"property-pill property-boolean\">true</span>");
  assert.match(rows.get("mcp_author"), /^<code>/, "an object row keeps the monospace JSON code box");
  assert.equal(rows.get("project"), "note-pills-gap");
  for (const key of ["created", "flag", "mcp_author", "project"]) {
    assert.equal(/multi-select-container/.test(rows.get(key)), false, `${key} must not be wrapped`);
  }
});

test("Live property pills expose desktop's `.multi-select-pill-content` label box", () => {
  assert.match(panelSource, /multi-select-pill-content/);
  const root = createPropertiesPanel({
    data: { tags: ["alpha"], aliases: ["Alias A"] },
    onSearchTag: () => {},
    editable: true,
  });
  for (const [key, label] of [["tags", "alpha"], ["aliases", "Alias A"]]) {
    const [pillLabel] = tagPillLabels(root, key);
    assert.equal(pillLabel.className, "multi-select-pill-content", `${key}: the pill label is the content box the pill's max-width clamp sizes`);
    assert.equal(pillLabel.textContent, label, "the wrapper must not change the label text");
  }
});

test("Reading tag links escape the value into the attribute", () => {
  const html = propertiesHtml([["tags", ['a<b>"c']]]);
  assert.match(html, /data-tag="a&lt;b&gt;&quot;c"/);
  assert.equal(html.includes('data-tag="a<b>"c"'), false);
});
