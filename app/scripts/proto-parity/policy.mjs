// Admin host policy — the frozen CSP (D0, 2026-10-18) and the script policy of the served HTML.
//
// Kept separate from the interaction probes on purpose: these are pure functions over a header string
// and a script inventory, so the unit test can assert them without a browser, and the gate asserts the
// *served* value (never a copy kept in the test).
export const CSP_HEADER = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Where the enhancement modules are served from, and which names may be requested. */
export const CLIENT_SCRIPT_BASE = "/admin/auth/assets/";
export const ADMIN_CLIENT_MODULES = Object.freeze(["admin-client.js", "admin-feature-registry.js", "admin-feature-overlays.js", "admin-feature-keys.js", "admin-feature-lists.js", "admin-feature-select.js", "admin-feature-nav.js"]);
/** The one module an authenticated page is expected to load (feature modules arrive via import). */
export const CLIENT_ENTRY_MODULE = "admin-client.js";

/* ------------------------------------------------------------------ HTTP-level policy */

/** Parse a CSP header into `{ directive: [values] }`. */
export function parseCsp(header) {
  const directives = {};
  for (const part of String(header ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    directives[name.toLowerCase()] = values;
  }
  return directives;
}

/** Response-header assertions: the frozen string, plus the properties that string encodes. */
export function cspFailures(header) {
  const raw = String(header ?? "");
  const failures = [];
  if (!raw) return ["缺少 Content-Security-Policy 响应头"];
  const normalized = raw.trim().replace(/\s*;\s*$/, "").replace(/\s+/g, " ");
  if (normalized !== CSP_HEADER) {
    failures.push(`CSP 头与 D0 冻结值不一致：\n    实际 ${normalized}\n    期望 ${CSP_HEADER}`);
  }
  const directives = parseCsp(raw);
  const script = directives["script-src"] ?? [];
  if (!script.some((value) => value.toLowerCase() === "'self'")) failures.push(`script-src 必须含 'self'：${JSON.stringify(script)}`);
  for (const banned of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", "*", "http:", "https:", "data:", "blob:", "'none'"]) {
    if (script.some((value) => value.toLowerCase() === banned)) failures.push(`script-src 不得含 ${banned}（D0 只允许同源脚本）`);
  }
  for (const value of script) {
    if (value.startsWith("'")) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)) failures.push(`script-src 不得含第三方源 ${value}`);
  }
  if ((directives["default-src"] ?? []).join(" ") !== "'none'") failures.push(`default-src 必须是 'none'：${JSON.stringify(directives["default-src"] ?? [])}`);
  if (!(directives["base-uri"] ?? []).includes("'none'")) failures.push(`base-uri 必须含 'none'：${JSON.stringify(directives["base-uri"] ?? [])}`);
  if (!(directives["frame-ancestors"] ?? []).includes("'none'")) failures.push(`frame-ancestors 必须含 'none'：${JSON.stringify(directives["frame-ancestors"] ?? [])}`);
  for (const value of directives["form-action"] ?? []) {
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) && !value.startsWith("'")) failures.push(`form-action 不得指向外部源：${value}`);
  }
  // `connect-src` is *the* directive the enhancement's same-origin `fetch` needs (`fetchFragment`);
  // without it the fetch falls back to `default-src 'none'` and every drawer / menu / live-preview
  // fragment request is blocked, so its absence is a failure, not a note (decided 2026-10-18).
  const connect = directives["connect-src"] ?? null;
  if (!connect) failures.push("connect-src 必须声明 'self'（缺省会回落 default-src 'none'，同源片段 fetch 全被拦）");
  else if (!connect.some((value) => value.toLowerCase() === "'self'")) failures.push(`connect-src 必须含 'self'：${JSON.stringify(connect)}`);
  return failures;
}

/** Is a same-origin `fetch()` (the fragment path) permitted by this policy? `connect-src` falls back. */
export function fragmentFetchPermitted(header) {
  const directives = parseCsp(header);
  const connect = directives["connect-src"] ?? directives["default-src"] ?? [];
  return connect.some((value) => value.toLowerCase() === "'self'");
}

/**
 * The served HTML's script policy. `inventory` is `probeDocumentPolicy()`'s shape.
 *   * every `<script>` must be an external same-origin `type="module"` from the whitelist;
 *   * authenticated pages load exactly one tag — the entry module (features arrive by import);
 *   * login/error pages load none;
 *   * no `on*=` attribute and no `javascript:` URL anywhere in the markup.
 */
export function scriptInventoryFailures(inventory, { authenticated, modules = ADMIN_CLIENT_MODULES, entry = CLIENT_ENTRY_MODULE } = {}) {
  const failures = [];
  const scripts = inventory?.scripts ?? [];
  const inline = scripts.filter((script) => script.inline);
  if (inline.length) failures.push(`出现 ${inline.length} 个 inline <script>（${inline.map((script) => `${script.textLength} 字节`).join(", ")}）；CSP script-src 'self' 下 inline 一律不允许`);
  const external = scripts.filter((script) => !script.inline);
  for (const script of external) {
    if (script.type !== "module") failures.push(`<script src="${script.src}"> 不是 type="module"`);
    if (!script.sameOrigin) failures.push(`<script src="${script.src}"> 不是同源`);
    let name = null;
    try { const url = new URL(script.src, "https://admin.invalid"); name = url.pathname.startsWith(CLIENT_SCRIPT_BASE) ? url.pathname.slice(CLIENT_SCRIPT_BASE.length) : null; } catch { name = null; }
    if (!name || !modules.includes(name)) failures.push(`<script src="${script.src}"> 不在白名单 ${CLIENT_SCRIPT_BASE}<${modules.join("|")}>`);
  }
  if (authenticated) {
    if (external.length === 0) failures.push(`已认证页面没有加载同源增强脚本（期望 1 个 ${CLIENT_SCRIPT_BASE}${entry}）`);
    const others = external.map((script) => String(script.src).slice(String(script.src).lastIndexOf("/") + 1)).filter((name) => name !== entry);
    if (others.length) failures.push(`已认证页面除入口模块外还声明了 script 标签：${others.join(", ")}（feature 模块应由 import 引入，而不是多一个标签）`);
  } else if (scripts.length) {
    failures.push(`未认证页面（登录 / 错误页）不得加载任何 <script>，实际 ${scripts.length} 个`);
  }
  if ((inventory?.inlineHandlers ?? []).length) failures.push(`HTML 里出现 ${inventory.inlineHandlers.length} 个 inline handler：${inventory.inlineHandlers.slice(0, 5).join(", ")}`);
  if ((inventory?.javascriptUrls ?? []).length) failures.push(`HTML 里出现 javascript: URL：${inventory.javascriptUrls.slice(0, 5).join(", ")}`);
  if (inventory?.cspMeta) failures.push('HTML 里出现 <meta http-equiv="Content-Security-Policy">：策略必须只来自响应头（meta 可被页面自身改写）');
  return failures;
}
