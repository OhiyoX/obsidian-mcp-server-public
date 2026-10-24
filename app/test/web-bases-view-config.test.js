// Per-(vault, base, view) client preferences: column widths + column visibility.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_VIEW_CONFIG_PREFIX,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  baseViewConfigKey,
  clampColumnWidth,
  readViewConfig,
  readViewOptions,
  resolveColumnWidths,
  toggleColumnVisibility,
  visibleColumns,
  withColumnWidth,
  writeViewConfig,
  writeViewOptions,
} from "../frontend/app/features/bases/view-config.js";

function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
  };
}

const COLUMNS = [
  { key: "name", label: "Name", kind: "string" },
  { key: "status", label: "Status", kind: "string" },
  { key: "updated", label: "updated", kind: "property" },
];

test("the storage key always contains vault, base and view", () => {
  const key = baseViewConfigKey({ vaultId: "v1", path: "40-Projects/Projects.base", view: "开发 dev" });
  assert.ok(key.startsWith(BASE_VIEW_CONFIG_PREFIX));
  assert.ok(key.includes("v1"));
  assert.ok(key.includes("40-Projects/Projects.base"));
  assert.ok(key.includes("开发 dev"));
  assert.notEqual(key, baseViewConfigKey({ vaultId: "v1", path: "40-Projects/Projects.base", view: "Other" }));
});

test("widths persist per key and survive a read", () => {
  const storage = makeStorage();
  const key = baseViewConfigKey({ vaultId: "v1", path: "P.base", view: "Table" });
  const config = withColumnWidth(withColumnWidth({ widths: {}, hidden: [] }, "name", 321), "status", 123);
  assert.equal(writeViewConfig(storage, key, config), true);
  const back = readViewConfig(storage, key);
  assert.equal(back.widths.name, 321);
  assert.equal(back.widths.status, 123);
  // A different view is a different key.
  assert.deepEqual(readViewConfig(storage, baseViewConfigKey({ vaultId: "v1", path: "P.base", view: "Cards" })), { widths: {}, hidden: [] });
});

test("widths are clamped and junk is ignored instead of throwing", () => {
  assert.equal(clampColumnWidth(10), MIN_COLUMN_WIDTH);
  assert.equal(clampColumnWidth(10_000), MAX_COLUMN_WIDTH);
  assert.equal(clampColumnWidth("nope"), null);
  const storage = makeStorage();
  storage.setItem("k", "not json");
  assert.deepEqual(readViewConfig(storage, "k"), { widths: {}, hidden: [] });
  storage.setItem("k", JSON.stringify({ widths: { a: "x", b: -5 }, hidden: [1, "a", ""] }));
  assert.deepEqual(readViewConfig(storage, "k"), { widths: { b: MIN_COLUMN_WIDTH }, hidden: ["a"] });
});

test("a missing or hostile storage never breaks rendering", () => {
  assert.deepEqual(readViewConfig(null, "k"), { widths: {}, hidden: [] });
  assert.equal(writeViewConfig(null, "k", { widths: {}, hidden: [] }), false);
  const throwing = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("quota"); },
  };
  assert.deepEqual(readViewConfig(throwing, "k"), { widths: {}, hidden: [] });
  assert.equal(writeViewConfig(throwing, "k", { widths: {}, hidden: [] }), false);
});

test("width resolution falls back to the declaration-order default", () => {
  const widths = resolveColumnWidths(COLUMNS, { widths: { status: 200 }, hidden: [] });
  assert.equal(widths.status, 200);
  assert.ok(widths.name > 0);
  assert.ok(widths.updated > 0);
});

test("hiding columns is client-side and never empties the table", () => {
  let config = { widths: {}, hidden: [] };
  config = toggleColumnVisibility(config, "status", COLUMNS);
  assert.deepEqual(visibleColumns(COLUMNS, config).map((column) => column.key), ["name", "updated"]);
  config = toggleColumnVisibility(config, "name", COLUMNS);
  config = toggleColumnVisibility(config, "updated", COLUMNS);
  // The last visible column can never be hidden.
  assert.equal(visibleColumns(COLUMNS, config).length, 1);
  config = toggleColumnVisibility(config, "status", COLUMNS);
  assert.deepEqual(visibleColumns(COLUMNS, config).map((column) => column.key), ["status", "updated"]);
});

// --- desktop per-view display options (read side, one storage key) ----------

test("view options round-trip on their own key and never clobber the column config", () => {
  const storage = makeStorage();
  const key = baseViewConfigKey({ vaultId: "v1", path: "P.base", view: "Cards" });
  assert.deepEqual(readViewOptions(storage, key), {});
  assert.equal(writeViewOptions(storage, key, { cardSize: 300, image: "cover", imageFit: "contain" }), true);
  assert.deepEqual(readViewOptions(storage, key), { cardSize: 300, image: "cover", imageFit: "contain" });
  // The column slice is untouched by an options write...
  assert.deepEqual(readViewConfig(storage, key), { widths: {}, hidden: [] });
  // ...and a later width/hidden write keeps the options (one key, two slices).
  writeViewConfig(storage, key, withColumnWidth({ widths: {}, hidden: ["status"] }, "name", 240));
  assert.deepEqual(readViewOptions(storage, key), { cardSize: 300, image: "cover", imageFit: "contain" });
  assert.equal(readViewConfig(storage, key).widths.name, 240);
  // Junk is ignored rather than thrown at render time.
  assert.deepEqual(readViewOptions(null, key), {});
  storage.setItem("junk", JSON.stringify({ options: [1, 2] }));
  assert.deepEqual(readViewOptions(storage, "junk"), {});
});

// --- view type is DISPLAY-METADATA ------------------------------------------

test("only list, cards and kanban leave the table; anything else falls back to it", async () => {
  const { BASE_VIEW_TYPE_CARDS, BASE_VIEW_TYPE_KANBAN, BASE_VIEW_TYPE_LIST, BASE_VIEW_TYPE_TABLE, normalizeViewType } =
    await import("../frontend/app/features/bases/view-options.js");
  assert.equal(normalizeViewType("list"), BASE_VIEW_TYPE_LIST);
  assert.equal(normalizeViewType("CARDS"), BASE_VIEW_TYPE_CARDS);
  assert.equal(normalizeViewType("kanban"), BASE_VIEW_TYPE_KANBAN);
  assert.equal(normalizeViewType("Kanban"), BASE_VIEW_TYPE_KANBAN);
  assert.equal(normalizeViewType("table"), BASE_VIEW_TYPE_TABLE);
  for (const value of [null, undefined, "", "map", 7, {}]) {
    assert.equal(normalizeViewType(value), BASE_VIEW_TYPE_TABLE, `${String(value)} must keep the table`);
  }
});

test("list options: desktop markers/separator defaults and the indent toggle", async () => {
  const { resolveViewOptions } = await import("../frontend/app/features/bases/view-options.js");
  // Defaults straight from the desktop getViewOptions (markers bullet, separator ", ").
  assert.deepEqual(resolveViewOptions("list"), { markers: "bullet", indentProperties: false, separator: ", " });
  assert.deepEqual(resolveViewOptions("list", { markers: "number", separator: " | ", indentProperties: true }),
    { markers: "number", indentProperties: true, separator: " | " });
  // A value outside the desktop dropdown vocabulary is not honoured.
  assert.equal(resolveViewOptions("list", { markers: "dash" }).markers, "bullet");
  assert.equal(resolveViewOptions("list", { separator: 5 }).separator, ", ");
  assert.equal(resolveViewOptions("list", { indentProperties: "yes" }).indentProperties, false);
});

test("cards options: cardSize/aspectRatio clamped like the desktop sliders", async () => {
  const { cardCoverHeight, resolveViewOptions } = await import("../frontend/app/features/bases/view-options.js");
  assert.deepEqual(resolveViewOptions("cards"),
    { cardSize: 200, imageProperty: null, imageFit: "", imageAspectRatio: 1 });
  const options = resolveViewOptions("cards", { cardSize: 300, image: "cover", imageFit: "contain", imageAspectRatio: 2 });
  assert.deepEqual(options, { cardSize: 300, imageProperty: "cover", imageFit: "contain", imageAspectRatio: 2 });
  // Slider ranges: 50..800 by 10 and 0.25..2.5 by 0.05; junk is the desktop default.
  assert.equal(resolveViewOptions("cards", { cardSize: 10 }).cardSize, 50);
  assert.equal(resolveViewOptions("cards", { cardSize: 5000 }).cardSize, 800);
  assert.equal(resolveViewOptions("cards", { cardSize: "wide" }).cardSize, 200);
  assert.equal(resolveViewOptions("cards", { imageAspectRatio: 0 }).imageAspectRatio, 1);
  assert.equal(resolveViewOptions("cards", { imageAspectRatio: 5 }).imageAspectRatio, 2.5);
  assert.equal(resolveViewOptions("cards", { imageAspectRatio: 0.1 }).imageAspectRatio, 0.25);
  // imageFit is Cover ("") unless it is exactly the desktop's contain value.
  assert.equal(resolveViewOptions("cards", { imageFit: "CONTAIN" }).imageFit, "");
  assert.equal(resolveViewOptions("cards", { image: "" }).imageProperty, null);
  // Cover height = card width / aspect ratio.
  assert.equal(cardCoverHeight(options), 150);
  assert.equal(cardCoverHeight({}), 200);
});
