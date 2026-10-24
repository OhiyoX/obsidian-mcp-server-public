// Browser contract test for the canvas surface (G11 item ②): one fixture with all
// four desktop node types and two edges must render exactly those nodes and edges,
// positioned by their `{x,y,width,height}` and attached on the side each edge names.
//
// It runs the real client modules (model.js + surface.js) against a minimal DOM
// stand-in, so the count/geometry/side assertions are made on the code that ships
// in src/app/assets/canvas.js and not on a re-implementation.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS_PADDING,
  canvasBounds,
  edgeAnchor,
  edgePoints,
  nodeBox,
  nodeLabel,
  renderOrder,
  safeLinkUrl,
} from "../frontend/app/features/canvas/model.js";
import { CANVAS_SURFACE_CSS, mountCanvasSurface, renderCanvasError } from "../frontend/app/features/canvas/surface.js";

// The lane fixture: the four desktop node kinds (text / file / group / link) and
// two edges - one leaving horizontally, one vertically.
const FIXTURE = {
  nodes: [
    { id: "group-a", type: "group", x: -120, y: -80, width: 640, height: 420, background: "#1f1f1f" },
    { id: "text-a", type: "text", x: 0, y: 0, width: 240, height: 120, text: "卡片" },
    { id: "file-a", type: "file", x: 400, y: 0, width: 240, height: 120, file: "Notes/Plan.md", subpath: "#Step" },
    { id: "link-a", type: "link", x: 200, y: 280, width: 240, height: 80, url: "https://example.com/a" },
  ],
  edges: [
    { id: "edge-1", fromNode: "text-a", fromSide: "right", toNode: "file-a", toSide: "left", color: "#e03131" },
    { id: "edge-2", fromNode: "text-a", fromSide: "bottom", toNode: "link-a", toSide: "top", label: "see also" },
  ],
};

function elementStub(tag) {
  return {
    tagName: tag.toUpperCase(),
    attributes: {},
    children: [],
    style: {},
    textContent: "",
    hidden: false,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    append(...items) {
      this.children.push(...items);
    },
    querySelectorAll() {
      return [];
    },
  };
}

function createDom() {
  const doc = {
    createElement: (tag) => elementStub(tag),
    createElementNS: (_ns, tag) => elementStub(tag),
  };
  return { doc, host: elementStub("div") };
}

const walk = (node) => [node, ...(node.children ?? []).flatMap((child) => walk(child))];
const findByClass = (host, className) => walk(host).filter((node) => new RegExp(`(^|\\s)${className}(\\s|$)`).test(node.getAttribute("class") || ""));
const byTag = (host, tag) => walk(host).filter((node) => node.tagName === tag.toUpperCase());

test("the fixture renders 4 nodes (one per desktop type) and 2 edges", () => {
  const { doc, host } = createDom();
  const tally = mountCanvasSurface({ host, document: FIXTURE, doc });
  assert.deepEqual({ nodes: tally.nodes, edges: tally.edges, edgesDropped: tally.edgesDropped, failed: tally.failed }, { nodes: 4, edges: 2, edgesDropped: 0, failed: false });

  const nodes = findByClass(host, "canvas-node");
  assert.equal(nodes.length, 4, "one element per node");
  assert.deepEqual(nodes.map((node) => node.getAttribute("data-node-type")), ["group", "text", "file", "link"], "groups paint first (behind)");
  assert.deepEqual(nodes.map((node) => node.getAttribute("data-node-id")), ["group-a", "text-a", "file-a", "link-a"]);

  const edges = byTag(host, "polyline");
  assert.equal(edges.length, 2, "one polyline per edge");
  assert.deepEqual(edges.map((edge) => edge.getAttribute("data-edge-id")), ["edge-1", "edge-2"]);
  assert.equal(host.hidden, false, "the host is shown once the canvas is mounted");
  assert.equal(host.getAttribute("data-canvas-ready"), "1");
});

test("node boxes are placed by the desktop rect and the document bounds", () => {
  const bounds = canvasBounds(FIXTURE.nodes, CANVAS_PADDING);
  // Bounding box of the fixture with the 40px canvas padding.
  assert.deepEqual(bounds, { minX: -160, minY: -120, width: 840, height: 520 });
  assert.deepEqual(nodeBox(FIXTURE.nodes[1], bounds), { left: 160, top: 120, width: 240, height: 120 });

  const { doc, host } = createDom();
  mountCanvasSurface({ host, document: FIXTURE, doc });
  const surface = findByClass(host, "canvas-surface")[0];
  assert.equal(surface.style.width, "840px");
  assert.equal(surface.style.height, "520px");
  const text = findByClass(host, "canvas-node-text")[0];
  assert.equal(text.style.left, "160px");
  assert.equal(text.style.top, "120px");
  assert.equal(text.style.width, "240px");
  assert.equal(text.style.height, "120px");
  assert.equal(text.textContent, "卡片");
  const group = findByClass(host, "canvas-node-group")[0];
  assert.equal(group.style.left, "40px");
  assert.equal(group.style.top, "40px");
  assert.equal(findByClass(host, "canvas-node-file")[0].textContent, "Notes/Plan.md#Step");
  const svg = findByClass(host, "canvas-edges")[0];
  assert.equal(svg.getAttribute("viewBox"), "0 0 840 520");
});

test("edges attach on the side the desktop model names", () => {
  const nodesById = new Map(FIXTURE.nodes.map((node) => [node.id, node]));
  const bounds = canvasBounds(FIXTURE.nodes, CANVAS_PADDING);

  // The four side anchors of the text node's box (surface coordinates).
  assert.deepEqual(edgeAnchor(FIXTURE.nodes[1], "top"), { x: 120, y: 0 });
  assert.deepEqual(edgeAnchor(FIXTURE.nodes[1], "bottom"), { x: 120, y: 120 });
  assert.deepEqual(edgeAnchor(FIXTURE.nodes[1], "left"), { x: 0, y: 60 });
  assert.deepEqual(edgeAnchor(FIXTURE.nodes[1], "right"), { x: 240, y: 60 });

  const horizontal = edgePoints(FIXTURE.edges[0], nodesById, bounds);
  assert.deepEqual(horizontal[0], { x: 400, y: 180 }, "right side of text-a");
  assert.deepEqual(horizontal.at(-1), { x: 560, y: 180 }, "left side of file-a");
  const vertical = edgePoints(FIXTURE.edges[1], nodesById, bounds);
  assert.deepEqual(vertical[0], { x: 280, y: 240 }, "bottom side of text-a");
  assert.deepEqual(vertical.at(-1), { x: 480, y: 400 }, "top side of link-a");

  const { doc, host } = createDom();
  mountCanvasSurface({ host, document: FIXTURE, doc });
  const rendered = byTag(host, "polyline");
  const first = rendered[0];
  assert.equal(first.getAttribute("data-from-side"), "right");
  assert.equal(first.getAttribute("data-to-side"), "left");
  assert.equal(first.getAttribute("data-from-node"), "text-a");
  assert.equal(first.getAttribute("data-to-node"), "file-a");
  assert.equal(first.getAttribute("points"), "400,180 480,180 480,180 560,180");
  assert.equal(first.style.stroke, "#e03131");
  const second = rendered[1];
  assert.equal(second.getAttribute("data-from-side"), "bottom");
  assert.equal(second.getAttribute("data-to-side"), "top");
  assert.equal(second.getAttribute("points"), "280,240 280,320 480,320 480,400");
  assert.equal(second.children[0].textContent, "see also");
});

test("an edge without both endpoints is dropped, never drawn to an invented point", () => {
  const { doc, host } = createDom();
  const tally = mountCanvasSurface({
    host,
    doc,
    document: {
      nodes: FIXTURE.nodes,
      edges: [...FIXTURE.edges, { id: "edge-3", fromNode: "text-a", fromSide: "top", toNode: "gone", toSide: "bottom" }],
    },
  });
  assert.equal(tally.edges, 2);
  assert.equal(tally.edgesDropped, 1);
  assert.equal(byTag(host, "polyline").length, 2);
});

test("vault text never becomes markup and a non-http link never becomes an anchor", () => {
  const { doc, host } = createDom();
  mountCanvasSurface({
    host,
    doc,
    document: {
      nodes: [{ id: "x", type: "text", x: 0, y: 0, width: 10, height: 10, text: '<img src=x onerror="alert(1)">' }],
      edges: [],
    },
  });
  const text = findByClass(host, "canvas-node-text")[0];
  assert.equal(text.textContent, '<img src=x onerror="alert(1)">');
  assert.equal(text.children.length, 0, "the label is textContent, never innerHTML");
  assert.equal(findByClass(host, "canvas-node-text")[0].getAttribute("data-node-type"), "text");

  assert.equal(safeLinkUrl("javascript:alert(1)"), null);
  assert.equal(safeLinkUrl("data:text/html,x"), null);
  assert.equal(safeLinkUrl("https://example.com"), "https://example.com");
  assert.equal(safeLinkUrl("http://example.com"), "http://example.com");

  const { doc: doc2, host: host2 } = createDom();
  mountCanvasSurface({
    host: host2,
    doc: doc2,
    document: { nodes: [{ id: "l", type: "link", x: 0, y: 0, width: 10, height: 10, url: "javascript:alert(1)" }], edges: [] },
  });
  assert.equal(findByClass(host2, "canvas-node-link")[0].children.length, 0, "a javascript: URL is not an anchor");
  assert.equal(findByClass(host2, "canvas-node-link")[0].textContent, "javascript:alert(1)");
});

test("a failed canvas load leaves a visible status line, not a blank pane", () => {
  const { doc, host } = createDom();
  renderCanvasError({ host, doc });
  const line = findByClass(host, "canvas-error")[0];
  assert.equal(line.textContent, "画布渲染失败，已保留原始文件。");
  assert.equal(line.getAttribute("role"), "status");
  assert.equal(host.hidden, false);
});

test("pure model helpers keep their contract", () => {
  assert.deepEqual(canvasBounds([], 40), { minX: 0, minY: 0, width: 80, height: 80 });
  assert.deepEqual(renderOrder([{ id: "b", type: "text" }, { id: "a", type: "group" }]).map((node) => node.id), ["a", "b"]);
  assert.equal(nodeLabel({ type: "file", file: "A.md", subpath: "" }), "A.md");
  assert.equal(nodeLabel({ type: "link", url: "https://example.com" }), "https://example.com");
  assert.equal(nodeLabel({ type: "group" }), "");
  assert.equal(edgePoints({ fromNode: "a", fromSide: "right", toNode: "b", toSide: "left" }, new Map(), { minX: 0, minY: 0 }), null);
  assert.match(CANVAS_SURFACE_CSS, /#canvas-host:not\(\[hidden\]\)/, "the surface is the visible document pane on a canvas page");
  assert.match(CANVAS_SURFACE_CSS, /\.canvas-node-group/, "groups have their own face");
});
