// Canvas document geometry (G11) - pure, DOM-free, unit-testable.
//
// Desktop evidence (RECON §1.7): a node's placement is the `rect` getter
// `{x, y, width, height}` (@3370292) and an edge names its endpoints by node id
// plus a side (`{fromNode, fromSide, toNode, toSide}`, @3406852). This module owns
// exactly those two facts: where a node's box lands inside the scrolled surface,
// and where an edge leaves/enters a box for each of the four sides.
//
// Everything here is a pure function of the DTO, so the browser contract test can
// assert the rendered geometry without a browser (same shape as the Web Bases
// contract tests).

export const CANVAS_NODE_TYPES = Object.freeze(["text", "file", "group", "link"]);
export const CANVAS_EDGE_SIDES = Object.freeze(["top", "right", "bottom", "left"]);
export const CANVAS_PADDING = 40;

// The surface is scrolled inside the document pane, so the canvas is translated by
// its own bounding box: `origin` is the (minX, minY) of every node box.
export function canvasBounds(nodes, padding = CANVAS_PADDING) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (list.length === 0) return { minX: 0, minY: 0, width: padding * 2, height: padding * 2 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of list) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

/** A node's box in surface coordinates (bounds already subtracted). */
export function nodeBox(node, bounds) {
  return {
    left: node.x - bounds.minX,
    top: node.y - bounds.minY,
    width: node.width,
    height: node.height,
  };
}

/** The point an edge attaches to on one side of a box (Desktop's four sides). */
export function edgeAnchor(node, side) {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    default:
      return null;
  }
}

/**
 * The polyline an edge is drawn as, in surface coordinates: the two anchors plus
 * one elbow per axis so the line leaves and enters along the side it names.
 * Returns null when either endpoint is unknown (the edge cannot be placed and is
 * not rendered at all rather than being drawn to an invented point).
 */
export function edgePoints(edge, nodesById, bounds) {
  const from = nodesById?.get?.(edge.fromNode);
  const to = nodesById?.get?.(edge.toNode);
  if (!from || !to) return null;
  const start = edgeAnchor(from, edge.fromSide);
  const end = edgeAnchor(to, edge.toSide);
  if (!start || !end) return null;
  const shift = (point) => ({ x: point.x - bounds.minX, y: point.y - bounds.minY });
  const a = shift(start);
  const b = shift(end);
  const startsVertical = edge.fromSide === "top" || edge.fromSide === "bottom";
  // Both endpoints leave along the same axis: one elbow at the midline of that
  // axis. Mixed sides (a horizontal start into a vertical end) keep both elbows so
  // the line never cuts through the target box.
  if (startsVertical && (edge.toSide === "top" || edge.toSide === "bottom")) {
    const midY = (a.y + b.y) / 2;
    return [a, { x: a.x, y: midY }, { x: b.x, y: midY }, b];
  }
  if (!startsVertical && (edge.toSide === "left" || edge.toSide === "right")) {
    const midX = (a.x + b.x) / 2;
    return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
  }
  return [a, { x: a.x, y: b.y }, b];
}

/** The one line of text a node shows; never vault HTML (textContent only). */
export function nodeLabel(node) {
  if (node.type === "text") return String(node.text ?? "");
  if (node.type === "file") {
    const subpath = String(node.subpath ?? "");
    // Desktop stores the subpath with its own leading `#`; accept both shapes.
    if (!subpath) return String(node.file ?? "");
    return subpath.startsWith("#") ? `${node.file}${subpath}` : `${node.file}#${subpath}`;
  }
  if (node.type === "link") return String(node.url ?? "");
  return "";
}

/** `https:`/`http:` only: a vault-supplied `javascript:` URL must not become a link. */
export function safeLinkUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Groups paint behind every other node (Desktop keeps the group as a backdrop). */
export function renderOrder(nodes) {
  return [...(Array.isArray(nodes) ? nodes : [])].sort((a, b) => {
    const rank = (node) => (node.type === "group" ? 0 : 1);
    return rank(a) - rank(b);
  });
}
