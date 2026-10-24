// `.canvas` reader tests (G11): the security semantics are asserted AGAINST the
// `.base` reader, not re-derived.
//
// RECON §4 刀2 ① requires the new `.canvas` read to reuse base-reader.js' semantics
// (root containment + symlink rejection) "测试对拍": every attack shape runs through
// both bindings and the two failures must be the same failure with the same reader
// namespace, so a future change to one binding cannot silently loosen the other.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A small read budget keeps the oversized case cheap; set before the module (and
// its config.js import) is evaluated.
process.env.MAX_READ_BYTES = "2048";

const { BaseReaderError, readBaseInRoot } = await import("../src/app/base-reader.js");
const {
  CanvasDocumentError,
  parseCanvasDocument,
  readCanvasDocument,
  readCanvasInRoot,
} = await import("../src/app/canvas-reader.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-web-canvas-reader-"));
const vaultA = path.join(root, "vault-a");
const vaultB = path.join(root, "vault-b");
const outside = path.join(root, "outside");
await fs.mkdir(path.join(vaultA, "Folder"), { recursive: true });
await fs.mkdir(path.join(vaultA, "Dir.canvas"), { recursive: true });
await fs.mkdir(path.join(vaultA, "Dir.base"), { recursive: true });
await fs.mkdir(vaultB, { recursive: true });
await fs.mkdir(outside, { recursive: true });
const BOARD = JSON.stringify({ nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 10, height: 10, text: "hi" }], edges: [] });
await fs.writeFile(path.join(vaultA, "Board.canvas"), BOARD);
await fs.writeFile(path.join(vaultA, "Folder", "Nested.canvas"), BOARD);
await fs.writeFile(path.join(vaultA, "Project.base"), "views:\n  - name: All\n");
await fs.writeFile(path.join(vaultB, "Secret.canvas"), BOARD);
await fs.writeFile(path.join(outside, "secret.canvas"), BOARD);
// Paired fixture: the "intermediate symlinked directory" subtest below runs the SAME shape through
// both bindings and requires the SAME failure (CANVAS_ESCAPE / BASE_ESCAPE). Only the `.canvas`
// half existed here, so the `.base` half resolved a path that does not exist outside the vault and
// legitimately reported BASE_NOT_FOUND instead of BASE_ESCAPE — a missing fixture, not a reader
// asymmetry (issue #602; it only surfaced on Linux, where the symlink is actually created).
await fs.writeFile(path.join(outside, "secret.base"), "views:\n  - name: All\n");
await fs.writeFile(path.join(vaultA, "Big.canvas"), "x".repeat(4096));
await fs.writeFile(path.join(vaultA, "Big.base"), "x".repeat(4096));

test.after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Creates a symlink or, only on Windows where the privilege is unavailable, marks
// the subtest skipped with an explicit reason.
async function symlinkOrSkip(t, target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) throw error;
    t.skip(`symlink privilege unavailable on Windows: ${error.code}`);
    return false;
  }
}

// Runs one attack shape through both bindings and asserts the SAME failure shape:
// same reader kind, same suffix code, same message. A `.base`-only regression then
// cannot pass while `.canvas` silently behaves differently.
async function assertSameFailure(t, label, { basePath, canvasPath = basePath }) {
  let baseError = null;
  let canvasError = null;
  try {
    await readBaseInRoot({ id: "a", root: vaultA }, basePath);
  } catch (error) {
    baseError = error;
  }
  try {
    await readCanvasInRoot({ id: "a", root: vaultA }, canvasPath);
  } catch (error) {
    canvasError = error;
  }
  assert.ok(baseError instanceof BaseReaderError, `${label}: the base binding must fail`);
  assert.ok(canvasError instanceof BaseReaderError, `${label}: the canvas binding must fail`);
  const suffix = (code) => String(code).replace(/^(BASE|CANVAS)_/, "");
  assert.equal(suffix(canvasError.code), suffix(baseError.code), `${label}: same failure class`);
  assert.equal(
    canvasError.message.replace(/^Canvas/, "Base"),
    baseError.message,
    `${label}: same message shape`,
  );
  await t.test(label, () => {});
  return baseError.code;
}

test("the .canvas read is the same root-scoped safe read as .base", async (t) => {
  const read = await readCanvasInRoot({ id: "a", root: vaultA }, "Folder/Nested.canvas");
  assert.equal(read.path, "Folder/Nested.canvas");
  assert.equal(read.raw, BOARD);
  assert.match(read.revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(read.stat.size, Buffer.byteLength(BOARD));

  await t.test("readCanvasDocument composes the read with the DTO", async () => {
    const document = await readCanvasDocument({ id: "a", root: vaultA }, "Board.canvas");
    assert.equal(document.path, "Board.canvas");
    assert.equal(document.nodes.length, 1);
    assert.deepEqual(document.edges, []);
    assert.match(document.revision, /^sha256:/);
  });
});

test("path shapes fail identically in both bindings", async (t) => {
  const cases = [
    ["absolute path", "/etc/Board.canvas"],
    ["windows drive", "C:/Board.canvas"],
    ["backslash separator", "Folder\\Nested.canvas"],
    ["dot segment", "./Board.canvas"],
    ["parent segment", "../outside/secret.canvas"],
    ["double slash", "Folder//Nested.canvas"],
    ["trailing slash", "Folder/"],
    ["empty path", ""],
    ["nul byte", "Board.canvas\u0000"],
  ];
  for (const [label, value] of cases) {
    await assertSameFailure(t, label, { basePath: value.replaceAll(".canvas", ".base"), canvasPath: value });
  }

  await t.test("wrong extension", async () => {
    await assert.rejects(() => readCanvasInRoot({ id: "a", root: vaultA }, "Project.base"), (error) => {
      assert.ok(error instanceof BaseReaderError);
      assert.equal(error.code, "CANVAS_PATH_INVALID");
      assert.equal(error.message, "Only .canvas files are supported");
      return true;
    });
    // The reverse: the base binding refuses a .canvas file with the same rule.
    await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Board.canvas"), (error) => {
      assert.equal(error.code, "BASE_PATH_INVALID");
      assert.equal(error.message, "Only .base files are supported");
      return true;
    });
  });

  await t.test("a file in another vault is not reachable by name", async () => {
    await assert.rejects(() => readCanvasInRoot({ id: "b", root: vaultB }, "Board.canvas"), (error) => {
      assert.equal(error.code, "CANVAS_NOT_FOUND");
      return true;
    });
  });

  await t.test("a directory is not a canvas", async () => {
    await assert.rejects(() => readCanvasInRoot({ id: "a", root: vaultA }, "Dir.canvas"), (error) => {
      assert.equal(error.code, "CANVAS_NOT_A_FILE");
      return true;
    });
    await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Dir.base"), (error) => {
      assert.equal(error.code, "BASE_NOT_A_FILE");
      return true;
    });
  });

  await t.test("the read budget still applies", async () => {
    await assert.rejects(() => readCanvasInRoot({ id: "a", root: vaultA }, "Big.canvas"), (error) => {
      assert.equal(error.code, "CANVAS_TOO_LARGE");
      assert.equal(error.message, "Canvas file exceeds the read limit");
      return true;
    });
    await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "Big.base"), (error) => {
      assert.equal(error.code, "BASE_TOO_LARGE");
      return true;
    });
  });
});

test("symlinked .canvas files are refused by both bindings", async (t) => {
  await t.test("final symlink inside the vault", async (sub) => {
    if (!(await symlinkOrSkip(sub, path.join(vaultA, "Board.canvas"), path.join(vaultA, "Alias.canvas"), "file"))) return;
    await fs.symlink(path.join(vaultA, "Project.base"), path.join(vaultA, "Alias.base"), "file").catch(() => {});
    for (const [rel, code] of [["Alias.canvas", "CANVAS_ESCAPE"], ["Alias.base", "BASE_ESCAPE"]]) {
      const read = rel.endsWith(".canvas") ? readCanvasInRoot : readBaseInRoot;
      await assert.rejects(() => read({ id: "a", root: vaultA }, rel), (error) => {
        assert.equal(error.code, code, `${rel} must be refused as a symlink`);
        return true;
      });
    }
  });

  await t.test("intermediate symlinked directory", async (sub) => {
    if (!(await symlinkOrSkip(sub, outside, path.join(vaultA, "EscapeDir"), "dir"))) return;
    await assert.rejects(() => readCanvasInRoot({ id: "a", root: vaultA }, "EscapeDir/secret.canvas"), (error) => {
      assert.equal(error.code, "CANVAS_ESCAPE");
      return true;
    });
    await assert.rejects(() => readBaseInRoot({ id: "a", root: vaultA }, "EscapeDir/secret.base"), (error) => {
      assert.equal(error.code, "BASE_ESCAPE");
      return true;
    });
  });
});

test("a vault root is still required", async () => {
  for (const vault of [null, {}, { root: "" }]) {
    await assert.rejects(() => readCanvasInRoot(vault, "Board.canvas"), (error) => {
      assert.equal(error.code, "CANVAS_PATH_INVALID");
      return true;
    });
  }
});

test("parseCanvasDocument pins desktop's node/edge model", () => {
  const parsed = parseCanvasDocument(JSON.stringify({
    nodes: [
      { id: "t", type: "text", x: 1, y: 2, width: 3, height: 4, text: "hello" },
      { id: "f", type: "file", x: 5, y: 6, width: 7, height: 8, file: "A.md", subpath: "#h" },
      { id: "g", type: "group", x: 0, y: 0, width: 10, height: 10, background: "#222" },
      { id: "l", type: "link", x: 0, y: 0, width: 10, height: 10, url: "https://example.com" },
      { id: "x", type: "video", x: 0, y: 0, width: 1, height: 1 },
      { id: "nogeo", type: "text", text: "no geometry" },
    ],
    edges: [
      { id: "e1", fromNode: "t", fromSide: "right", toNode: "f", toSide: "left", color: "#f00" },
      { id: "e2", fromNode: "t", fromSide: "sideways", toNode: "f", toSide: "left" },
      { id: "e3", fromNode: "t", fromSide: "top", toNode: "missing", toSide: "bottom" },
    ],
    version: "1.0-1.1",
  }));
  assert.deepEqual(parsed.nodes.map((node) => node.type), ["text", "file", "group", "link"]);
  assert.deepEqual(parsed.nodes[0], { id: "t", type: "text", x: 1, y: 2, width: 3, height: 4, text: "hello" });
  assert.deepEqual(parsed.nodes[1], { id: "f", type: "file", x: 5, y: 6, width: 7, height: 8, file: "A.md", subpath: "#h" });
  assert.deepEqual(parsed.nodes[2], { id: "g", type: "group", x: 0, y: 0, width: 10, height: 10, background: "#222" });
  assert.deepEqual(parsed.nodes[3], { id: "l", type: "link", x: 0, y: 0, width: 10, height: 10, url: "https://example.com" });
  // Only the four desktop node types with real geometry survive.
  assert.equal(parsed.nodes.length, 4);
  // Both endpoints keep their sides; an unknown side is dropped (nothing to place).
  // An edge naming a node that is not in the document stays in the DTO (the reader
  // is a faithful projection) and is dropped by the renderer - see
  // test/web-canvas-surface.test.js "an edge without both endpoints is dropped".
  assert.deepEqual(parsed.edges, [
    { id: "e1", fromNode: "t", fromSide: "right", toNode: "f", toSide: "left", color: "#f00" },
    { id: "e3", fromNode: "t", fromSide: "top", toNode: "missing", toSide: "bottom" },
  ]);
  // Unknown top-level keys survive as `unknownData` (desktop keeps them).
  assert.deepEqual(parsed.unknownData, { version: "1.0-1.1" });
});

test("a file without a nodes array is not a canvas (4xx, never a crash)", () => {
  for (const [label, raw, code] of [
    ["object without nodes", '{"edges":[]}', "not-a-canvas"],
    ["nodes is not an array", '{"nodes":{}}', "not-a-canvas"],
    ["unknown keys only", '{"version":"1.0"}', "not-a-canvas"],
    ["array payload", "[]", "invalid-json"],
    ["scalar payload", "42", "invalid-json"],
    ["null payload", "null", "invalid-json"],
    ["truncated json", '{"nodes":[', "invalid-json"],
    ["empty file", "", "invalid-json"],
  ]) {
    assert.throws(() => parseCanvasDocument(raw), (error) => {
      assert.ok(error instanceof CanvasDocumentError, `${label}: must be a CanvasDocumentError`);
      assert.equal(error.code, code, `${label}: ${error.message}`);
      return true;
    });
  }
  // The minimal valid document: an empty canvas is still a canvas.
  assert.deepEqual(parseCanvasDocument('{"nodes":[],"edges":[]}'), { nodes: [], edges: [] });
});
