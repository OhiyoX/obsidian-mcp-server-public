// Canvas surface: the read-only DOM the canvas document is drawn into (G11).
//
// Read-only by construction (RECON §3 G13 keeps edit/PNG export out of scope):
// this module creates elements, never listens for edits, and never assigns vault
// text through innerHTML - every label goes through textContent, and a link node
// only becomes an anchor when its URL is http(s) (see model.safeLinkUrl).
//
// The DOM leg is separate from model.js so the geometry can be asserted in a
// node-only test and the mounting can be asserted against a minimal document
// stand-in (the browser contract test does both).
import {
  CANVAS_PADDING,
  canvasBounds,
  edgePoints,
  nodeBox,
  nodeLabel,
  renderOrder,
  safeLinkUrl,
} from "./model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ERROR_TEXT = "画布渲染失败，已保留原始文件。";

export const CANVAS_SURFACE_CSS = `
[data-canvas-surface] { position: relative; }
.canvas-surface { position: relative; }
.canvas-node { position: absolute; box-sizing: border-box; overflow: hidden; border: 1px solid var(--background-modifier-border, #3a3a3a); border-radius: 8px; background: var(--background-secondary, #262626); color: var(--text-normal, #dcddde); font-size: 13px; line-height: 1.35; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; }
.canvas-node-group { z-index: 0; background: var(--canvas-group-bg, rgba(255, 255, 255, 0.04)); border-style: dashed; }
.canvas-group-label { position: absolute; top: 6px; left: 10px; color: var(--text-muted, #999); font-size: 12px; }
.canvas-node-text { z-index: 1; }
.canvas-node-file, .canvas-node-link { z-index: 1; display: flex; align-items: center; }
.canvas-node-file-name { font-weight: 500; }
.canvas-node-link-url { color: var(--link-color, var(--text-accent, #7aa2f7)); text-decoration: none; overflow: hidden; text-overflow: ellipsis; }
.canvas-node-link-url:hover { text-decoration: underline; }
.canvas-edges { position: absolute; left: 0; top: 0; z-index: 0; overflow: visible; pointer-events: none; }
.canvas-edge { fill: none; stroke: var(--text-faint, #888); stroke-width: 2; }
.canvas-error { margin: 24px; color: var(--text-muted, #999); }
#canvas-host:not([hidden]) { position: absolute; inset: 0; z-index: 3; overflow: auto; background: var(--background-primary, #1e1e1e); }
`;

function element(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute("class", className);
  return node;
}

function svgElement(doc, tag) {
  return doc.createElementNS(SVG_NS, tag);
}

function nodeElement(doc, node, bounds) {
  const box = nodeBox(node, bounds);
  const el = element(doc, "div", `canvas-node canvas-node-${node.type}`);
  el.setAttribute("data-node-id", node.id);
  el.setAttribute("data-node-type", node.type);
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
  if (typeof node.color === "string" && node.color) el.style.borderColor = node.color;
  if (node.type === "link") {
    const url = safeLinkUrl(node.url);
    const label = String(node.url ?? "");
    el.setAttribute("data-url", label);
    if (!url) {
      el.textContent = label;
      return el;
    }
    const anchor = element(doc, "a", "canvas-node-link-url");
    anchor.setAttribute("href", url);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.textContent = label;
    el.append(anchor);
    return el;
  }
  el.textContent = nodeLabel(node);
  return el;
}

/**
 * Mounts the canvas into `host` (an element inside `.document`). Returns the
 * render tally the probes assert on; never throws - a malformed document leaves
 * the host with a visible `.canvas-error` line instead of a blank pane.
 */
export function mountCanvasSurface({ host, document: documentData, doc = globalThis.document, padding = CANVAS_PADDING } = {}) {
  if (!host || !doc) return { nodes: 0, edges: 0, edgesDropped: 0, failed: true };
  const nodes = Array.isArray(documentData?.nodes) ? documentData.nodes : [];
  const edges = Array.isArray(documentData?.edges) ? documentData.edges : [];
  const bounds = canvasBounds(nodes, padding);
  const surface = element(doc, "div", "canvas-surface");
  surface.setAttribute("data-canvas-surface", "");
  surface.style.width = `${bounds.width}px`;
  surface.style.height = `${bounds.height}px`;

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edgesLayer = svgElement(doc, "svg");
  edgesLayer.setAttribute("class", "canvas-edges");
  edgesLayer.setAttribute("width", String(bounds.width));
  edgesLayer.setAttribute("height", String(bounds.height));
  edgesLayer.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  let drawnEdges = 0;
  let edgesDropped = 0;
  for (const edge of edges) {
    const points = edgePoints(edge, nodesById, bounds);
    if (!points) {
      edgesDropped += 1;
      continue;
    }
    const line = svgElement(doc, "polyline");
    line.setAttribute("class", "canvas-edge");
    line.setAttribute("data-edge-id", edge.id);
    line.setAttribute("data-from-node", edge.fromNode);
    line.setAttribute("data-to-node", edge.toNode);
    line.setAttribute("data-from-side", edge.fromSide);
    line.setAttribute("data-to-side", edge.toSide);
    line.setAttribute("points", points.map((point) => `${point.x},${point.y}`).join(" "));
    if (typeof edge.color === "string" && edge.color) line.style.stroke = edge.color;
    if (edge.label) {
      const title = svgElement(doc, "title");
      title.textContent = String(edge.label);
      line.append(title);
    }
    edgesLayer.append(line);
    drawnEdges += 1;
  }

  const nodesLayer = element(doc, "div", "canvas-nodes");
  for (const node of renderOrder(nodes)) nodesLayer.append(nodeElement(doc, node, bounds));

  // Groups first (behind), edges above the backdrop but below every node box.
  surface.append(edgesLayer, nodesLayer);
  host.textContent = "";
  host.append(surface);
  host.hidden = false;
  host.setAttribute("data-canvas-ready", "1");
  return { nodes: nodes.length, edges: drawnEdges, edgesDropped, failed: false };
}

/** The visible failure line: no partial canvas, no silent blank pane. */
export function renderCanvasError({ host, doc = globalThis.document, message = ERROR_TEXT } = {}) {
  if (!host || !doc) return;
  const line = element(doc, "p", "canvas-error");
  line.setAttribute("role", "status");
  line.textContent = message;
  host.textContent = "";
  host.append(line);
  host.hidden = false;
}

export { ERROR_TEXT as CANVAS_ERROR_TEXT };
