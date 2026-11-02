// Root-scoped `.canvas` document reader + the frozen Canvas DTO (G11, RECON §1.7).
//
// Everything security-relevant is base-reader.js: this module only binds that
// shared reader to the `.canvas` suffix (`readCanvasInRoot`) and then parses the
// JSON payload into the DTO the Web canvas surface renders. There is deliberately
// no second containment/symlink implementation here (RECON §4 刀2 ①).
//
// Desktop evidence (Obsidian asar, RECON §1.7):
//   - `app.js@3418436` reads the file, `JSON.parse`s it and treats the document as
//     a canvas only when `nodes` is an array (`!(i = n.nodes) || !Array.isArray(i)`
//     -> not a canvas). A file without that array is therefore NOT an error in the
//     reader sense: the route answers 422 `not-a-canvas`, never 500.
//   - node types are exactly `text` / `file` / `group` / `link`; geometry is the
//     `rect` getter `@3370292` -> `{x, y, width, height}`.
//   - edges are `{id, fromNode, fromSide, toNode, toSide}` plus optional
//     `fromEnd` / `toEnd` / `color` / `label`, with unknown keys spread through
//     (`@3406852`).
//   - `getData()` returns `{...this.data, nodes, edges}` (`@3319359`), i.e. the
//     top-level document keeps keys this slice does not model: they are returned
//     verbatim as `unknownData` so a future slice can widen the DTO without the
//     transport having dropped the payload.
//
// Deliberate bounds (documented in HANDOFF as `unverified` / deferred):
//   - unknown *node/edge* keys are not echoed (only top-level ones are), and
//   - text-node `[[wikilinks]]` are rendered as plain text (G12 is a later slice).
export { BaseReaderError as CanvasReaderError } from "./base-reader.js";
import { BaseReaderError, readTextFileInRoot } from "./base-reader.js";

export const CANVAS_EXTENSION = ".canvas";
export const CANVAS_NODE_TYPES = Object.freeze(["text", "file", "group", "link"]);
export const CANVAS_EDGE_SIDES = Object.freeze(["top", "right", "bottom", "left"]);

export class CanvasDocumentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CanvasDocumentError";
    this.code = code;
  }
}

/** The `.canvas` binding of the shared root-scoped safe reader. */
export function readCanvasInRoot(vault, relPath) {
  return readTextFileInRoot(vault, relPath, {
    extension: CANVAS_EXTENSION,
    label: "Canvas",
    codePrefix: "CANVAS",
  });
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value : null;
}

// A node is kept only when it carries the identity and the geometry the surface
// needs to place it; anything else is dropped rather than rendered at (0,0).
function normalizeNode(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = text(raw.id);
  const type = text(raw.type);
  if (!id || !CANVAS_NODE_TYPES.includes(type)) return null;
  const x = finite(raw.x);
  const y = finite(raw.y);
  const width = finite(raw.width);
  const height = finite(raw.height);
  if (x === null || y === null || width === null || height === null) return null;
  const node = { id, type, x, y, width, height };
  const color = text(raw.color);
  if (color) node.color = color;
  // Exactly the type-carrying field Desktop reads for this kind (@3418436):
  // file -> {file, subpath}; group -> background; text -> text; link -> url.
  if (type === "text") {
    node.text = text(raw.text) ?? "";
  } else if (type === "file") {
    const file = text(raw.file);
    if (!file) return null;
    node.file = file;
    node.subpath = text(raw.subpath) ?? "";
  } else if (type === "group") {
    const background = text(raw.background);
    if (background) node.background = background;
  } else {
    const url = text(raw.url);
    if (!url) return null;
    node.url = url;
  }
  return node;
}

// An edge is only renderable with both endpoints and both sides; a side outside
// the four Desktop values would place the line anywhere, so it is dropped too.
function normalizeEdge(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = text(raw.id);
  const fromNode = text(raw.fromNode);
  const toNode = text(raw.toNode);
  const fromSide = text(raw.fromSide);
  const toSide = text(raw.toSide);
  if (!id || !fromNode || !toNode) return null;
  if (!CANVAS_EDGE_SIDES.includes(fromSide) || !CANVAS_EDGE_SIDES.includes(toSide)) return null;
  const edge = { id, fromNode, fromSide, toNode, toSide };
  for (const key of ["fromEnd", "toEnd", "color", "label"]) {
    const value = text(raw[key]);
    if (value) edge[key] = value;
  }
  return edge;
}

/**
 * Parses a `.canvas` document into the frozen transport DTO:
 *   { nodes: [...], edges: [...], unknownData? }
 * Throws CanvasDocumentError with a stable code:
 *   `invalid-json`  the payload is not a JSON object  -> 422
 *   `not-a-canvas`  the payload has no `nodes` array   -> 422
 */
export function parseCanvasDocument(raw) {
  let data;
  try {
    data = JSON.parse(String(raw ?? ""));
  } catch {
    throw new CanvasDocumentError("Canvas file is not valid JSON", "invalid-json");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CanvasDocumentError("Canvas file must be a JSON object", "invalid-json");
  }
  // Desktop's own test: no `nodes` array means this file is not a canvas.
  if (!Array.isArray(data.nodes)) {
    throw new CanvasDocumentError("Canvas file has no nodes array", "not-a-canvas");
  }
  const nodes = data.nodes.map(normalizeNode).filter(Boolean);
  const edges = (Array.isArray(data.edges) ? data.edges : []).map(normalizeEdge).filter(Boolean);
  const unknownData = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== "nodes" && key !== "edges") unknownData[key] = value;
  }
  const document = { nodes, edges };
  if (Object.keys(unknownData).length > 0) document.unknownData = unknownData;
  return document;
}

/** Read + parse in one step; IO failures keep the reader's CANVAS_* codes. */
export async function readCanvasDocument(vault, relPath) {
  const file = await readCanvasInRoot(vault, relPath);
  return {
    ...parseCanvasDocument(file.raw),
    path: file.path,
    revision: file.revision,
    stat: file.stat,
  };
}

export { BaseReaderError };
