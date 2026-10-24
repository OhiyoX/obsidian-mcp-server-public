// #481 remaining items: custom task states, `#`-prefixed property tags, the authored
// calendar day of a date-only property, and `[[Note#Head]]` display text.
//
// Desktop evidence (asar, read first-hand by this lane — see
// worktrees/desktop-re/syntax-gaps-481/CHECKPOINT.md for the raw windows):
//   - task state: app.js `dR=/^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?/` (group 6 = the
//     marker, any single character) and `n.checked = " " !== this.content`;
//   - tag: app.js multiselect option renderer `e.startsWith("#")&&(e=e.slice(1))` followed by
//     `openGlobalSearch("tag:"+e)`;
//   - date: app.js `e.setText(window.moment(this.date).format(this.time?"L LT":"L"))`;
//   - link text: app.js `dd(e){return e.split("#").filter(...).join(" > ")}` reached by
//     `fd()` whenever a wikilink has no alias.
//
// The node harness has no real DOMPurify, so `renderObsidianMarkdown` fail-closes to escaped
// source here; the escaping is undone before asserting so the readings stay the shipped markup.
// The unescaped DOM face is asserted in a real Chromium by evidence/probe-481-browser.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createDomHarness } from "./helpers/base-dom.mjs";

register("./css-stub-loader.mjs", import.meta.url);
const dom = createDomHarness();
dom.install();

const { renderObsidianMarkdown, propertiesHtml } = await import(
  "../frontend/app/features/reader/reader.js"
);
const { wikiLinkLabel } = await import("../frontend/app/features/editor/extensions/block-embed.js");
const { createPropertiesPanel } = await import("../frontend/app/features/document/properties-panel.js");

const unescapeHtml = (html) => String(html)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const render = (source) => unescapeHtml(renderObsidianMarkdown(source, { sourcePath: "Probe.md" }));

test("custom task states render as tasks with the authored marker", () => {
  for (const marker of ["/", "-", ">", "?", "x"]) {
    const html = render(`- [${marker}] c\n`);
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(html, new RegExp(`<li class="task-list-item is-checked" data-task="${escaped === ">" ? "&gt;" : escaped}">`), `[${marker}] is a task item`);
    assert.match(html, new RegExp(`<input data-task="${escaped}" class="task-list-item-checkbox" checked="" disabled="" type="checkbox">`), `[${marker}] carries the marker and is checked`);
  }
  // An open task keeps Desktop's exact shape: `data-task=" "`, no is-checked, no checked.
  const open = render("- [ ] c\n");
  assert.match(open, /<li class="task-list-item" data-task=" ">/);
  assert.match(open, /<input data-task=" " class="task-list-item-checkbox" disabled="" type="checkbox">/);
});

test("an uppercase X keeps its own case (Desktop copies the character verbatim)", () => {
  assert.match(render("- [X] c\n"), /data-task="X"/);
});

test("a bracket that is not a one-character marker is not a task", () => {
  const html = render("- [note] c\n");
  assert.equal(html.includes("task-list-item"), false);
  assert.equal(html.includes("data-task"), false);
});

test("a `#`-prefixed tag property loses the prefix in the pill, the href and the search tag", () => {
  const html = propertiesHtml([["tags", ["#edge", "sleep"]], ["tag", ["#solo"]]]);
  for (const tag of ["edge", "sleep", "solo"]) {
    assert.match(html, new RegExp(`href="#${tag}" data-tag="${tag}" data-internal-link="true"><span class="multi-select-pill-content">${tag}</span></a>`), tag);
  }
  assert.equal(html.includes('data-tag="#edge"'), false);
  assert.equal(html.includes('href="##edge"'), false);
  // Only one leading `#` is Desktop's rule; a bare `#` must not become an empty pill.
  assert.match(propertiesHtml([["tags", ["#"]]]), /data-tag="" data-internal-link="true"><span class="multi-select-pill-content"><\/span><\/a>/);
});

test("frontmatter tags reach the same surface (Reading) and the Live panel pill drops the prefix", () => {
  const html = render('---\ntags: "#edge, sleep"\n---\nbody\n');
  assert.match(html, /data-tag="edge"/);
  assert.equal(html.includes('data-tag="#edge"'), false);

  const searches = [];
  const root = createPropertiesPanel({
    data: { tags: ["#edge"] },
    onSearchTag: (value) => searches.push(value),
    editable: false,
  });
  const pill = root.querySelectorAll(".cm-live-tag-pill")[0];
  const label = pill.firstElementChild;
  assert.equal(label.textContent, "edge");
  assert.equal(label.dataset.tag, "edge");
  label.click();
  assert.deepEqual(searches, ["edge"]);
});

test("a date-only property keeps its authored day in a UTC-negative zone", () => {
  const cases = [
    ['---\ncreated: 2026-09-14\n---\nbody\n', "2026-09-14T00:00:00.000Z"],
    ['---\ncreated: "2026-09-14"\n---\nbody\n', "2026-09-14"],
  ];
  const script = `
    process.env.TZ = "America/Los_Angeles";
    const { register } = await import("node:module");
    register(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "css-stub-loader.mjs")).href)});
    const { createDomHarness } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "helpers/base-dom.mjs")).href)});
    createDomHarness().install();
    const reader = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../frontend/app/features/reader/reader.js")).href)});
    const strip = (html) => String(html).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    console.log(JSON.stringify(${JSON.stringify(cases.map(([source]) => source))}.map((source) => (strip(reader.renderObsidianMarkdown(source, { sourcePath: "Probe.md" })).match(/<time[^>]*>/) || [""])[0])));
  `;
  const raw = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  const chips = JSON.parse(raw.trim());
  assert.match(chips[0], /datetime="2026-09-14T00:00:00\.000Z"/, "the js-yaml Date keeps its instant in datetime");
  assert.match(chips[0], /metadata-property-date/, "and still renders as a date chip");
  assert.match(chips[1], /datetime="2026-09-14"/, "a date-only string stores just the day");

  // The visible text is the authored day, not the instant's local day (which would be 09/13).
  // Read the field VALUES through `formatToParts` instead of parsing a locale-ordered string: the
  // previous `toLocaleDateString(undefined, …).replace(/\D/g, "")` compared "20260914" against
  // whatever order the HOST locale prints (the CI runner answered "09142026", i.e. en-US), so this
  // assertion measured the machine's locale rather than the product's day (issue #602).
  const formatted = execFileSync(process.execPath, ["-e", `
    process.env.TZ = "America/Los_Angeles";
    const { isoDateParts } = require(${JSON.stringify(path.resolve(import.meta.dirname, "../frontend/app/features/document/property-value.js"))});
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(isoDateParts(new Date(Date.UTC(2026, 8, 14))).date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
    console.log(parts.year + "-" + parts.month + "-" + parts.day);
  `], { encoding: "utf8" }).trim();
  assert.equal(formatted, "2026-09-14", `the authored day renders in the browser zone, got ${formatted}`);
});

const localDay = (instant) => instant.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
const localTime = (instant) => instant.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

test("a value carrying a time renders ONE instant: its day and its time come from the same zone", async () => {
  const { formatDateValue } = await import("../frontend/app/features/document/property-value.js");
  // The old shape mixed the authored UTC day with the local clock time (wrong day in UTC-x zones).
  // On a UTC+8 host the 23:30Z case below is the exact failure the review measured (09/14 + 7:30 AM).
  for (const iso of ["2026-09-14T23:30:00Z", "2026-09-14T02:00:00Z", "2026-09-14T17:00:00Z"]) {
    const instant = new Date(iso);
    assert.equal(formatDateValue(instant), `${localDay(instant)} ${localTime(instant)}`, `${iso}: day and time must come from one zone`);
  }
  // A date-only value still renders its authored calendar day (year+month+day only, no time).
  const authored = new Date(Date.UTC(2026, 8, 14));
  assert.equal(formatDateValue(authored), localDay(new Date(2026, 8, 14)));
  assert.equal(formatDateValue(authored).includes(":"), false);
});

test("the Live panel chip and the reading chip render a Date instance through the same helpers", async () => {
  const { formatDateValue } = await import("../frontend/app/features/document/property-value.js");
  const authored = new Date(Date.UTC(2026, 8, 14));
  const panel = createPropertiesPanel({ data: { created: authored }, editable: false });
  const chip = panel.querySelector("time.metadata-property-date");
  assert.ok(chip, "a read-only Date instance must render as the date chip");
  assert.equal(chip.dateTime, authored.toISOString(), "the js-yaml Date keeps its instant in datetime");
  assert.equal(chip.textContent.trim(), formatDateValue(authored), "the panel chip text is the shared formatter's output");
  // The authored DAY, read by field instead of by digit order: the host locale decides whether the
  // text reads "2026/09/14" or "09/14/2026" (issue #602 red on the en-US CI runner), and that is a
  // display convention, not the property under test.
  const panelParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(authored).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  assert.equal(`${panelParts.year}-${panelParts.month}-${panelParts.day}`, "2026-09-14", `the panel shows the authored day, got ${chip.textContent}`);
  assert.match(propertiesHtml([["created", authored]]), /datetime="2026-09-14T00:00:00\.000Z"/, "Reading uses the same instant");
  assert.match(propertiesHtml([["created", authored]]), new RegExp(formatDateValue(authored).replace(/\//g, "\\/")), "and the same day text");
});

test("a wikilink without an alias shows the target with `#` segments joined by ` > `", () => {
  for (const [target, label] of [
    ["Note", "Note"],
    ["Note#Head", "Note &gt; Head"],
    ["Note#^blk", "Note &gt; ^blk"],
    ["Note#Head#Sub", "Note &gt; Head &gt; Sub"],
    ["Folder/Note#Head", "Folder/Note &gt; Head"],
    ["Note#", "Note"],
    ["Note#Head|Alias", "Alias"],
  ]) {
    const html = render(`[[${target}]]\n`);
    assert.match(html, new RegExp(`>${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</a>`), `${target} -> ${label}`);
  }
  // Live Preview's in-place wiki chrome renders the same text.
  assert.equal(wikiLinkLabel("[[Note#Head]]"), "Note > Head");
  assert.equal(wikiLinkLabel("[[Note#^blk]]"), "Note > ^blk");
  assert.equal(wikiLinkLabel("[[Note#Head|Alias]]"), "Alias");
});
