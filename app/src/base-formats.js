// A1 — MCP `query_base` output formats (json | csv | tsv | md | paths).
//
// Desktop authority (read from `obsidian-asar-1.14.4/app.js`, read-only):
//   * `base:query` CLI params `format:json|csv|tsv|md|paths` @3239822-@3240450.
//   * the evaluation block builds `header = order.map(getDisplayName)` and
//     `body = rows.map(row => order.map(key => { const v = row.getValue(key);
//     return v == null || v === emptyValue ? "" : v.toString(); }))`, then
//     dispatches `paths -> data.map(f => f.file.path).join("\n")`,
//     `csv -> table.toCSV()`, `tsv -> table.toTSV()`, `md -> table.toMarkdown()`.
//   * `toText` @1627723 (the engine behind toCSV/toTSV): headers are included
//     first; a cell is quoted with doubled `"` iff it contains `"`, `\n`, `\r`
//     or the separator; lines join with `\n` (no trailing newline, no BOM).
//   * `toMarkdown` @1625961: `|` is escaped as `\|`; column widths are the
//     maximum escaped width + 2; each cell is centered (`floor` padding on the
//     left, remainder on the right); after the header row a separator line
//     `| --- |` is emitted with `width - 2` dashes per column.
//
// The `json` format is deliberately NOT the desktop CLI JSON shape (which is
// `[{path, <displayName>: value ?? null}]`): A1 is bound by the hard
// backward-compatibility requirement that a call without `format` stays
// byte-identical to the historical MCP DTO, so the handler keeps using
// `result.js`'s `ok()` for `json` and this module only renders the four text
// formats. Details the desktop binary does not pin down (BOM, empty-value
// rendering, Date/array/link/object cells) are frozen here as DESIGN choices
// and marked `desktop-unverified` in HANDOFF.md.
//
// Pure module: no fs / path / express / MCP imports, no process state, no I/O.

export const BASE_QUERY_FORMATS = Object.freeze(["json", "csv", "tsv", "md", "paths"]);

// MCP-layer input error (the Base document itself is not at fault): the handler
// surfaces it through the same structured error shape as `BaseQueryError`.
export const INVALID_FORMAT_ERROR_CODE = "invalid-format";

export class BaseFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "BaseFormatError";
    this.code = INVALID_FORMAT_ERROR_CODE;
  }
}

/**
 * Fail closed on an unknown `format` value. Deliberately not a silent fallback
 * to json: a typo must be observable.
 *
 * @param {unknown} format
 * @returns {"json"|"csv"|"tsv"|"md"|"paths"}
 * @throws {BaseFormatError} code `invalid-format`
 */
export function assertBaseQueryFormat(format) {
  const value = format === undefined || format === null || format === "" ? "json" : format;
  if (!BASE_QUERY_FORMATS.includes(value)) {
    throw new BaseFormatError(`Unsupported Base query format: ${String(format)} (expected one of ${BASE_QUERY_FORMATS.join(", ")})`);
  }
  return value;
}

// Cell -> display string. Mirrors the desktop `null == v || v === empty -> ""`
// rule, then `v.toString()`. Structured cells that only exist in this server's
// value layer (the frozen `file.asLink` DTO) are reduced to their display name
// so they never render as `[object Object]`.
//
// desktop-unverified: desktop cells are already display strings, so the
// Date / array / link / object branches have no byte-level desktop evidence.
export function baseFormatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => baseFormatCell(item)).join(",");
  if (typeof value === "object") {
    // Frozen `file.asLink` cell: { path, displayName, kind: "asLink" }.
    if (typeof value.displayName === "string" && value.displayName) return value.displayName;
    if (typeof value.path === "string" && value.path) return value.path;
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

// Header keys: declared column keys in view order. The shared service computes
// `columns` for the Web adapter too, so the MCP handler can pass them through
// without touching `base-query.js`.
export function baseFormatKeys(columns, rows) {
  if (Array.isArray(columns) && columns.length) return columns.map((column) => String(column.key));
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return first && first.values && typeof first.values === "object" ? Object.keys(first.values) : [];
}

// Header labels: the desktop `getDisplayName` analog, already computed by
// `base-query.js` as `columns[].label`.
export function baseFormatHeaders(columns, rows) {
  if (Array.isArray(columns) && columns.length) return columns.map((column) => String(column.label));
  return baseFormatKeys(columns, rows);
}

function baseFormatBody(columns, rows) {
  const keys = baseFormatKeys(columns, rows);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const values = row && typeof row === "object" && row.values && typeof row.values === "object" ? row.values : {};
    return keys.map((key) => baseFormatCell(values[key]));
  });
}

// Exact `toText` semantics from the desktop bundle (`toCSV` = `toText(",", true)`,
// `toTSV` = `toText("\t", true)`).
export function baseDelimitedTable(headers, body, separator) {
  const quotePattern = new RegExp(`["\n\r${separator}]`);
  const quote = (cell) => (quotePattern.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  const lines = [headers.map(quote).join(separator)];
  for (const row of body) lines.push(row.map(quote).join(separator));
  return lines.join("\n");
}

const escapePipe = (cell) => cell.replace(/\|/g, "\\|");

// Exact `toMarkdown` semantics from the desktop bundle.
export function baseMarkdownTable(headers, body) {
  const escapedHeaders = headers.map(escapePipe);
  const escapedBody = body.map((row) => row.map(escapePipe));
  const widths = escapedHeaders.map((cell) => cell.length);
  for (const row of escapedBody) {
    for (let index = 0; index < row.length; index += 1) {
      if (widths[index] === undefined) widths[index] = 0;
      if (row[index].length > widths[index]) widths[index] = row[index].length;
    }
  }
  for (let index = 0; index < widths.length; index += 1) widths[index] += 2;

  const lines = [escapedHeaders, ...escapedBody];
  const out = [];
  for (const [rowIndex, row] of lines.entries()) {
    let line = "|";
    for (let index = 0; index < row.length; index += 1) {
      const cell = row[index];
      const total = widths[index] - cell.length;
      const left = Math.floor(total / 2);
      const right = total - left;
      line += " ".repeat(left) + cell + " ".repeat(right) + "|";
    }
    out.push(line);
    if (rowIndex === 0) {
      let separatorLine = "|";
      for (let index = 0; index < row.length; index += 1) {
        separatorLine += ` ${"-".repeat(widths[index] - 2)} |`;
      }
      out.push(separatorLine);
    }
  }
  return out.join("\n");
}

/**
 * Render a non-json `query_base` result.
 *
 * @param {{format: "csv"|"tsv"|"md"|"paths", columns?: Array<{key: string, label: string}>, rows: Array<{path: string, values: object}>}} input
 * @returns {{text: string, paths?: string[]}}
 */
export function renderBaseQueryFormat({ format, columns, rows }) {
  const selected = assertBaseQueryFormat(format);
  if (selected === "json") throw new BaseFormatError("renderBaseQueryFormat handles the text formats only");
  if (selected === "paths") {
    const paths = (Array.isArray(rows) ? rows : []).map((row) => String(row?.path ?? ""));
    // Desktop parity is the newline-joined text; the array is the MCP-friendly
    // companion the lane brief asks for (see HANDOFF: paths contract).
    return { text: paths.join("\n"), paths };
  }
  const headers = baseFormatHeaders(columns, rows);
  const body = baseFormatBody(columns, rows);
  if (selected === "csv") return { text: baseDelimitedTable(headers, body, ",") };
  if (selected === "tsv") return { text: baseDelimitedTable(headers, body, "\t") };
  return { text: baseMarkdownTable(headers, body) };
}
