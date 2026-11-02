// Prototype-parity gate — the paint criteria.
//
// Three layers, deliberately:
//   1. **Verbatim**: the served `PROTO_CSS` must still be byte-identical to the prototype's
//      `<style>` block. `docs/admin/README.md` marks that file as generated and never hand-edited;
//      this layer is what makes "the design system is the prototype's" a machine fact.
//   2. **Declarations** (`paintFindings`): the tokens exist in both theme blocks, `.bar` is 52px
//      through `--hh`, `.btn.primary` paints `var(--accent)`, `.tw` keeps its 1px border. Deleting
//      a declaration fails here even if a measurement happens to survive.
//   3. **Resolved paint** (`paintBrowserFailures`): the served page actually *paints* — the tokens
//      resolve to a non-empty value, the bar measures 52px, a visible primary button has an opaque
//      background and the table card has a painted border. This is the RETURN-1 class: a
//      stylesheet whose `:root{` wrapper is broken stays geometrically intact and paints nothing.

const THEME_SELECTORS = ["[data-theme=dark]", "[data-theme=light]"];

/** The prototype stylesheet, exactly as `scratch/admin-parity/gen-proto-css.mjs` extracts it. */
export function extractPrototypeCss(headHtml) {
  const start = headHtml.indexOf("<style>");
  if (start < 0) throw new Error("prototype head has no <style> block");
  let css = headHtml.slice(start + "<style>".length);
  if (css.includes("</style>")) css = css.slice(0, css.indexOf("</style>"));
  return css.replace(/\s+$/, "");
}

/** The CSS actually served by `app/src/admin/assets/proto-css.js` (a `String.raw` template). */
export function extractServedCss(moduleSource) {
  const marker = "String.raw`";
  const start = moduleSource.indexOf(marker);
  if (start < 0) throw new Error("proto-css.js does not export a String.raw template");
  const end = moduleSource.lastIndexOf("`;");
  if (end < start) throw new Error("proto-css.js template is not terminated");
  return moduleSource.slice(start + marker.length, end);
}

/**
 * Minimal rule reader: `selector{decls}` pairs, including rules nested in `@media` (the prototype's
 * responsive block). Not a full CSS parser — it reads exactly what these criteria need, and it
 * cannot silently drop a top-level rule (a nested block's body never contains `{`).
 */
export function parseRules(css) {
  const rules = new Map();
  // Comments first: the prototype stylesheet opens with a banner comment, and a `/* … */` prefix
  // would otherwise become part of the first selector and hide the `:root` block.
  const source = String(css).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(",").map((part) => part.trim()).filter(Boolean);
    const declarations = new Map();
    for (const declaration of match[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
    for (const selector of selectors) {
      const existing = rules.get(selector) || new Map();
      for (const [property, value] of declarations) existing.set(property, value);
      rules.set(selector, existing);
    }
  }
  return rules;
}

const declarationOf = (rules, selector, property) => rules.get(selector)?.get(property) ?? null;
const declaresToken = (css, name) => new RegExp(`${name}\\s*:`).test(css);

/**
 * Declaration-level paint criteria. Returns `{ failures, evidence }`; every failure names the
 * declaration that is missing, so the reader can fix the CSS (or the prototype) directly.
 */
export function paintFindings(css, { barHeightPx = 52 } = {}) {
  const rules = parseRules(css);
  const failures = [];
  const evidence = { tokens: {}, declarations: {} };
  for (const selector of THEME_SELECTORS) {
    for (const token of ["--accent", "--bg", "--line"]) {
      const value = declarationOf(rules, selector, token);
      evidence.tokens[`${selector} ${token}`] = value;
      if (!value) failures.push(`${selector} 未声明 ${token}（token 缺失时该主题下整块 paint 会退化为透明/无边框）`);
    }
  }
  const hh = rules.get(":root")?.get("--hh") ?? null;
  evidence.declarations["--hh"] = hh;
  if (hh !== `${barHeightPx}px`) failures.push(`:root 的 --hh 必须是 ${barHeightPx}px，实际 ${JSON.stringify(hh)}`);
  const barHeight = declarationOf(rules, ".bar", "height");
  evidence.declarations[".bar height"] = barHeight;
  if (barHeight !== "var(--hh)") failures.push(`.bar 的 height 必须走 var(--hh)（页头高度契约），实际 ${JSON.stringify(barHeight)}`);
  const primary = declarationOf(rules, ".btn.primary", "background");
  evidence.declarations[".btn.primary background"] = primary;
  if (!primary || !/var\(--accent\)/.test(primary)) failures.push(`.btn.primary 的 background 必须是 var(--accent)（不透明主按钮），实际 ${JSON.stringify(primary)}`);
  const tw = declarationOf(rules, ".tw", "border");
  evidence.declarations[".tw border"] = tw;
  if (!tw || !/^1px solid var\(--line\)$/.test(tw)) failures.push(`.tw 必须保留 1px solid var(--line) 边框（表格卡片），实际 ${JSON.stringify(tw)}`);
  return { failures, evidence };
}

/**
 * Resolved-paint criteria against `probe.probePaint()` output: the served page paints. Every
 * measurement is compared against a fallback failure, so a missing element is a failure, not a
 * silently-skipped assertion.
 */
export function paintBrowserFailures(paint, { barHeightPx = 52, requirePrimary = 1 } = {}) {
  const failures = [];
  for (const [name, value] of Object.entries(paint.tokens || {})) {
    if (name === "--hh") continue;
    if (!value) failures.push(`${name} 在 documentElement 上解析为空字符串（:root 块没有生效）`);
  }
  if (paint.bodyBackground === "rgba(0, 0, 0, 0)") failures.push(`body 背景透明：--bg 没有 paint 到 body（实际 ${paint.bodyBackground}）`);
  if (paint.barHeight === null) failures.push("页面没有渲染 .bar 页头，无法验证 52px 页头高度");
  else if (Math.abs(paint.barHeight - barHeightPx) > 1) failures.push(`.bar 高度 ${paint.barHeight}px ≠ ${barHeightPx}px`);
  if (paint.brandHeight !== null && Math.abs(paint.brandHeight - barHeightPx) > 1) failures.push(`侧栏 .bar.brand 高度 ${paint.brandHeight}px ≠ ${barHeightPx}px`);
  const border = Number.parseFloat(paint.cardBorderTop ?? "0");
  if (!(border > 0)) failures.push(`.tw 表格卡片没有边框（border-top ${paint.cardBorderTop}）`);
  if (paint.cardBorderColor === "rgba(0, 0, 0, 0)") failures.push(".tw 表格卡片的边框颜色透明（--line 没有生效）");
  const visiblePrimary = (paint.primary || []).length;
  if (visiblePrimary < requirePrimary) failures.push(`可见的 .btn.primary 主按钮 ${visiblePrimary} 个（至少 ${requirePrimary} 个）`);
  for (const button of paint.primary || []) {
    if (button.background === "rgba(0, 0, 0, 0)" || button.background === "transparent") failures.push(`主按钮 ${JSON.stringify(button.text)} 背景透明`);
    if (button.color === button.background) failures.push(`主按钮 ${JSON.stringify(button.text)} 前景与背景同色 ${button.background}`);
  }
  if (!paint.declaredRules?.bar) failures.push("服务端样式表里找不到 .bar 的 height 声明");
  if (!paint.declaredRules?.primary) failures.push("服务端样式表里找不到 .btn.primary 的 background 声明");
  if (!paint.declaredRules?.tw) failures.push("服务端样式表里找不到 .tw 的边框声明");
  return failures;
}

/** True when the served stylesheet is byte-identical to the prototype's `<style>` block. */
export function verbatimCssFailures({ prototypeCss, servedCss }) {
  if (prototypeCss === servedCss) return [];
  let index = 0;
  while (index < Math.min(prototypeCss.length, servedCss.length) && prototypeCss[index] === servedCss[index]) index += 1;
  return [
    `app/src/admin/assets/proto-css.js 不再是原型样式表的逐字副本（原型 ${prototypeCss.length} 字节，服务端 ${servedCss.length} 字节；首个差异在第 ${index} 字节：原型 ${JSON.stringify(prototypeCss.slice(index, index + 60))} vs 服务端 ${JSON.stringify(servedCss.slice(index, index + 60))}）`,
  ];
}

export { declaresToken };
