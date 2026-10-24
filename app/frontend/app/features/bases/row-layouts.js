// The two non-table Base layouts: desktop `bases-list-*` (app.js@3180669) and
// `bases-cards-*` (app.js@3147204), read-only.
//
// Both render the *same* cell codec the table uses (`valueNode`), so the row set can
// never depend on the view type (BASES-COMPATIBILITY-MATRIX §12.1). Everything the
// desktop private options change is a box, a marker or a separator:
//   list  markers (bullet|number|none) -> `span.list-bullet` ("-") / `span.list-number`
//         ("<row>.") / nothing, `separator` -> `span.bases-list-separator` text between
//         the further properties, `indentProperties` -> those properties get their own
//         `-` lines instead (desktop hides the separator field in that mode).
//   cards `cardSize` -> `--base-card-size` (card width), `image` -> the property whose
//         value paints the cover, `imageFit` -> `background-size: cover|contain`,
//         `imageAspectRatio` -> the cover height.
import { isAsLinkCell } from "./cell.js";
import { IMAGE_FIT_CONTAIN, cardCoverHeight } from "./view-options.js";
import { createGroupHeadingEl, groupFoldId, groupPage, setHeadingCollapsed } from "./group-heading.js";

// kanban is NOT here: the 4th layout ships as an on-demand asset (kanban-lazy.js is
// the eager gate, kanban-runtime.js is the board) so the first screen does not pay
// for it. It still renders these cards: the runtime is handed `createCardItem`.
export function createRowLayouts({ doc, coarse, valueNode, valueFor, rowKey, select, isSelected, markSelected }) {
  // Folded groups, per mount. The desktop keeps the folded set in its query controller and
  // persists it (`saveGroupFolds`, app.js@2499736); this surface keeps it for the lifetime of
  // the mounted view and registers the missing persistence (matrix §14.12). It lives here and
  // not on the DOM so a re-render (page append, action, resize) paints the same folded state.
  const folds = new Set();
  // Row identity (`data-row-id`) is shared with the table so a probe can diff the row
  // set across view types; the coarse-pointer tap adds the same selection state.
  function decorate(node, key) {
    node.setAttribute("data-row-id", key);
    if (isSelected(key)) markSelected(node, true);
    if (coarse) node.addEventListener("click", () => select(key, node));
    return node;
  }

  function wrap(className, container, host) {
    const node = doc.createElement("div");
    node.className = className;
    node.appendChild(container);
    host.rowHost = container;
    return { wrap: node, headRow: null };
  }

  // One group heading, wired to the group box it belongs to: the desktop's click handler
  // (`createGroupHeadingEl`, app.js@2499736) toggles the fold, then `bO` paints `is-collapsed`
  // on the heading and its chevron (app.js@1498694) while the BOX is what hides the rows —
  // `.bases-list-group` / `.bases-cards-group` in the matrix §14.12 reading R5/R6.
  function groupHeading(page, bucket, box) {
    const id = groupFoldId(bucket.key);
    const collapsed = id !== null && folds.has(id);
    box.classList.toggle("is-collapsed", collapsed);
    const heading = createGroupHeadingEl({
      doc,
      label: page.label,
      key: bucket.key,
      collapsed,
      onToggle: (foldId) => {
        const next = !folds.has(foldId);
        if (next) folds.add(foldId);
        else folds.delete(foldId);
        setHeadingCollapsed(heading, next);
        box.classList.toggle("is-collapsed", next);
      },
    });
    return heading;
  }

  // ---- list ----------------------------------------------------------------

  function createListProperty(row, column, columnIndex, marker) {
    const property = doc.createElement("span");
    property.className = "bases-list-property";
    property.setAttribute("data-column", column.key);
    if (column.kind === "formula") property.setAttribute("data-column-kind", "formula");
    if (marker) {
      const glyph = doc.createElement("span");
      glyph.className = marker.className;
      glyph.textContent = marker.text;
      property.appendChild(glyph);
    }
    property.appendChild(valueNode(row, column, columnIndex));
    return property;
  }

  function createListItem(row, columns, index, options) {
    const item = doc.createElement("div");
    item.className = "bases-list-item";
    item.setAttribute("role", "listitem");
    decorate(item, rowKey(row, index));
    const first = columns[0];
    if (!first) return item;
    const marker = options.markers === "none" ? null : options.markers === "number"
      ? { className: "list-number", text: `${index + 1}.` }
      : { className: "list-bullet", text: "-" };
    const properties = doc.createElement("div");
    properties.className = "bases-list-item-properties";
    properties.appendChild(createListProperty(row, first, 0, marker));
    const rest = columns.slice(1);
    if (options.indentProperties) {
      const indented = doc.createElement("div");
      indented.className = "bases-list-item-properties is-indented";
      rest.forEach((column, offset) => {
        indented.appendChild(createListProperty(row, column, offset + 1, { className: "list-bullet", text: "-" }));
      });
      if (rest.length) item.appendChild(indented);
    } else {
      rest.forEach((column, offset) => {
        const separator = doc.createElement("span");
        separator.className = "bases-list-separator";
        separator.textContent = options.separator;
        properties.appendChild(separator);
        properties.appendChild(createListProperty(row, column, offset + 1, null));
      });
    }
    item.appendChild(properties);
    return item;
  }

  function buildList(state, columns, options, host) {
    const container = doc.createElement("div");
    container.className = "bases-list-container";
    container.setAttribute("role", "list");
    container.setAttribute("data-base-list", "");
    // The view's desktop option keys/values, readable without a panel (read side only).
    container.setAttribute("data-list-markers", options.markers);
    container.setAttribute("data-list-indent-properties", String(options.indentProperties));
    container.setAttribute("data-list-separator", options.separator);
    const page = groupPage(state);
    if (!page) {
      state.rows.forEach((row, index) => container.appendChild(createListItem(row, columns, index, options)));
      return wrap("base-list-wrap", container, host);
    }
    // Grouped list, desktop shape (app.js@3185086): `bases-list-group` holds the heading and
    // then `bases-list-group-list` with that group's rows. The `role=list` moves onto the
    // element that actually owns the listitems, so the group wrapper cannot sit between a
    // list and its items in the accessibility tree.
    container.setAttribute("data-base-group-by", page.groupBy.property);
    container.setAttribute("data-base-group-direction", page.groupBy.direction);
    container.removeAttribute("role");
    let index = 0;
    for (const bucket of page.buckets) {
      const group = doc.createElement("div");
      group.className = "bases-list-group";
      group.appendChild(groupHeading(page, bucket, group));
      const list = doc.createElement("div");
      list.className = "bases-list-group-list";
      list.setAttribute("role", "list");
      for (const row of bucket.rows) list.appendChild(createListItem(row, columns, index++, options));
      group.appendChild(list);
      container.appendChild(group);
    }
    page.floating.forEach((row) => container.appendChild(createListItem(row, columns, index++, options)));
    return wrap("base-list-wrap", container, host);
  }

  // ---- cards ---------------------------------------------------------------

  function createCardItem(row, columns, index, options) {
    const card = doc.createElement("div");
    card.className = "bases-cards-item";
    card.setAttribute("role", "listitem");
    decorate(card, rowKey(row, index));
    if (options.imageProperty) {
      const imageIndex = columns.findIndex((column) => column.key === options.imageProperty);
      const cover = doc.createElement("div");
      cover.className = "bases-cards-cover";
      cover.setAttribute("data-image-fit", options.imageFit === IMAGE_FIT_CONTAIN ? "contain" : "cover");
      // Desktop paints the cover from the picked property; a value that is not a
      // resolved link keeps the box empty (no invented placeholder).
      cover.style.height = `${cardCoverHeight(options)}px`;
      cover.style.backgroundSize = options.imageFit === IMAGE_FIT_CONTAIN ? "contain" : "cover";
      const value = imageIndex >= 0 ? valueFor(row, columns[imageIndex], imageIndex) : null;
      if (isAsLinkCell(value)) cover.setAttribute("data-image-src", value.path);
      card.appendChild(cover);
    }
    columns.forEach((column, columnIndex) => {
      const property = doc.createElement("div");
      property.className = columnIndex === 0 ? "bases-cards-property mod-title" : "bases-cards-property";
      property.setAttribute("data-column", column.key);
      if (column.kind === "formula") property.setAttribute("data-column-kind", "formula");
      const label = doc.createElement("div");
      label.className = "bases-cards-label";
      // Same ƒ marker as the table header: a computed column is visible in every
      // layout, and the marker is text so no sprite symbol / asset is added.
      label.textContent = `${column.kind === "formula" ? "ƒ " : ""}${column.label ?? column.key ?? ""}`;
      const line = doc.createElement("div");
      line.className = "bases-cards-line";
      line.appendChild(valueNode(row, column, columnIndex));
      property.appendChild(label);
      property.appendChild(line);
      card.appendChild(property);
    });
    return card;
  }

  function buildCards(state, columns, options, host) {
    const container = doc.createElement("div");
    container.className = "bases-cards-container";
    container.setAttribute("role", "list");
    container.setAttribute("data-base-cards", "");
    container.setAttribute("data-card-size", String(options.cardSize));
    container.setAttribute("data-image-fit", options.imageFit === IMAGE_FIT_CONTAIN ? "contain" : "cover");
    container.setAttribute("data-image-aspect-ratio", String(options.imageAspectRatio));
    if (options.imageProperty) container.setAttribute("data-image-property", options.imageProperty);
    container.style.setProperty("--base-card-size", `${options.cardSize}px`);
    const page = groupPage(state);
    if (!page) {
      state.rows.forEach((row, index) => container.appendChild(createCardItem(row, columns, index, options)));
      return wrap("base-cards-wrap", container, host);
    }
    // Grouped cards, desktop shape (app.js@3154320): the heading and the `bases-cards-group`
    // box are SIBLINGS inside the container, and the folded class goes on the box alone. The
    // container stops being one grid (a heading cannot be a card) and each group box becomes
    // the grid, which is the same thing the desktop's per-group box does.
    container.setAttribute("data-base-group-by", page.groupBy.property);
    container.setAttribute("data-base-group-direction", page.groupBy.direction);
    container.removeAttribute("role");
    let index = 0;
    for (const bucket of page.buckets) {
      const group = doc.createElement("div");
      group.className = "bases-cards-group";
      group.setAttribute("role", "list");
      for (const row of bucket.rows) group.appendChild(createCardItem(row, columns, index++, options));
      const heading = groupHeading(page, bucket, group);
      container.appendChild(heading);
      container.appendChild(group);
    }
    page.floating.forEach((row) => container.appendChild(createCardItem(row, columns, index++, options)));
    return wrap("base-cards-wrap", container, host);
  }

  return { buildList, buildCards, createListItem, createCardItem };
}
