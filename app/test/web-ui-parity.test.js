import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { HELP_CARD_MAX_WIDTH, computeHelpCardLayout } from "../frontend/app/features/search/help-popover.js";
import { computePopupLayout } from "../frontend/app/ui/popup-position.js";

const css = await fs.readFile(new URL("../src/app/assets/app.css", import.meta.url), "utf8");
const appSource = await fs.readFile(new URL("../frontend/app/core/app.js", import.meta.url), "utf8");
const pagesSource = await fs.readFile(new URL("../src/app/pages.js", import.meta.url), "utf8");
const sortControlSource = await fs.readFile(new URL("../frontend/app/features/explorer/sort-control.js", import.meta.url), "utf8");
const sprite = await fs.readFile(new URL("../src/app/assets/icons.svg", import.meta.url), "utf8");

const button = (rect) => ({ left: rect.right - 36, top: rect.top, right: rect.right, bottom: rect.top + rect.height });

test("help card stays inside the viewport at the default sidebar width", () => {
  // 1280px viewport, 270px sidebar starting after the 44px ribbon: the old absolute
  // card measured left=-4 in production (48px of content clipped away).
  const layout = computeHelpCardLayout({
    button: button({ top: 110, height: 30, right: 306 }),
    viewport: { width: 1280, height: 860 },
  });
  assert.equal(layout.width, HELP_CARD_MAX_WIDTH);
  assert.ok(layout.left >= 8, JSON.stringify(layout));
  assert.ok(layout.left + layout.width <= 1280 - 8, JSON.stringify(layout));
  assert.equal(layout.openUp, false);
  assert.equal(layout.top, 144);
});

test("help card shrinks instead of being clipped on a narrow viewport", () => {
  for (const width of [594, 420, 360, 320]) {
    const layout = computeHelpCardLayout({
      button: button({ top: 100, height: 40, right: width - 20 }),
      viewport: { width, height: 846 },
    });
    assert.ok(layout.left >= 8, `${width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.left + layout.width <= width - 8, `${width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.width >= Math.min(200, width - 16), `${width}: ${JSON.stringify(layout)}`);
    assert.ok(layout.maxHeight > 0, `${width}: ${JSON.stringify(layout)}`);
  }
});

test("popups flip above the trigger instead of running off the bottom", () => {
  const layout = computeHelpCardLayout({
    button: button({ top: 700, height: 30, right: 306 }),
    viewport: { width: 1280, height: 760 },
  });
  assert.equal(layout.openUp, true);
  assert.equal(layout.top, 696);
  assert.ok(layout.maxHeight <= 420, JSON.stringify(layout));
});

test("popup height is bounded by the shorter side and never negative", () => {
  const short = computeHelpCardLayout({
    button: button({ top: 8, height: 24, right: 306 }),
    viewport: { width: 1280, height: 180 },
  });
  assert.ok(short.maxHeight >= 0 && short.maxHeight <= 420, JSON.stringify(short));
  const degenerate = computeHelpCardLayout({ button: button({ top: 0, height: 0, right: 0 }), viewport: { width: 0, height: 0 } });
  assert.ok(degenerate.width >= 0 && degenerate.left >= 0, JSON.stringify(degenerate));
});

test("popup layout can follow the trigger's left edge and a content width", () => {
  const layout = computePopupLayout({
    trigger: { left: 40, right: 76, top: 100, bottom: 130 },
    viewport: { width: 400, height: 800 },
    minWidth: 220,
    maxWidth: 220,
    align: "start",
  });
  assert.equal(layout.width, 220);
  assert.equal(layout.left, 40);
  assert.equal(layout.openUp, false);
});

test("help card escapes the sidebar clipping box and can be dismissed", () => {
  assert.match(css, /\.search-help-card\.is-positioned \{ position: fixed; right: auto; \}/);
  assert.match(css, /\.search-help-card \{[\s\S]*?max-height: min\(70vh, 420px\)[\s\S]*?overflow: auto/);
  assert.match(appSource, /initializeSearchHelp\(\)/);
  assert.match(appSource, /import \{ initializeSearchHelp \} from "\.\.\/features\/search\/help-popover\.js"/);
  // The trigger stays inside the search row (the frozen regression asserts this too).
  assert.match(pagesSource, /<div class="search-row">[\s\S]*?class="search-help"[\s\S]*?<\/div>/);
});

test("sorting is a toolbar trigger plus an option menu, like the desktop file explorer", () => {
  const actions = pagesSource.slice(pagesSource.indexOf('class="sidebar-actions"'), pagesSource.indexOf("</div>", pagesSource.indexOf('class="sidebar-actions"')));
  assert.match(actions, /id="explorer-sort-toggle"/);
  assert.match(actions, /aria-haspopup="menu"/);
  assert.match(actions, /aria-controls="explorer-sort-menu"/);
  assert.match(actions, /id="reveal-active"/);
  assert.match(actions, /id="publishes-open"/);
  assert.doesNotMatch(actions, /class="explorer-sort-menu"/);
  // One option per key×direction, mirroring the desktop labels, with the live one checked.
  const menu = pagesSource.slice(pagesSource.indexOf('id="explorer-sort-menu"'), pagesSource.indexOf('id="search"'));
  for (const [key, direction] of [["name", "asc"], ["name", "desc"], ["modified", "desc"], ["modified", "asc"]]) {
    assert.match(menu, new RegExp(`data-sort-key="${key}" data-sort-direction="${direction}"`));
  }
  assert.equal((menu.match(/aria-checked="true"/g) || []).length, 1);
  assert.match(menu, /文件名 \(A-Z\)/);
  assert.match(menu, /编辑时间 \(从新到旧\)/);
  assert.doesNotMatch(pagesSource, /class="explorer-sort"/);
  assert.doesNotMatch(pagesSource, /explorer-sort-key/);
  assert.match(sprite, /<symbol id="arrow-up-narrow-wide" viewBox="0 0 24 24">/);
});

test("sort menu is positioned from the viewport and never steals draft focus", () => {
  assert.match(css, /\.explorer-sort-menu \{ position: fixed;[^}]*z-index: 30;/);
  assert.match(css, /\.explorer-sort-option\[aria-checked="true"\] \.explorer-sort-option-check \{ display: inline-flex; \}/);
  assert.match(css, /\.explorer-sort-option \{ min-height: 44px; \}/);
  assert.match(sortControlSource, /import \{ applyPopupLayout, computePopupLayout \} from "\.\.\/\.\.\/ui\/popup-position\.js"/);
  assert.match(sortControlSource, /preventFocusSteal\(root\)/);
  assert.match(sortControlSource, /preventFocusSteal\(button\)/);
  assert.match(sortControlSource, /if \(keyboard\) optionFor\(current\)\?\.focus\?\.\(\)/);
  assert.match(sortControlSource, /if \(keyboardOpened\) root\.focus\?\.\(\)/);
});

test("header path is a clickable breadcrumb, like the desktop header", async () => {
  const breadcrumbSource = await fs.readFile(new URL("../frontend/app/features/navigation/breadcrumb.js", import.meta.url), "utf8");
  const wiringSource = await fs.readFile(new URL("../frontend/app/features/navigation/header-breadcrumb.js", import.meta.url), "utf8");
  // Directory segments are buttons that reveal the folder; the file segment stays text.
  assert.match(breadcrumbSource, /button\.className = "path-crumb path-crumb-folder"/);
  assert.match(breadcrumbSource, /addEventListener\("click", \(\) => onReveal\?\.\(prefix\)\)/);
  assert.match(breadcrumbSource, /addEventListener\("mousedown", \(event\) => event\.preventDefault\(\)\)/);
  assert.match(breadcrumbSource, /name\.className = "path-crumb path-crumb-file"/);
  assert.match(wiringSource, /scrollIntoView\(\{ block: "center" \}\)/);
  assert.match(appSource, /initializeHeaderBreadcrumb\(\{ host: pathLabel, explorer \}\)/);
  assert.match(appSource, /pathBreadcrumb\.render\(result\.path\)/);
  assert.match(css, /\.current-path \{ min-width: 0; flex: 1; display: flex;/);
  assert.match(css, /\.path-crumb-folder:hover, \.path-crumb-folder:focus-visible \{ background: var\(--background-modifier-hover\)/);
  assert.match(css, /\.path-crumb-file \{ flex: 0 1 auto; overflow: hidden; color: var\(--text-normal\); text-overflow: ellipsis; \}/);
});

test("ISO date property values render as locale dates with the calendar glyph", async () => {
  const { formatDateValue, isoDateParts } = await import("../frontend/app/features/document/property-value.js");
  assert.deepEqual(isoDateParts("2026-10-04")?.iso, "2026-10-04");
  assert.equal(isoDateParts("2026-13-01"), null, "impossible month is not a date");
  assert.equal(isoDateParts("2026-02-31"), null, "impossible day is not a date");
  // #481: a datetime is a date *with a time* now (desktop renders `L LT`), and its day
  // comes from its own date part — the old "only a bare calendar date is inferred"
  // contract is what made the chip disappear for YAML datetimes.
  assert.deepEqual(isoDateParts("2026-10-04T00:00:00Z")?.iso, "2026-10-04", "a datetime keeps its own date part");
  assert.equal(isoDateParts("2026-10-04T00:00:00Z")?.time, true, "a datetime is flagged as carrying a time");
  assert.deepEqual(isoDateParts(new Date(Date.UTC(2026, 9, 4)))?.iso, "2026-10-04", "a YAML date-only Date is recognised");
  assert.equal(isoDateParts("assessment"), null);
  const formatted = formatDateValue("2026-10-04");
  assert.match(formatted, /2026/, formatted);
  assert.notEqual(formatted, "2026-10-04", "the source text is replaced by the locale form");
  assert.match(formatDateValue("2026-10-04T00:00:00Z"), /2026/, "a datetime still renders its calendar date");
  const panelSource = await fs.readFile(new URL("../frontend/app/features/document/properties-panel.js", import.meta.url), "utf8");
  assert.match(panelSource, /time\.className = "metadata-property-date"/);
  assert.match(panelSource, /time\.append\(icon\("calendar", "svg-icon metadata-property-date-icon"\), document\.createTextNode\(dateText\)\)/);
  // The Live panel's Date values take the same chip branch (no instant formatted by hand): a
  // read-only Date instance falls through to it, so the panel cannot render a second day.
  assert.equal(/\.toLocaleDateString\(/.test(panelSource), false, "the panel must not format an instant itself");
  assert.match(panelSource, /value instanceof Date && editable/);
  assert.match(css, /\.preview \.metadata-property-date \{ display: inline-flex; align-items: center; gap: 5px; \}/);
});

test("the document header keeps only the desktop control set (no copy-link / Publish chips)", async () => {
  // U10: the desktop document header carries the reading-view toggle (📖) and the
  // more-options menu (⋮) only; copy-link / Publish / outline are menu items. The old
  // 28px header chips must not come back, and their CSS must not survive them.
  assert.doesNotMatch(pagesSource, /id="copy-note-link"/);
  assert.doesNotMatch(pagesSource, /id="publish-toggle"/);
  assert.doesNotMatch(pagesSource, /desktop-document-action/);
  assert.doesNotMatch(css, /\.topbar-icon-action/);
  assert.doesNotMatch(css, /\.desktop-document-action/);
  assert.doesNotMatch(css, /\.mobile-document-actions/);
  // Exactly one view-mode control is rendered (the header one): the status-bar duplicate
  // is gone, so the mode's aria-checked state is unambiguous.
  assert.equal((pagesSource.match(/class="icon-btn view-mode-toggle"/g) ?? []).length, 1);
  assert.doesNotMatch(pagesSource, /status-bar-btn/);
  // The menu items keep the publish controller's contract: a label span per action and
  // one .document-action-label for the Publish state text.
  const controllerSource = await fs.readFile(new URL("../frontend/app/features/publish/controller.js", import.meta.url), "utf8");
  assert.match(controllerSource, /const label = button\.querySelector\("span:last-child"\);/);
  assert.match(controllerSource, /button\.querySelector\("\.document-action-label"\)\.textContent = label;/);
});

test("reader properties use the same date chip as the panel", async () => {
  const readerSource = await fs.readFile(new URL("../frontend/app/features/reader/reader.js", import.meta.url), "utf8");
  assert.match(readerSource, /import \{ formatDateValue, isoDateParts \} from "\.\.\/document\/property-value\.js"/);
  assert.match(readerSource, /const dateChip = \(iso, text\) => `<time class="metadata-property-date" datetime="\$\{escape\(iso\)\}"/);
  assert.match(readerSource, /return dateChipFor\(value\) \?\? escape\(String\(value\)\);/);
  // The Date branch must delegate to the shared chip (isoDateParts + formatDateValue). It used to
  // format the instant with `toLocaleDateString()`, which took the day from UTC and the time from
  // the local zone — two different instants on one chip, wrong day in UTC-x zones (#481 blocker B).
  assert.match(readerSource, /if \(value instanceof Date\) \{[\s\S]*?return dateChipFor\(value\) \?\? escape\(value\.toISOString\(\)\);/);
  assert.equal(/\.toLocaleDateString\(/.test(readerSource), false, "the reader must not format an instant itself");
});

test("every line of a selection highlights its number, without filling the cell", async () => {
  const source = await fs.readFile(new URL("../frontend/app/features/editor/extensions/selection-gutter.js", import.meta.url), "utf8");
  const surfaceSource = await fs.readFile(new URL("../frontend/app/features/editor/extensions/surface.js", import.meta.url), "utf8");
  const themeSource = await fs.readFile(new URL("../frontend/app/features/editor/extensions/theme.js", import.meta.url), "utf8");
  assert.match(source, /class SelectedLineMarker extends GutterMarker/);
  assert.match(source, /elementClass = "cm-selectedLineGutter"/);
  assert.match(source, /for \(let number = first; number <= last; number \+= 1\)/);
  assert.match(source, /provide: \(field\) => gutterLineClass\.from\(field\)/);
  assert.match(surfaceSource, /import \{ selectedLineGutter \} from "\.\/selection-gutter\.js"/);
  assert.match(surfaceSource, /highlightActiveLineGutter\(\),\s+selectedLineGutter,/);
  // Number colour only — no background fill on the (possibly wrapped) gutter cell.
  assert.match(themeSource, /"\.cm-lineNumbers \.cm-selectedLineGutter": \{ color: "var\(--text-normal\)" \}/);
  assert.match(themeSource, /"\.cm-activeLineGutter": \{ backgroundColor: "transparent", color: "var\(--text-normal\)" \}/);
});

test("selectedLineGutter marks every line of a multi-line selection", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { selectedLineGutter } = await import("../frontend/app/features/editor/extensions/selection-gutter.js");
  const source = await fs.readFile(new URL("../frontend/app/features/editor/extensions/selection-gutter.js", import.meta.url), "utf8");
  const build = (selection) => {
    const state = EditorState.create({ doc: "a\nb\nc\nd\ne\nf", selection, extensions: [selectedLineGutter] });
    const set = state.field(selectedLineGutter);
    const numbers = [];
    set.between(0, state.doc.length, (from) => { numbers.push(state.doc.lineAt(from).number); });
    return numbers;
  };
  assert.deepEqual(build({ anchor: 0, head: 5 }), [1, 2, 3], "a selection through line 3 marks lines 1-3");
  assert.deepEqual(build({ anchor: 2, head: 2 }), [], "a bare caret is left to the active-line gutter");
  // A selection reaching the end of the document marks its last line as well.
  assert.deepEqual(build({ anchor: 0, head: 11 }), [1, 2, 3, 4, 5, 6], "the whole document selected");
  // Multi-cursor selections are marked range by range (the field loops state.selection.ranges);
  // EditorSelection.create() in this CodeMirror version normalises a synthetic two-range
  // selection to one range, so it cannot assert that here.
  assert.match(source, /for \(const range of state\.selection\.ranges\)/);
});
