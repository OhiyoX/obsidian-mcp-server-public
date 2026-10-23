// Prototype-parity gate — the in-browser extraction probes.
//
// ONE implementation, run against both trees (the prototype at `docs/admin-ui-proto/index.html`
// and the live Admin pages), so the comparison is symmetric by construction: the same function
// reads columns, required elements, drawer inventory and geometry, and the comparator only has to
// diff two objects of the same shape.
//
// These functions are serialized with `Function.prototype.toString` and evaluated in the page, so
// they must be self-contained (no module-scope references, no imports).

/**
 * Read one page into the comparable shape. `options.selectors` is `spec.ELEMENT_CANDIDATES` and
 * `options.dataChoiceFields` is `spec.DATA_CHOICE_FIELDS` (the drawer form fields whose option
 * values belong to the deployment — the Vault registry ids — and are therefore recorded separately
 * from the prototype's choice vocabulary).
 * Scopes: `.main` is the page proper; `aside.drawer.on` is the `?id=` detail drawer (present in
 * both trees); the sidebar/mobile nav are read separately so the shell is not confused with the
 * page body.
 */
export function probePage(options) {
  const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  // Chinese/visible-label key: the prototype's labels carry an ASCII key as a sub-label
  // (`远端名称 remote`, `权限上限与 Vault`), and the SSR forms may render the key in a `<small>`
  // or a `.sub`. Dropping the ASCII tokens compares "which field is this", not how the key is
  // decorated — the field inventory is the contract, the decoration is not.
  const key = (value) => norm(value)
    .replace(/[A-Za-z0-9_.:·•|/\\–—-]+/g, " ")
    .replace(/\s+/g, "")
    .trim();
  const uniq = (values) => [...new Set(values)];
  const text = (element) => norm(element?.textContent);
  const main = document.querySelector(".main") || document.body;
  const drawer = document.querySelector("aside.drawer.on");
  const roots = [main, drawer].filter(Boolean);
  const collect = (selector) => uniq(roots.flatMap((root) => [...root.querySelectorAll(selector)]));

  // Line count = number of line boxes the element's **own text** occupies.
  //
  // Two measurements were wrong here and both are fixed by counting lines, not rects:
  //   * Chromium reports an `text-overflow:ellipsis`-truncated line as TWO rects (the untruncated
  //     run and the clipped run) with the same vertical band, so one line counted as two;
  //   * an `inline-flex` container (the prototype's `.cap` = `.dot` + text) reports one rect per
  //     child on the SAME line, so a single-line chip counted as two as well.
  // Only text nodes contribute, so a decorative `<span class="dot">` can no longer invent a line,
  // and two rects in the same vertical band are one line (see `admin-layout-midword.mjs`, which
  // counts the same way).
  const lineBoxesOf = (element) => {
    const bands = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!String(node.textContent || '').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0.5 || rect.height <= 0.5) continue;
        if (bands.some((band) => Math.abs(band.top - rect.top) < 1 && Math.abs(band.bottom - rect.bottom) < 1)) continue;
        bands.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    return Math.max(bands.length, element.getClientRects().length > 0 ? 1 : 0);
  };
  // A subtree the browser is not rendering (a closed `<details>`, `content-visibility:hidden`)
  // still reports degenerate geometry — a hidden 11-character token measured as 10 lines earlier in
  // this lane — so nothing hidden is measured. The prototype only builds its equivalents on
  // interaction, so measuring them on one side only is an asymmetry, not evidence.
  const rendered = (element) => (typeof element.checkVisibility === 'function'
    ? element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })
    : element.getClientRects().length > 0);
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      background: style.backgroundColor,
      color: style.color,
      borderTopWidth: style.borderTopWidth,
      borderLeftWidth: style.borderLeftWidth,
    };
  };

  const tables = collect("table.tbl").map((table) => ({
    headers: [...table.querySelectorAll("thead th")].map(text),
    headerClasses: [...table.querySelectorAll("thead th")].map((th) => [...th.classList]),
    widths: [...table.querySelectorAll("colgroup col")].map((col) => col.style.width || col.getAttribute("width") || ""),
    rows: table.querySelectorAll("tbody tr").length,
    row1: [...(table.querySelector("tbody tr")?.children || [])].map((cell) => ({
      classes: [...cell.classList],
      width: Math.round(cell.getBoundingClientRect().width),
    })),
    classes: norm(table.className),
  }));

  const elements = {};
  for (const selector of options.selectors) {
    const matches = collect(selector);
    elements[selector] = { count: matches.length, sample: matches.length ? text(matches[0]).slice(0, 80) : "" };
  }

  const sideNav = [...document.querySelectorAll(".side .ni")];
  const nav = {
    labels: sideNav.map((item) => text(item.querySelector(".lbl") || item)),
    active: text(document.querySelector(".side .ni.on .lbl")),
    mnav: [...document.querySelectorAll(".mnav > a, .mnav .mmore > summary")].map(text),
  };

  // A "field" is a labelled control. Choice controls (checkbox/radio) contribute their value, not
  // their label: the prototype and the SSR table put the same token in different elements
  // (`.sub` in the prototype, the input's `value` in the plane), and the token is the contract.
  // `options.name` splits the deployment's own data (`spec.DATA_CHOICE_FIELD`) out of the contract
  // vocabulary: a Vault option's value is the deployment's registry id, not a product token.
  const fieldLabelsIn = (root) => uniq([...root.querySelectorAll("label")]
    .filter((label) => label.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea"))
    .map((label) => key(label.textContent))
    .filter(Boolean));
  const choiceTokensIn = (root, { fields = null }) => uniq([...root.querySelectorAll("input[type=checkbox], input[type=radio]")]
    .filter((input) => (fields === null ? true : fields.includes(String(input.name || ""))))
    .map((input) => {
      if (input.value) return input.value;
      return norm(input.closest("label")?.querySelector(".sub, small, .mono")?.textContent || "");
    })
    .filter(Boolean)).sort();

  const drawerInfo = drawer ? {
    sections: [...drawer.querySelectorAll(".dsec > h3")].map((heading) => key(heading.textContent)).filter(Boolean),
    kvKeys: [...drawer.querySelectorAll(".kv .k")].map((cell) => key(cell.textContent)).filter(Boolean),
    fieldLabels: fieldLabelsIn(drawer),
    choiceValues: choiceTokensIn(drawer, { fields: null }).filter((token) => !choiceTokensIn(drawer, { fields: options.dataChoiceFields }).includes(token)),
    vaultChoices: choiceTokensIn(drawer, { fields: options.dataChoiceFields }),
    headings: [...drawer.querySelectorAll("h1, h2, h3")].map(text),
  } : null;

  const content = document.querySelector(".main .content") || main;
  return {
    url: `${location.pathname}${location.search}${location.hash}`,
    title: document.title,
    h1: [...document.querySelectorAll(".main .bar h1")].map(text),
    h2: [...document.querySelectorAll(".main h2")].map(text),
    lede: [...document.querySelectorAll(".main .lede")].map(text),
    classes: [...new Set([...main.classList, ...[...document.querySelectorAll(".main *")].flatMap((node) => [...node.classList])])].sort(),
    tables,
    elements,
    nav,
    drawer: drawerInfo,
    overflow: { scrollWidth: content.scrollWidth, clientWidth: content.clientWidth },
    buttons: document.querySelectorAll(".main .btn, .main button.btn, .drawer .btn").length
      ? [...new Set([...document.querySelectorAll(".main .btn, .drawer .btn")])]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => ({ text: text(button).slice(0, 40), classes: norm(button.className), ...box(button) }))
      : [],
    chips: [...new Set([...document.querySelectorAll(".cap")])]
      .filter((chip) => rendered(chip))
      .map((chip) => ({ text: text(chip).slice(0, 60), classes: norm(chip.className), lines: lineBoxesOf(chip), ...box(chip) })),
    hrefs: uniq([...document.querySelectorAll("a[href]")].map((anchor) => anchor.getAttribute("href"))).slice(0, 400),
    dataIds: uniq(collect("[data-id]").map((node) => node.dataset.id)).filter(Boolean),
  };
}

/**
 * Paint measurements for the RETURN-1 class of defect (a stylesheet whose `:root` block never
 * parses paints nothing while staying geometrically intact): resolved tokens, the 52px bar, an
 * opaque primary button and a bordered `.tw` card.
 */
export function probePaint() {
  const read = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const bar = document.querySelector(".main .bar") || document.querySelector(".bar");
  const brand = document.querySelector(".side .bar");
  const card = document.querySelector(".main .tw");
  const body = getComputedStyle(document.body);
  const primary = [...document.querySelectorAll(".main .btn.primary, .drawer .btn.primary")]
    .filter((button) => button.getClientRects().length > 0)
    .map((button) => {
      const style = getComputedStyle(button);
      return { text: String(button.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40), background: style.backgroundColor, color: style.color };
    });
  // Declaration-level evidence for the rules the criteria lean on, read from the served
  // stylesheet: deleting the rule must fail closed even when a measurement happens to hold.
  const declared = (selector, property) => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText) continue;
        if (!rule.selectorText.split(",").map((part) => part.trim()).includes(selector)) continue;
        if (rule.style?.[property]) return rule.style[property];
      }
    }
    return null;
  };
  return {
    tokens: { "--accent": read("--accent"), "--bg": read("--bg"), "--line": read("--line"), "--hh": read("--hh") },
    bodyBackground: body.backgroundColor,
    bodyColor: body.color,
    barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    brandHeight: brand ? Math.round(brand.getBoundingClientRect().height) : null,
    cardBorderTop: card ? getComputedStyle(card).borderTopWidth : null,
    cardBorderLeft: card ? getComputedStyle(card).borderLeftWidth : null,
    cardBorderColor: card ? getComputedStyle(card).borderTopColor : null,
    primary,
    declaredRules: {
      bar: declared(".bar", "height"),
      primary: declared(".btn.primary", "background"),
      tw: declared(".tw", "border"),
    },
  };
}

/**
 * Negative control: drop the given custom properties from every rule of every same-origin
 * stylesheet in the page, then re-read them. A probe that still reports a value is reading
 * something other than the served stylesheet (a hard-coded expectation), which is exactly the
 * failure mode this control exists to catch. Returns the values after removal.
 */
export function removeTokensProbe(names) {
  let removed = 0;
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!rule.style) continue;
      for (const name of names) {
        if (rule.style.getPropertyValue(name)) { rule.style.removeProperty(name); removed += 1; }
      }
    }
  }
  const read = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return { removed, values: Object.fromEntries(names.map((name) => [name, read(name)])) };
}

/**
 * No-JS context: the page must render its main content with scripting disabled. Reports the
 * structural marks (page bar, content region and a page body that is either a table card, a stat
 * grid, a form or an explicit empty state) plus the visible text length, so a page that only
 * appears after script runs is caught.
 */
export function probeNoJs() {
  const norm = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const main = document.querySelector(".main");
  const heading = document.querySelector(".main .bar h1");
  const content = document.querySelector(".main .content");
  const body = content || main;
  return {
    hasMain: Boolean(main),
    heading: norm(heading?.textContent),
    hasContent: Boolean(content),
    marks: {
      tw: document.querySelectorAll(".main .tw").length,
      stats: document.querySelectorAll(".main .stat").length,
      empty: document.querySelectorAll(".main .empty").length,
      form: document.querySelectorAll(".main form").length,
      drawer: document.querySelectorAll("aside.drawer.on").length,
      ped: document.querySelectorAll(".main .ped").length,
    },
    textLength: body ? norm(body.textContent).length : 0,
    text: body ? norm(body.textContent).slice(0, 160) : "",
    scripts: document.querySelectorAll("script").length,
  };
}

/** Node-side helper: evaluate one of the probes above in a page. */
export async function runProbe(page, fn, argument) {
  const call = argument === undefined
    ? `(${fn.toString()})()`
    : `(${fn.toString()})(${JSON.stringify(argument)})`;
  return page.evaluate(call);
}
