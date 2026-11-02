// Page-side geometry collector for the Phase 1-B shared geometry gate.
//
// `collectGeometry` is serialized into the page by `page.evaluate`, so it is
// self-contained: it takes the surface plus adjacency/table/token specs as
// arguments and touches nothing from module scope. It measures exactly ONE
// surface per call, because the inactive host is still in the DOM with
// `display:none` and would report all-zero rectangles.
//
// Measurement definition (identical for both hosts):
//   visibleBottom(heading) = border-box bottom - padding-bottom - border-bottom
//   visibleTop(heading)    = border-box top    + padding-top    + border-top-width
//   after  gap = target.rect.top    - visibleBottom(heading)
//   before gap = visibleTop(heading) - target.rect.bottom
// A heading owns its spacing: Reader carries it as a block margin (outside the
// border box), Live as measurable line padding (inside it). Excluding only the
// heading's own carrier padding/border yields the same "visible gap" on both
// hosts, while the target's own internal padding (a code card's 13px, a quote's
// .1em) stays out of the gap. The probe never assumes Reader == Live: both are
// compared to the token the theme declared.

export function collectGeometry({ surface, adjs, tables, tokens }) {
  const root = surface === "reader" ? document.querySelector("#preview") || document.body : document.querySelector(".cm-content") || document.body;
  const deepestWithText = (scope, needle) => {
    if (!scope || !needle) return null;
    let best = null;
    const walk = (element) => {
      if (!(element.textContent || "").includes(needle)) return;
      best = element;
      for (const child of element.children) walk(child);
    };
    walk(scope);
    return best;
  };
  const lineWithText = (scope, needle, filter) => {
    if (!scope || !needle) return null;
    for (const line of scope.querySelectorAll(".cm-line")) {
      if (!(line.textContent || "").includes(needle)) continue;
      if (filter && !line.matches(filter)) continue;
      return line;
    }
    return null;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  };
  const headingEdges = (el) => {
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      visibleTop: r.top + (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.borderTopWidth) || 0),
      visibleBottom: r.bottom - (Number.parseFloat(style.paddingBottom) || 0) - (Number.parseFloat(style.borderBottomWidth) || 0),
      rect: rectOf(el),
      paddingTop: Number.parseFloat(style.paddingTop) || 0,
      paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
    };
  };
  const readerElement = (spec) => {
    const found = deepestWithText(root, spec.needle);
    if (!found) return null;
    return spec.climb ? found.closest(spec.climb) || found : found;
  };
  const liveTargetElement = (spec) => {
    if (spec.kind === "table") {
      for (const candidate of root.querySelectorAll(".cm-table-widget")) {
        if ((candidate.textContent || "").includes(spec.needle)) return candidate;
      }
      return root.querySelector(".cm-table-widget");
    }
    if (spec.kind === "code") {
      // Live renders one fenced code block as several CodeMirror lines (opening
      // fence/lang line, body lines, closing fence line). The block's OUTER edge
      // is the first/last of those lines, not the body line, so the measured gap
      // excludes the code card's own internal top/bottom chrome — exactly what
      // Reader's single <pre> border box reports.
      const body = lineWithText(root, spec.needle);
      if (!body) return null;
      const isCodeLine = (el) =>
        Boolean(el?.classList) &&
        ["cm-live-code-lang-line", "cm-live-code-fence-line", "cm-live-code-body", "cm-live-code-start", "cm-live-code-end", "cm-live-code-indented"].some(
          (name) => el.classList.contains(name),
        );
      if (spec.direction === "after") {
        let el = body;
        while (isCodeLine(el.previousElementSibling)) el = el.previousElementSibling;
        return el;
      }
      let el = body;
      while (isCodeLine(el.nextElementSibling)) el = el.nextElementSibling;
      return el;
    }
    return lineWithText(root, spec.needle);
  };
  const gaps = {};
  for (const adj of adjs) {
    const headingSpec = surface === "reader" ? adj.readerHeading : adj.liveHeading;
    const targetSpec = surface === "reader" ? adj.readerTarget : adj.liveTarget;
    const headingEl = surface === "reader" ? readerElement(headingSpec) : lineWithText(root, headingSpec.needle, ".cm-line");
    const targetEl = surface === "reader" ? readerElement(targetSpec) : liveTargetElement({ ...targetSpec, direction: adj.direction });
    if (!headingEl || !targetEl) {
      gaps[adj.id] = { found: false, heading: Boolean(headingEl), target: Boolean(targetEl) };
      continue;
    }
    const h = headingEdges(headingEl);
    const t = rectOf(targetEl);
    gaps[adj.id] = {
      found: true,
      direction: adj.direction,
      visibleGap: adj.direction === "after" ? t.top - h.visibleBottom : h.visibleTop - t.bottom,
      outerGap: adj.direction === "after" ? t.top - h.rect.bottom : h.rect.top - t.bottom,
      headingTag: headingEl.tagName.toLowerCase(),
      headingMarginTop: h.marginTop,
      headingMarginBottom: h.marginBottom,
      headingPaddingTop: h.paddingTop,
      headingPaddingBottom: h.paddingBottom,
      headingText: (headingEl.textContent || "").slice(0, 48),
      targetText: (targetEl.textContent || "").slice(0, 48),
    };
  }
  const tableResults = {};
  for (const spec of tables) {
    const cell = deepestWithText(root, spec.needle);
    const table = cell?.closest("table") || null;
    const wrapper = table
      ? surface === "reader"
        ? table.closest(".table-scroll") || table.parentElement
        : table.closest(".cm-table-viewport") || table.closest(".cm-table-widget") || table.parentElement
      : null;
    if (!table || !wrapper) {
      tableResults[spec.id] = { found: false, table: Boolean(table), wrapper: Boolean(wrapper) };
      continue;
    }
    const tableStyle = getComputedStyle(table);
    const allocatorRaw = tableStyle.getPropertyValue("--table-layout-width").trim();
    const tableRect = table.getBoundingClientRect();
    tableResults[spec.id] = {
      found: true,
      wrapperClass: wrapper.className,
      overflowAttr: (wrapper.dataset.tableOverflow || table.dataset.tableOverflow || "false") === "true",
      allocatorWidth: Number.parseFloat(allocatorRaw) || 0,
      allocatorRaw,
      boxSizing: tableStyle.boxSizing,
      overflowX: getComputedStyle(wrapper).overflowX,
      tableWidth: tableRect.width,
      tableRect: { left: tableRect.left, right: tableRect.right, width: tableRect.width },
      wrapperClientWidth: wrapper.clientWidth,
      wrapperScrollWidth: wrapper.scrollWidth,
      wrapperWidth: wrapper.getBoundingClientRect().width,
    };
  }
  const tokenValues = {};
  const rootStyle = getComputedStyle(document.documentElement);
  for (const name of tokens) tokenValues[name] = rootStyle.getPropertyValue(name).trim();
  return { surface, gaps, tables: tableResults, tokens: tokenValues };
}
