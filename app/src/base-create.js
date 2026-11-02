// P1 (#630) — `base:create` semantics: create an entry *the way the view wants
// it*, then prove it can be found again.
//
// Desktop authority (static asar read, `evidence/asar/obsidian_app.js`, Obsidian
// resource `obsidian.asar` app.js sha256 8efbf581e259cabef4f9c9a34814cfe3c02863
// 77377e56b3603933c50e89898 — see HANDOFF.md for the offsets):
//
//   * CLI `base:create` `@3158532`:
//       l = query.getViewConfig(view); c = wQ(app, query, l)
//       u = query.newItemFolder || c.folder
//       if ("" === u && baseFile) u = fileManager.getNewFileParent(baseFile.path).path
//       p = name || "Untitled"; f = vault.getAvailablePath(<folder>/<p>, "md")
//       vault.create(f, content); if (frontmatter non-empty) processFrontMatter(created, e => {for k in h e[k] = h[k]})
//       returns "Created: <path>"
//   * the derivation function itself `wQ(e,t,n,i)` `@2329857` — NEW ITEM DEFAULTS
//     COME FROM THE VIEW'S EFFECTIVE FILTERS (global AND view) AND THE VIEW'S
//     SORT/ORDER KEYS, not from a fixed schema:
//       - `file.folder == X` / `file.inFolder(X)`            -> target folder
//       - `note.<prop> ==|>=|<= <literal>`                   -> `<prop>: <literal>`
//       - `note.<prop>.isEmpty()`                            -> `<prop>: ""`
//       - `note.<prop>.startsWith|endsWith|contains|containsAll(|containsAny)(x)` -> `<prop>: x`
//       - `file.hasTag(x)`                                   -> `tags: [x]`
//       - `file.hasProperty(x)`                              -> `x: null`
//       - every view `order` key not set above               -> `<key>: null`
//       - negated rules and `or` groups contribute nothing (they are not
//         "satisfiable by construction"); the two `try/catch` blocks around the
//         comparisons swallow an unevaluable right-hand side.
//   * base document model `@2319740`: the top-level `.base` keys are
//     `views/filters/display/properties/formulas/summaries/newItemFolder/newItemTemplate`
//     — `newItemFolder` and `newItemTemplate` are **strings** on the document,
//     not on the view (`msgErrorMustBeAType({key:"newItemFolder",type:"string"})`).
//   * the UI "New item" button (`labelNewItem` `@2453882`, i.e. `labelNewItem:"New"`
//     in `i18n.js` @114386; `labelNewItemTemplateFile:"New item template file"`
//     @114444, `labelNewItemFolder:"New item folder"` @114494) `@2454600`:
//     a declared `newItemTemplate` (vault-relative path) note contributes its PARENT
//     FOLDER (as the folder fallback, only when `newItemFolder` is empty) and its
//     FRONTMATTER (as the created note's frontmatter, REPLACING the filter-derived
//     defaults, and suppressing them entirely: `u||(s=wQ(...).frontmatter)`). Its
//     BODY is not copied — `createNewFile(folder, <editor content>)`. The CLI path
//     does not read the template at all, a divergence recorded in HANDOFF.md; the
//     MCP face implements the UI path, because that is the behaviour a user sees.
//
// This module is PURE: no fs, no path, no MCP, no Vault state. It derives the
// entry plan (folder + frontmatter) from a parsed `.base` and DECIDES whether the
// planned record would be found by the very same evaluator `query_base` uses —
// the decision only, never the I/O.

import { BaseQueryError, compileBaseView, evaluateBaseView } from "./base-query.js";
import { parseBaseExpression } from "./base-expression.js";

export const BASE_CREATE_ERROR_CODES = Object.freeze({
  EXISTS: "entry-exists",
  NOT_QUERYABLE: "entry-not-queryable",
  PATH_INVALID: "entry-path-invalid",
});

export const BASE_CREATE_WARNING_CODES = Object.freeze({
  INCONCLUSIVE: "query-precheck-inconclusive",
  TEMPLATE_UNRESOLVED: "newitemtemplate-unresolved",
});

export class BaseCreateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BaseCreateError";
    this.code = code;
    this.details = details;
  }
}

// The default entry name, verbatim from the desktop CLI (`t.name || "Untitled"`).
export const DEFAULT_NEW_ITEM_NAME = "Untitled";

const FILTER_CONJUNCTIONS = ["and", "or", "not"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function barePropertyKey(key) {
  const text = String(key ?? "");
  if (text.startsWith("note.")) return text.slice("note.".length);
  return text;
}

function propertyNamespace(key) {
  const text = String(key ?? "");
  if (text.startsWith("file.")) return "file";
  if (text.startsWith("formula.")) return "formula";
  return "note";
}

function literalOf(node) {
  return isPlainObject(node) && node.type === "literal" ? node.value : undefined;
}

// The text grammar `src/workflows.js` `evaluateBaseExpression` — the function the
// evaluator routes a string filter leaf to — matches with its own regexes. Its
// record-operand forms are NOT part of the typed portable subset, so
// `parseBaseExpression` rejects them; the defaults must still follow them, because
// they are what the view will actually match against. Only the forms that can
// contribute a default are listed: a `file.hasLink(...)` leaf matches no rule here
// and stays `unreadable`.
const DESKTOP_CALL_RULES = Object.freeze([
  { kind: "folder", pattern: /^file\.inFolder\(\s*(["'])(.*?)\1\s*\)$/ },
  { kind: "tag", pattern: /^file\.hasTag\(\s*(["'])(.*?)\1\s*\)$/ },
  { kind: "empty", pattern: /^([\w.-]+)\.isEmpty\(\s*\)$/ },
  { kind: "text", pattern: /^([\w.-]+)\.(startsWith|endsWith|contains|containsAll|containsAny)\(\s*(["'])(.*?)\3(?:\s*,.*)?\)$/ },
]);

function readDesktopCallRule(source) {
  const text = String(source).trim();
  for (const { kind, pattern } of DESKTOP_CALL_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (kind === "folder") return { kind, value: match[2] };
    if (kind === "tag") return { kind, value: match[2].replace(/^#/, "").toLowerCase() };
    if (kind === "empty") return { kind, namespace: propertyNamespace(match[1]), key: barePropertyKey(match[1]) };
    return { kind, namespace: propertyNamespace(match[1]), key: barePropertyKey(match[1]), value: match[4] };
  }
  return null;
}

// Normalized tag list for the synthetic record, mirroring the index contract
// (`base-query.js` record header: lower-cased, `#` stripped).
function normalizeRecordTags(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list
    .map((item) => String(item ?? "").trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean);
}

/**
 * The filter leaves `deriveEntryDefaults` could read, in the order desktop's
 * `wQ` reads them: the *optimized AND list* of (global filters AND view filters).
 * `or`/`not` subtrees and negated leaves are returned as `unreadable` instead of
 * being guessed at — desktop skips negated rules for the same reason.
 */
export function collectEntryDefaultRules(base, view) {
  const readable = [];
  const unreadable = [];
  const visit = (node, negated = false) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, negated));
      return;
    }
    if (typeof node === "string") {
      if (negated) {
        unreadable.push(node);
        return;
      }
      // Expression leaf. `query_base` accepts two dialects here, so both are read:
      // the typed portable subset (`parseBaseExpression`) and the desktop
      // record-operand grammar the evaluator matches textually.
      try {
        readable.push({ kind: "expression", ast: parseBaseExpression(node), source: node });
        return;
      } catch { /* not the typed subset: try the desktop grammar below */ }
      const desktop = readDesktopCallRule(node);
      if (desktop) readable.push({ kind: "desktop", desktop, source: node });
      else unreadable.push(node);
      return;
    }
    if (isPlainObject(node)) {
      const conjunction = FILTER_CONJUNCTIONS.find((key) => Array.isArray(node[key]));
      if (conjunction) {
        if (conjunction === "and") visit(node[conjunction], negated);
        else unreadable.push(node);
        return;
      }
      if (typeof node.key === "string") {
        if (negated) unreadable.push(node);
        else readable.push({ kind: "condition", condition: node });
        return;
      }
    }
    unreadable.push(node);
  };
  // Desktop optimizes [global, view] into ONE AND list (`new JX([...]).optimize()`).
  visit([base?.filters, view?.filters].filter(Boolean));
  return { readable, unreadable };
}

/**
 * Desktop `wQ` port (pure): the folder + frontmatter defaults a new entry needs
 * in order to satisfy the view's own filters, plus the property keys the view's
 * `order` projects (present-but-empty, exactly like desktop's `null` default).
 *
 * @returns {{folder: string, frontmatter: Record<string, unknown>, sources: string[], unreadable: unknown[]}}
 */
export function deriveEntryDefaults({ base, view } = {}) {
  const { readable, unreadable } = collectEntryDefaultRules(base, view);
  const frontmatter = {};
  const sources = [];
  let folder = "";
  const setOnce = (key, value, source) => {
    if (Object.hasOwn(frontmatter, key)) return;
    frontmatter[key] = value;
    sources.push(source);
  };

  const fromComparison = (left, operator, right, source) => {
    if (!["==", ">=", "<="].includes(operator)) return;
    if (!isPlainObject(left) || left.type !== "reference") return;
    const namespace = propertyNamespace(left.name);
    const key = left.explicit === false && namespace === "note" ? left.name : barePropertyKey(left.name);
    const value = literalOf(right);
    if (value === undefined) return;
    if (namespace === "file") {
      // `file.folder == "X"` is the only folder-producing comparison desktop reads.
      if (key === "folder" && operator === "==" && typeof value === "string" && !folder) {
        folder = value;
        sources.push(source);
      }
      return;
    }
    if (namespace === "note") setOnce(key, value, source);
  };

  for (const rule of readable) {
    if (rule.kind === "condition") {
      const { key, op, value } = rule.condition;
      const namespace = propertyNamespace(key);
      const bare = barePropertyKey(key);
      const source = `condition:${key} ${op}`;
      if (namespace === "file") {
        if ((op === "is" || op === "in-folder") && (bare === "folder" || bare === "path") && typeof value === "string" && !folder) {
          folder = op === "in-folder" ? value : bare === "folder" ? value : "";
          if (op === "in-folder") folder = value;
          sources.push(source);
        } else if (bare === "tags" && (op === "has-tag" || op === "is" || op === "contains")) {
          setOnce("tags", [String(value ?? "").replace(/^#/, "").toLowerCase()], source);
        }
        continue;
      }
      if (namespace === "formula") continue;
      switch (op) {
        case "is":
        case "gte":
        case "lte":
          setOnce(bare, value, source);
          break;
        case "is-empty":
          setOnce(bare, "", source);
          break;
        case "contains":
        case "contains-any":
        case "contains-all":
        case "starts-with":
        case "ends-with":
          setOnce(bare, Array.isArray(value) ? value : value, source);
          break;
        case "has-tag":
          setOnce("tags", [String(value ?? "").replace(/^#/, "").toLowerCase()], source);
          break;
        case "has-property":
          setOnce(bare, null, source);
          break;
        default:
          break;
      }
      continue;
    }

    // Desktop function-call leaf (`file.inFolder("X")`, `file.hasTag("x")`,
    // `note.<prop>.isEmpty()`, `note.<prop>.contains("x")`, …).
    if (rule.kind === "desktop") {
      const source = `expression:${rule.source}`;
      const desktop = rule.desktop;
      if (desktop.kind === "folder") {
        if (!folder) {
          folder = desktop.value;
          sources.push(source);
        }
        continue;
      }
      if (desktop.kind === "tag") {
        setOnce("tags", [desktop.value], source);
        continue;
      }
      // `wQ` only reads `note.*` for the value-producing calls; a `file.*` one it
      // cannot read contributes nothing.
      if (desktop.namespace !== "note") continue;
      setOnce(desktop.key, desktop.kind === "empty" ? "" : desktop.value, source);
      continue;
    }

    // Expression leaf (`note.status == "todo"`, `file.folder == "Tasks"`,
    // `note.prop.isEmpty()`, `file.hasTag("x")`, ...).
    const ast = rule.ast;
    if (isPlainObject(ast) && ast.type === "comparison") {
      fromComparison(ast.left, ast.operator, ast.right, `expression:${rule.source}`);
      continue;
    }
    if (isPlainObject(ast) && ast.type === "call") {
      const namespace = propertyNamespace(ast.callee?.name);
      const key = barePropertyKey(ast.callee?.name);
      const value = literalOf(ast.arguments?.[0]);
      const source = `expression:${rule.source}`;
      if (namespace === "file") {
        if (key === "inFolder" && typeof value === "string" && !folder) {
          folder = value;
          sources.push(source);
        } else if (key === "hasTag" && typeof value === "string") {
          setOnce("tags", [value.replace(/^#/, "").toLowerCase()], source);
        } else if (key === "hasProperty" && typeof value === "string") {
          setOnce(value, null, source);
        }
        continue;
      }
      if (namespace === "note" && typeof value !== "undefined") {
        setOnce(key, value, source);
      }
      continue;
    }
    unreadable.push(rule.source);
  }

  // Desktop tail: every view order key that no rule produced is present-but-null.
  for (const key of Array.isArray(view?.order) ? view.order : []) {
    if (typeof key !== "string" || propertyNamespace(key) === "file") continue;
    const bare = barePropertyKey(key);
    if (propertyNamespace(key) === "formula") continue;
    setOnce(bare, null, `order:${key}`);
  }

  return { folder, frontmatter, sources, unreadable };
}

/**
 * Folder + vault-relative note path for the new entry, in desktop order:
 * `base.newItemFolder` -> template parent folder -> filter-derived folder ->
 * the `.base` file's own parent folder (desktop: `getNewFileParent(baseFile.path)`).
 *
 * `file` is the caller's explicit target and is resolved RELATIVE TO THE RESOLVED
 * FOLDER, exactly like the desktop CLI composes `d = u + p` from
 * `newItemFolder/filter folder` + `name`; omitted, the entry is `Untitled.md`
 * inside that folder (desktop `p = t.name || "Untitled"`). A name collision is
 * NOT auto-incremented here (desktop's `vault.getAvailablePath(path, "md")` walks
 * "Untitled 1.md" …): this face refuses instead, so the written path is never
 * guessed — see `BASE_CREATE_ERROR_CODES.EXISTS`.
 *
 * `view` is the COMPILED view object (`compileBaseView(base, name).view`), not a
 * view name: `deriveEntryDefaults` reads its `filters` and `order`.
 */
export function resolveEntryTarget({ base, view, template = null, baseFile = "", file } = {}) {
  const derived = deriveEntryDefaults({ base, view });
  const declared = typeof base?.newItemFolder === "string" ? base.newItemFolder : "";
  const templateFolder = template && typeof template.folder === "string" ? template.folder : "";
  const baseParent = String(baseFile).includes("/") ? String(baseFile).slice(0, String(baseFile).lastIndexOf("/")) : "";
  const folder = firstNonEmpty([declared, templateFolder, derived.folder, baseParent]);
  const explicit = typeof file === "string" && file.trim() ? file.trim() : `${DEFAULT_NEW_ITEM_NAME}.md`;
  // The caller's own `file` is validated before it is joined to the folder: an
  // absolute or traversing argument is refused instead of being silently retargeted
  // into the folder desktop would have prefixed.
  if (file !== undefined) assertRelativeEntryPath(explicit);
  const requested = `${folder ? `${folder}/` : ""}${explicit}`;
  const withExtension = /\.md$/i.test(requested) ? requested : `${requested}.md`;
  return {
    folder,
    path: assertRelativeEntryPath(withExtension),
    folderSource: declared ? "base.newItemFolder" : templateFolder ? "newItemTemplate.parent" : derived.folder ? "view-filters" : baseParent ? "base-file-parent" : "vault-root",
    derived,
  };
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : "";
    if (text) return text;
  }
  return "";
}

// Fail closed on a target the caller did not literally name. Only `..`-collapsing
// would keep every path inside the Vault (the runtime's `resolveVaultPath` confines
// lexically and `ensureVaultParent` re-checks the canonical parent), but it would
// also SILENTLY RETARGET the write ("Tasks/../../x.md" -> "x.md"), so a traversal
// segment is a refusal with its own code instead of a rewrite. `.` and empty
// segments (`a//b`) are harmless and collapse.
function assertRelativeEntryPath(relative) {
  const text = String(relative).replace(/\\/g, "/");
  const segments = text.split("/");
  const invalid = (reason) => new BaseCreateError(
    BASE_CREATE_ERROR_CODES.PATH_INVALID,
    `Invalid entry path "${relative}": ${reason}. Pass a Vault-relative path without traversal segments.`,
    { path: String(relative) },
  );
  if (!text.trim()) throw invalid("the path is empty");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text)) throw invalid("absolute paths are not accepted");
  if (segments.includes("..")) throw invalid("`..` traversal segments are not accepted");
  const parts = segments.filter((segment) => segment && segment !== ".");
  if (!parts.length) throw invalid("the path resolves to the Vault root");
  return parts.join("/");
}

/**
 * The production record shape `evaluateBaseView` reads (base-query.js header):
 * a synthetic row that is exactly what this note will look like once the Vault
 * index has picked it up — so the precheck and `query_base` cannot diverge.
 */
export function syntheticBaseRecord({ path, frontmatter }) {
  const basename = String(path).split("/").pop().replace(/\.md$/i, "");
  return {
    path,
    basename,
    frontmatter,
    tags: normalizeRecordTags(frontmatter?.tags),
    links: [],
    stat: { size: 0, created: new Date(0).toISOString(), modified: new Date(0).toISOString() },
  };
}

/**
 * The Issue #630 hard requirement, as a decision: the planned entry MUST be
 * findable by the view. The check runs the production evaluator
 * (`evaluateBaseView`) over one synthetic record built from the exact
 * frontmatter that is about to be written:
 *
 *   * the evaluator ran and did NOT return the row  -> REFUSE
 *     (`entry-not-queryable`): this is the invisible-row failure mode the tool
 *     exists to prevent, and nothing is written;
 *   * the evaluator refused the view configuration (a formula / grouping this
 *     query subset cannot compile) -> the answer is UNPROVEN, so the caller gets
 *     a `query-precheck-inconclusive` warning instead of a false assurance.
 *
 * @returns {string[]} warning codes (`BASE_CREATE_WARNING_CODES` values)
 */
export function assertEntryQueryable({ base, viewName, record, warnings = [] }) {
  let compiled;
  try {
    compiled = compileBaseView(base, viewName);
  } catch (error) {
    // An unknown view name is a caller error, not an unprovable view: refuse it
    // with the domain's own code so `query_base` and this tool agree.
    if (error instanceof BaseQueryError && error.code === "view-not-found") throw error;
    warnings.push(BASE_CREATE_WARNING_CODES.INCONCLUSIVE);
    return warnings;
  }
  const { view, order, formulas } = compiled;
  try {
    const result = evaluateBaseView({ base, view, order, formulas, records: [record] });
    if (!result.rows.some((row) => row.path === record.path)) {
      throw new BaseCreateError(
        BASE_CREATE_ERROR_CODES.NOT_QUERYABLE,
        `The new entry would not be found by view "${compiled.viewName}": the planned properties do not satisfy that view's filters. Nothing was written.`,
        { view: compiled.viewName, filters: { base: base?.filters ?? null, view: view?.filters ?? null } },
      );
    }
  } catch (error) {
    if (error instanceof BaseCreateError) throw error;
    // Unsupported view configuration (grouping / a formula outside this query
    // subset): queryability is unproven, never asserted.
    warnings.push(BASE_CREATE_WARNING_CODES.INCONCLUSIVE);
  }
  return warnings;
}
