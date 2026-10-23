import assert from "node:assert/strict";
import test from "node:test";
import { resolveLinkPath } from "../src/obsidian.js";
import { createLinkResolver } from "../src/vault-index.js";

const records = [
  { path: "Projects/Alpha.md", basename: "Alpha", aliases: ["Project A"] },
  { path: "Archive/Alpha.md", basename: "Alpha", aliases: [] },
  { path: "Root.md", basename: "Root", aliases: ["Home"] },
  { path: "Projects/Version 1.2.md", basename: "Version 1.2", aliases: [] },
  { path: "Projects/Runbook.conf.md", basename: "Runbook.conf", aliases: [] },
  { path: "Deployment/2026-09-25 v2026.09.25.11 发布与 NAS 部署.md", basename: "2026-09-25 v2026.09.25.11 发布与 NAS 部署", aliases: [] },
];
const resolve = createLinkResolver(records);

test("link resolver prefers a same-directory basename", () => {
  const result = resolve({ target: "Alpha", type: "wiki" }, "Projects/Source.md");
  assert.equal(result.path, "Projects/Alpha.md");
  assert.equal(result.status, "resolved");
});

test("link resolver supports aliases", () => {
  const result = resolve({ target: "Home", type: "wiki" }, "Projects/Source.md");
  assert.equal(result.path, "Root.md");
  assert.equal(result.status, "resolved");
});

test("link resolver handles relative Markdown links", () => {
  const result = resolve({ target: "../Root.md", type: "markdown" }, "Projects/Source.md");
  assert.equal(result.path, "Root.md");
});

test("link resolver reports unresolved targets", () => {
  const result = resolve({ target: "Missing", type: "wiki" }, "Projects/Source.md");
  assert.equal(result.status, "unresolved");
  assert.deepEqual(result.candidates, []);
});

test("link resolver searches ancestor directories for explicit paths", () => {
  const extended = createLinkResolver([...records, { path: "Projects/Guides/README.md", basename: "README", aliases: [] }]);
  const result = extended({ target: "Guides/README", type: "wiki" }, "Projects/Deep/Source.md");
  assert.equal(result.status, "resolved");
  assert.equal(result.path, "Projects/Guides/README.md");
});

test("link resolver classifies non-note targets as attachments", () => {
  const result = resolve({ target: "/etc/nginx/site.conf", type: "markdown" }, "Projects/Source.md");
  assert.equal(result.status, "attachment");
});

test("link resolver treats a numeric suffix as part of a note basename", () => {
  const result = resolve({ target: "Version 1.2", type: "wiki" }, "Projects/Source.md");
  assert.equal(result.status, "resolved");
  assert.equal(result.path, "Projects/Version 1.2.md");
});

test("link resolver resolves a dotted deployment title before attachment classification", () => {
  const result = resolve(
    { target: "Deployment/2026-09-25 v2026.09.25.11 发布与 NAS 部署", type: "wiki" },
    "Deployment/README.md",
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.path, "Deployment/2026-09-25 v2026.09.25.11 发布与 NAS 部署.md");
});

test("link resolver lets an existing Markdown note win over an extension-like basename", () => {
  const result = resolve({ target: "Runbook.conf", type: "wiki" }, "Projects/Source.md");
  assert.equal(result.status, "resolved");
  assert.equal(result.path, "Projects/Runbook.conf.md");
});

test("link path metadata appends Markdown to numeric suffixes", () => {
  assert.equal(resolveLinkPath("Version 1.2", "Projects/Source.md"), "Projects/Version 1.2.md");
});

test("link path metadata preserves nonnumeric attachment extensions", () => {
  assert.equal(resolveLinkPath("diagram.png", "Projects/Source.md"), "Projects/diagram.png");
});

const dottedRecords = [
  { path: "Dotted/note.v1.md", basename: "note.v1", aliases: [] },
  { path: "Dotted/note.v2026.09.25.12.md", basename: "note.v2026.09.25.12", aliases: [] },
  { path: "Dotted/note.with.dots.md", basename: "note.with.dots", aliases: [] },
];
const resolveDotted = createLinkResolver(dottedRecords);

test("link resolver resolves extension-like dotted note basenames before attachments", () => {
  for (const name of ["note.v1", "note.v2026.09.25.12", "note.with.dots"]) {
    const result = resolveDotted({ target: `Dotted/${name}`, type: "wiki" }, "Dotted/README.md");
    assert.equal(result.status, "resolved", name);
    assert.equal(result.path, `Dotted/${name}.md`, name);
    assert.deepEqual(result.candidates, [`Dotted/${name}.md`], name);
  }
});

test("link resolver still classifies real attachments after dotted note lookup", () => {
  for (const name of ["diagram.png", "archive.zip", "note.v1.png", "release.tar.gz"]) {
    const result = resolveDotted({ target: name, type: "wiki" }, "Dotted/README.md");
    assert.equal(result.status, "attachment", name);
    assert.deepEqual(result.candidates, [], name);
  }
});

test("link resolver prefers the same-directory dotted note over a duplicate basename", () => {
  const extended = createLinkResolver([...dottedRecords, { path: "Other/note.with.dots.md", basename: "note.with.dots", aliases: [] }]);
  const result = extended({ target: "note.with.dots", type: "wiki" }, "Dotted/README.md");
  assert.equal(result.status, "resolved");
  assert.equal(result.path, "Dotted/note.with.dots.md");
});
