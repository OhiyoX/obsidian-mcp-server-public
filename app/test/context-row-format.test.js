// Row-format contract for the note-context link lists (U2 desktop parity).
//
// Desktop renders a link row as: chain icon + full vault-relative path (allowed to
// wrap) + a muted parent-directory subline. This file pins that shape for both link
// views and for the unlinked-mention chip so the three surfaces cannot drift apart.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { createOutgoingLinks } from "../frontend/app/features/context/outgoing.js";
import { createIncomingLinks } from "../frontend/app/features/context/incoming.js";
import { parentDirOf, rowContent, rowTitle, stripNoteExtension } from "../frontend/app/features/context/row.js";

const dom = createDomHarness();
dom.install();

const ICON_HREF = "/app/assets/icons.svg#link";

function hostFixture(id) {
  const host = dom.createElement("nav");
  host.id = id;
  return host;
}

test("parentDirOf returns the parent directory or null for a root-level path", () => {
  assert.equal(parentDirOf("_Workspace/30-Knowledge/Obsidian/Note.md"), "_Workspace/30-Knowledge/Obsidian");
  assert.equal(parentDirOf("Note.md"), null);
  assert.equal(parentDirOf("https://example.com/x"), "https://example.com");
  assert.equal(parentDirOf(""), null);
  assert.equal(stripNoteExtension("_Workspace/Sub/Note.md"), "_Workspace/Sub/Note");
  assert.equal(stripNoteExtension("images/pixel.png"), "images/pixel.png");
});

test("an outgoing note row is icon + full path + parent subline", async () => {
  const host = hostFixture("outgoing-list");
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({
      links: [{ target: "Note", kind: "note", resolvedPath: "_Workspace/Sub/Note.md", alias: "别名", heading: null }],
    }),
  });
  await controller.setDocument({ path: "Target.md" });
  const row = host.querySelectorAll(".outgoing-item")[0];
  assert.equal(row.querySelector("use").getAttribute("href"), ICON_HREF);
  assert.equal(row.querySelector(".outgoing-row-path").textContent, "_Workspace/Sub/Note");
  assert.equal(row.querySelector(".context-row-parent").textContent, "_Workspace/Sub");
  // The alias left the visible text when the row became the full path (U2); it now
  // lives in the tooltip only, so the alias never renders as the row label.
  assert.equal(row.title, "别名 (_Workspace/Sub/Note.md)");
  assert.equal(row.querySelector(".outgoing-row-path").textContent.includes("别名"), false);
});

test("an outgoing row without an alias keeps the path as its tooltip", async () => {
  const host = hostFixture("outgoing-list");
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({
      links: [
        { target: "Note", kind: "note", resolvedPath: "_Workspace/Sub/Note.md", alias: null, heading: null },
        { target: "https://example.com/a", kind: "external", resolvedPath: null, alias: null, heading: null },
      ],
    }),
  });
  await controller.setDocument({ path: "Target.md" });
  const rows = host.querySelectorAll(".outgoing-item");
  assert.equal(rows[0].title, "_Workspace/Sub/Note.md");
  assert.equal(rows[1].title, "https://example.com/a");
  // A blank alias is not an alias: the tooltip stays the path, never `" (…)`.
  assert.equal(rowTitle("_Workspace/Sub/Note.md", "   "), "_Workspace/Sub/Note.md");
  assert.equal(rowTitle("_Workspace/Sub/Note.md", null), "_Workspace/Sub/Note.md");
  assert.equal(rowTitle("Other.md", "别名"), "别名 (Other.md)");
});

test("an outgoing external row keeps the URL and has no parent subline", async () => {
  const host = hostFixture("outgoing-list");
  const controller = createOutgoingLinks({
    host,
    fetchOutgoing: async () => ({
      links: [{ target: "https://example.com/a/b", kind: "external", resolvedPath: null, alias: "站点", heading: null }],
    }),
  });
  await controller.setDocument({ path: "Target.md" });
  const row = host.querySelectorAll(".outgoing-item")[0];
  assert.equal(row.querySelector("use").getAttribute("href"), ICON_HREF);
  assert.equal(row.querySelector(".outgoing-row-path").textContent, "https://example.com/a/b");
  assert.equal(row.querySelector(".context-row-parent"), null);
});

test("an incoming row is icon + full source path + parent subline", async () => {
  const host = hostFixture("incoming-list");
  const controller = createIncomingLinks({
    host,
    fetchIncoming: async () => ({ links: [{ sourcePath: "_Workspace/Sub/Source.md", target: "Target", alias: null, heading: null }] }),
  });
  await controller.setDocument({ path: "Target.md" });
  const row = host.querySelectorAll(".incoming-item")[0];
  assert.equal(row.querySelector("use").getAttribute("href"), ICON_HREF);
  assert.equal(row.querySelector(".incoming-row-path").textContent, "_Workspace/Sub/Source");
  assert.equal(row.querySelector(".context-row-parent").textContent, "_Workspace/Sub");
});

test("rowContent omits the subline when a row has no parent", () => {
  const parts = rowContent(dom.document, { text: "Note.md" });
  const body = parts.find((part) => part.classList?.contains("context-row-body"));
  assert.equal(body.querySelector?.(".context-row-parent") ?? null, null);
});
