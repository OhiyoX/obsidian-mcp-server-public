import path from "node:path";
import { BASE_FORMULA_PROPERTY_PREFIX, BaseFormulaError, evaluateBaseFormula, isFormulaProperty } from "./base-formulas.js";
import { OBSIDIAN_TIMEZONE } from "./config.js";

export function parseTasks(raw, notePath) {
  const tasks = [];
  const lines = raw.split("\n");
  let inFrontmatter = lines[0]?.trim() === "---";
  let inFence = false;

  lines.forEach((line, index) => {
    if (index > 0 && inFrontmatter && line.trim() === "---") {
      inFrontmatter = false;
      return;
    }
    if (inFrontmatter) return;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = line.match(/^(\s*)[-*+]\s+\[([^\]])]\s+(.*)$/);
    if (!match) return;
    const status = match[2];
    tasks.push({
      ref: `${notePath}:${index + 1}`,
      path: notePath,
      line: index + 1,
      status,
      completed: status.toLowerCase() === "x",
      text: match[3],
      indentation: match[1].length,
      raw: line,
    });
  });
  return tasks;
}

export function updateTaskLine(raw, lineNumber, nextStatus) {
  const lines = raw.split("\n");
  const index = lineNumber - 1;
  if (index < 0 || index >= lines.length) throw new Error(`Task line is outside the file: ${lineNumber}`);
  const match = lines[index].match(/^(\s*[-*+]\s+\[)([^\]])(]\s+.*)$/);
  if (!match) throw new Error(`No Markdown task found at line ${lineNumber}`);
  const status = nextStatus === "toggle" ? (match[2].toLowerCase() === "x" ? " " : "x") : nextStatus;
  if (String(status).length !== 1) throw new Error("Task status must be exactly one character");
  lines[index] = `${match[1]}${status}${match[3]}`;
  return { raw: lines.join("\n"), previousStatus: match[2], status };
}

function dateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  });
  return Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function formatObsidianDate(date, format = "YYYY-MM-DD", timeZone = OBSIDIAN_TIMEZONE) {
  const parts = dateParts(date, timeZone);
  const monthName = new Intl.DateTimeFormat("en-US", { timeZone, month: "long" }).format(date);
  const shortMonth = new Intl.DateTimeFormat("en-US", { timeZone, month: "short" }).format(date);
  return String(format)
    .replace(/YYYY/g, parts.year)
    .replace(/MMMM/g, monthName)
    .replace(/MMM/g, shortMonth)
    .replace(/MM/g, parts.month)
    .replace(/DD/g, parts.day)
    .replace(/dddd/g, parts.weekday)
    .replace(/HH/g, parts.hour)
    .replace(/mm/g, parts.minute)
    .replace(/ss/g, parts.second);
}

export function renderTemplate(template, options = {}) {
  const date = options.date || new Date();
  const timeZone = options.timeZone || OBSIDIAN_TIMEZONE;
  const variables = { title: options.title || "", ...(options.variables || {}) };
  return template.replace(/{{\s*([^}:]+)(?::([^}]+))?\s*}}/g, (raw, name, format) => {
    const key = name.trim();
    if (key === "date") return formatObsidianDate(date, format?.trim() || "YYYY-MM-DD", timeZone);
    if (key === "time") return formatObsidianDate(date, format?.trim() || "HH:mm", timeZone);
    return Object.hasOwn(variables, key) ? String(variables[key]) : raw;
  });
}

export function inferPropertyType(value) {
  if (Array.isArray(value)) return "multitext";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (value instanceof Date) return "date";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "datetime";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  return "text";
}

function propertyValue(record, property) {
  const key = property.replace(/^note\./, "");
  if (property.startsWith("file.")) {
    const fileKey = property.slice(5);
    const values = {
      name: record.basename,
      path: record.path,
      folder: path.posix.dirname(record.path) === "." ? "" : path.posix.dirname(record.path),
      ext: "md",
      size: record.stat.size,
      ctime: record.stat.created,
      mtime: record.stat.modified,
      tags: record.tags,
      links: record.links.map((link) => link.target),
    };
    return values[fileKey];
  }
  return record.frontmatter[key];
}

function compare(left, operator, right) {
  if (operator === "==") return left === right || String(left) === String(right);
  if (operator === "!=") return !(left === right || String(left) === String(right));
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  return false;
}

function literal(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  const number = Number(trimmed);
  return Number.isNaN(number) ? trimmed : number;
}

// ── Wave 0-D fail-closed guard for filter property namespaces ───────────────
//
// A dotted property reference such as `this.file.folder` used to resolve to
// `undefined` through `propertyValue`, so the comparison silently matched zero
// rows and changed the result set while the response still claimed
// `supportedSubset: true`. Only the leading token is inspected and only dotted
// references are guarded: a bare property is a frontmatter key (legitimate),
// and `formula.` is out of this guard's reach: INT-C released it for filters /
// sort (typed values), and `assertNoFormulaReferencesInGroupBy` now guards only
// `view.groupBy`. Unimplemented `file.<prop>` reads
// (e.g. `file.backlinks`) are deliberately out of scope here (P1-A typing).
const FILTER_PROPERTY_NAMESPACES = Object.freeze(["file", "note"]);

function assertFilterPropertyNamespace(property) {
  const token = String(property);
  const separator = token.indexOf(".");
  if (separator === -1) return;
  const namespace = token.slice(0, separator);
  if (FILTER_PROPERTY_NAMESPACES.includes(namespace)) return;
  throw new Error(`Unsupported Base filter expression: unknown namespace "${namespace}" in "${token}"`);
}

export function evaluateBaseExpression(expression, record) {
  const source = String(expression || "").trim();
  let match = source.match(/^file\.inFolder\((["'])(.*?)\1\)$/);
  if (match) return record.path.startsWith(`${match[2].replace(/\/$/, "")}/`);
  match = source.match(/^file\.hasTag\((["'])(.*?)\1\)$/);
  if (match) return record.tags.includes(match[2].replace(/^#/, "").toLowerCase());
  match = source.match(/^file\.hasLink\((["'])(.*?)\1\)$/);
  if (match) return record.links.some((link) => link.target === match[2] || link.target.replace(/\.md$/i, "") === match[2].replace(/\.md$/i, ""));
  match = source.match(/^([\w.-]+)\.contains\((["'])(.*?)\2\)$/);
  if (match) {
    assertFilterPropertyNamespace(match[1]);
    const value = propertyValue(record, match[1]);
    return Array.isArray(value) ? value.map(String).includes(match[3]) : String(value ?? "").includes(match[3]);
  }
  match = source.match(/^([\w.-]+)\.(startsWith|endsWith)\((["'])(.*?)\3\)$/);
  if (match) {
    assertFilterPropertyNamespace(match[1]);
    const value = propertyValue(record, match[1]);
    return typeof value === "string" && value[match[2]](match[4]);
  }
  match = source.match(/^([\w.-]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (match) {
    assertFilterPropertyNamespace(match[1]);
    return compare(propertyValue(record, match[1]), match[2], literal(match[3]));
  }
  throw new Error(`Unsupported Base filter expression: ${source}`);
}

export function evaluateBaseFilter(filter, record) {
  if (!filter) return true;
  if (typeof filter === "string") return evaluateBaseExpression(filter, record);
  if (Array.isArray(filter)) return filter.every((item) => evaluateBaseFilter(item, record));
  if (filter.and) return filter.and.every((item) => evaluateBaseFilter(item, record));
  if (filter.or) return filter.or.some((item) => evaluateBaseFilter(item, record));
  if (filter.not) return !filter.not.some((item) => evaluateBaseFilter(item, record));
  throw new Error("Unsupported Base filter object");
}

export function baseRow(record, order = [], options = {}) {
  const properties = order.length ? order : ["file.path"];
  const formulas = options.formulas;
  return Object.fromEntries(properties.map((property) => {
    if (isFormulaProperty(property) && formulas) {
      const name = property.slice(BASE_FORMULA_PROPERTY_PREFIX.length);
      if (!Object.hasOwn(formulas, name)) throw new BaseFormulaError(`Base view references missing formula "${name}"`);
      return [property, evaluateBaseFormula(formulas[name], record)];
    }
    return [property, propertyValue(record, property)];
  }));
}

export function sortBaseRecords(records, sort = []) {
  if (!Array.isArray(sort) || !sort.length) return records;
  for (const item of sort) {
    if (!item || typeof item.property !== "string" || !["ASC", "DESC"].includes(item.direction || "ASC")) {
      throw new Error("Unsupported Base sort configuration");
    }
  }
  return [...records].sort((left, right) => {
    for (const item of sort) {
      const a = propertyValue(left, item.property);
      const b = propertyValue(right, item.property);
      if (a == null && b == null) continue;
      if (a == null) return 1;
      if (b == null) return -1;
      const dateValue = (value) => {
        if (value instanceof Date) return value.getTime();
        if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return Date.parse(value);
        return NaN;
      };
      const dateA = dateValue(a);
      const dateB = dateValue(b);
      const result = Number.isFinite(dateA) && Number.isFinite(dateB)
        ? dateA - dateB
        : typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true });
      if (result) return (item.direction || "ASC") === "DESC" ? -result : result;
    }
    return left.path.localeCompare(right.path);
  });
}
