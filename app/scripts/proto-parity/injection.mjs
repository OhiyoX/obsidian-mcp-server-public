// Admin injection gate — the payloads, the in-page injection-surface probe and the client source
// audit. Authority: the lane brief's hard rule 1 (a value that came from data is written with
// `textContent`, never through an HTML sink) and the D0 CSP (`script-src 'self'` also blocks inline
// handlers, so "it did not execute" alone would not prove the renderer is safe — the DOM must not
// contain the node or the attribute in the first place).
/**
 * Injection surface for one page: executable nodes, `on*=` attributes, `javascript:` URLs and the
 * window flags a payload would set if it ever executed. `payloads` is the list written into real
 * data fields; `mustBeVisible` says the value has to reach the DOM as *text* (otherwise the probe
 * proves nothing about the renderer).
 */
export function probeInjectionSurface(payloads) {
  const list = payloads || [];
  const text = String(document.body.textContent || "");
  const inlineHandlers = [];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...(element.attributes || [])]) {
      if (/^on/i.test(attribute.name)) inlineHandlers.push(`${element.tagName.toLowerCase()}[${attribute.name}]`);
    }
  }
  const javascriptUrls = [];
  for (const element of document.querySelectorAll("[href],[src],[action],[formaction]")) {
    for (const name of ["href", "src", "action", "formaction"]) {
      const value = element.getAttribute?.(name);
      if (value && /^\s*(?:javascript|vbscript):/i.test(value)) javascriptUrls.push(`${element.tagName.toLowerCase()}[${name}]=${value.slice(0, 60)}`);
    }
  }
  return {
    url: `${location.pathname}${location.search}`,
    scriptSources: [...document.querySelectorAll("script")].map((node) => node.src || "(inline)"),
    // An injected payload that produced a `<script>` element is exactly the failure this probe
    // exists for; the element is *counted* as well as listed, so a payload that the CSP would have
    // blocked is still reported as "the renderer let the markup through".
    inlineScripts: [...document.querySelectorAll("script")].filter((node) => !node.getAttribute("src")).length,
    totalScripts: document.querySelectorAll("script").length,
    inlineHandlers,
    javascriptUrls,
    visible: list.map((payload) => ({ payload, asText: text.includes(payload) })),
    elementWithPayload: Boolean([...document.querySelectorAll("body *")].find((node) => list.some((payload) => [...node.attributes].some((attribute) => String(attribute.value).includes(payload))))),
    flags: {
      script: window.__xss_script === true,
      attributeBreakout: window.__xss_attr === true,
      svgOnload: window.__xss_svg === true,
      javascriptUrl: window.__xss_url === true,
      any: window.__xss_script === true || window.__xss_attr === true || window.__xss_svg === true || window.__xss_url === true,
    },
    violations: (window.__adminInteraction?.violations ?? []).length,
  };
}

/* ------------------------------------------------------------------ client source audit */

/**
 * The payloads the injection probe writes into real data fields (one distinct window flag each, so
 * "it executed" is distinguishable from "it was blocked"). Authority for the rule they test: the
 * lane brief's hard rule 1 — a value that came from data is written with `textContent`, never
 * through an HTML sink.
 */
export const XSS_PAYLOADS = Object.freeze({
  accountDisplayName: `<script>window.__xss_script=1</script>`,
  keyLabel: `"><img src=x onerror="window.__xss_attr=1">`,
  policyLabel: `<svg onload="window.__xss_svg=1">`,
  auditUserAgent: `javascript:window.__xss_url=1`,
});

/**
 * Static audit of the served client sources: HTML sinks are how untrusted data becomes executable.
 * Comments are stripped first (this repository's client files discuss `innerHTML` in prose — the
 * brief itself does), then every sink is reported with its line. `innerHTML = ""` (clearing) is the
 * one allowed assignment shape.
 */
export function clientSinkFailures(sources) {
  const rules = [
    {
      id: "innerHTML-assignment",
      hint: "用 textContent 写值（只允许 innerHTML = \"\" 这种清空）",
      test: (line) => {
        const match = /\.innerHTML\s*=\s*(.*)$/.exec(line);
        if (!match) return false;
        const right = match[1].trim().replace(/;\s*$/, "").trim();
        return !/^(?:""|''|``)$/.test(right);
      },
    },
    { id: "outerHTML-assignment", hint: "不要替换整个元素", test: (line) => /\.outerHTML\s*=/.test(line) },
    { id: "insertAdjacentHTML", hint: "用 DOM API + textContent", test: (line) => /insertAdjacentHTML\s*\(/.test(line) },
    { id: "document.write", hint: "document.write 会重写文档", test: (line) => /document\.write(?:ln)?\s*\(/.test(line) },
    { id: "eval", hint: "eval 在 CSP 下不允许，且是注入面", test: (line) => /(?:^|[^\w.$])eval\s*\(/.test(line) },
    { id: "new-Function", hint: "动态函数构造与 eval 同类", test: (line) => /new\s+Function\s*\(/.test(line) },
    { id: "string-timer", hint: "定时器只接受函数，不接受字符串", test: (line) => /set(?:Timeout|Interval)\s*\(\s*[`'"]/.test(line) },
    { id: "on-attribute", hint: "不要写 on* 属性", test: (line) => /\.setAttribute\s*\(\s*[`'"]on/i.test(line) },
  ];
  const failures = [];
  for (const [name, raw] of Object.entries(sources ?? {})) {
    const lines = String(raw)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .split(/\r?\n/);
    for (const rule of rules) {
      lines.forEach((line, index) => {
        if (rule.test(line)) failures.push(`[${name}:${index + 1}] ${rule.id} — ${rule.hint}：${line.trim().slice(0, 90)}`);
      });
    }
  }
  return failures;
}
