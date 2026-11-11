// Task 8 (2026-11-08 folder publish) — the four surfaces of one folder record:
// the MCP tool, the Web route, the Admin list and the `published:` search filter.
//
// The rules this file pins:
//   * one public-path builder (`publicPathOf`): a folder record's address is `/publish/d/<id>`,
//     a document record's is `/publish/<id>`; the Web route and the MCP tool agree;
//   * `published=true` in a search filter matches the notes a published folder lists, and a
//     `publish: false` note inside it stays outside the set;
//   * the folder caps answer 413 (`publish_folder_too_large` / `publish_folder_too_deep`);
//   * the Admin list names the record kind and links a folder to its own address.
//
// The Web surface runs over real HTTP (the shared A4 harness), so the pins are the wire
// shapes a user gets, not the handler internals.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ensureFixture,
  cleanup,
} from "./helpers/publish-surface-harness.js";

test.after(cleanup);

const fixtures = await ensureFixture();
const { service } = fixtures;

// Imported after the harness set VAULT_PATH / DATA_PATH: `config.js` reads both at load.
const [{ publicPathOf }, { resolvePublishedPaths }, { classifyWebApiError }, { PUBLISH_FOLDER_TOO_DEEP, PUBLISH_FOLDER_TOO_LARGE }] = await Promise.all([
  import("../src/publish/service.js"),
  import("../src/app/web-catalog/search-api.js"),
  import("../src/app/web-api-error.js"),
  import("../src/publish/target.js"),
]);

// A published folder with one visible note, one `publish: false` note and one draft subtree.
async function seedFolder(name) {
  await fs.mkdir(path.join(fixtures.vault, name, "_drafts"), { recursive: true });
  await fs.writeFile(path.join(fixtures.vault, name, "a.md"), "# A\n", "utf8");
  await fs.writeFile(path.join(fixtures.vault, name, "b.md"), "---\npublish: false\n---\n# B\n", "utf8");
  await fs.writeFile(path.join(fixtures.vault, name, "_drafts", "c.md"), "# C\n", "utf8");
  return name;
}

test("publicPathOf picks the address shape from the record kind", () => {
  assert.equal(publicPathOf({ id: "x", kind: "document" }), "/publish/x");
  assert.equal(publicPathOf({ id: "y", kind: "folder" }), "/publish/d/y");
});

test("published=true matches the notes a published folder lists", async () => {
  const folder = await seedFolder("Search");
  await service.publish("default", folder, { kind: "folder" });
  const paths = await resolvePublishedPaths(service, "default");
  assert.ok(paths.has("Search/a.md"), "a visible folder member counts as published");
  assert.ok(paths.has("Search"), "the folder record itself counts");
  assert.equal(paths.has("Search/b.md"), false, "a publish:false note does not");
  assert.equal(paths.has("Search/_drafts/c.md"), false, "a draft subtree is not inherited");
});

test("the Web route publishes a folder and advertises its folder address", async () => {
  const folder = await seedFolder("Route");
  const published = await fixtures.web.post({ action: "publish", path: folder, kind: "folder" });
  assert.equal(published.status, 200, published.text);
  assert.equal(published.json.published, true);
  assert.match(published.json.publicPath, /^\/publish\/d\/[A-Za-z0-9_-]{43}$/, "a folder address carries the /d/ prefix");
  assert.ok(published.json.publicUrl.endsWith(published.json.publicPath));

  const id = published.json.publicPath.split("/").pop();
  const index = await fetch(`${fixtures.web.base}/publish/d/${id}`);
  assert.equal(index.status, 200, "the advertised address answers");

  const revoked = await fixtures.web.post({ action: "revoke", path: folder, kind: "folder" });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(revoked.json.revoked, true, "a folder record is revocable from the Web route");
});

test("a document record keeps the document address on both surfaces", async () => {
  const published = await fixtures.web.post({ action: "publish", path: "Notes/ok.md" });
  assert.equal(published.status, 200, published.text);
  assert.match(published.json.publicPath, /^\/publish\/[A-Za-z0-9_-]{43}$/);
});

test("the folder caps answer 413 with their named code", async () => {
  for (const code of [PUBLISH_FOLDER_TOO_LARGE, PUBLISH_FOLDER_TOO_DEEP]) {
    const mapped = classifyWebApiError(Object.assign(new Error("refused"), { code }));
    assert.equal(mapped.status, 413, `${code} must be a 413`);
    assert.equal(mapped.code, code);
  }
  // End to end over the Web route: depth 9 is past the cap, so the publish is refused and
  // nothing is recorded.
  let deep = "WebTooDeep";
  for (let level = 1; level <= 9; level += 1) deep = `${deep}/D${level}`;
  await fs.mkdir(path.join(fixtures.vault, deep), { recursive: true });
  await fs.writeFile(path.join(fixtures.vault, deep, "deep.md"), "# Deep\n", "utf8");
  const refused = await fixtures.web.post({ action: "publish", path: "WebTooDeep", kind: "folder" });
  assert.equal(refused.status, 413, refused.text);
  assert.equal(refused.json.code, PUBLISH_FOLDER_TOO_DEEP);
});

test("the MCP tool accepts a folder and its payload carries the folder path", async () => {
  const folder = await seedFolder("Tool");
  const { registerPublishTools } = await import("../src/tools/publish.js");
  const tools = new Map();
  registerPublishTools({ registerTool: (name, _descriptor, handler) => tools.set(name, handler) });
  const call = (name, args) => tools.get(name)(args, { authInfo: { clientId: "task-8" } });

  const published = await call("manage_publish", { action: "publish", path: folder, kind: "folder" });
  assert.equal(published.isError, undefined, JSON.stringify(published));
  assert.equal(published.structuredContent.kind, "folder");
  assert.match(published.structuredContent.publicPath, /^\/publish\/d\/[A-Za-z0-9_-]{43}$/);

  const status = await call("get_publish_status", { path: folder });
  assert.equal(status.structuredContent.kind, "folder", "the status tool names the record kind");
  assert.equal(status.structuredContent.publicPath, published.structuredContent.publicPath);
});

test("the MCP tool reports a folder cap refusal with its named code", async () => {
  // depth 9 inside the published root is past the depth cap (8), so the walk refuses.
  let deep = "TooDeep";
  for (let level = 1; level <= 9; level += 1) deep = `${deep}/D${level}`;
  await fs.mkdir(path.join(fixtures.vault, deep), { recursive: true });
  await fs.writeFile(path.join(fixtures.vault, deep, "deep.md"), "# Deep\n", "utf8");
  const { registerPublishTools } = await import("../src/tools/publish.js");
  const tools = new Map();
  registerPublishTools({ registerTool: (name, _descriptor, handler) => tools.set(name, handler) });
  const refused = await tools.get("manage_publish")({ action: "publish", path: "TooDeep", kind: "folder" }, { authInfo: { clientId: "task-8" } });
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.equal(refused.structuredContent.code, PUBLISH_FOLDER_TOO_DEEP);
});

test("the Admin list names the kind and links a folder to its folder address", async () => {
  const [{ renderPublishesPage }] = await Promise.all([import("../src/admin/pages/publishes.js")]);
  const folder = await seedFolder("Admin");
  const record = await service.publish("default", folder, { kind: "folder" });
  const page = renderPublishesPage({
    publications: [record],
    query: {},
    csrf: "csrf",
    publicBaseUrl: "https://publish.example",
    model: { vaultLabel: () => "Default", client: () => null },
  });
  assert.match(page.content, /\/publish\/d\//, "the Admin link uses the folder address shape");
  assert.doesNotMatch(page.content, new RegExp(`/publish/${record.id}`), "the document shape is never advertised for a folder");
  assert.match(page.content, /文件夹/, "the default locale names the record kind");
});

test("the explorer menu offers the two publish entries for a folder row only", async () => {
  const [{ createDomHarness }, { createExplorerContextMenu }] = await Promise.all([
    import("./helpers/base-dom.mjs"),
    import("../frontend/app/features/explorer/context-menu.js"),
  ]);
  const local = createDomHarness();
  local.install();
  local.document.defaultView = { MouseEvent: class {}, KeyboardEvent: class {} };
  const host = local.createElement("div");
  host.className = "tree";
  local.document.body.append(host);
  const folderRow = local.document.createElement("div");
  folderRow.className = "tree-folder-row";
  folderRow.dataset.folderPath = "Dir";
  folderRow.setAttribute("data-folder-path", "Dir");
  const noteRow = local.document.createElement("button");
  noteRow.className = "note";
  noteRow.dataset.path = "Dir/a.md";
  noteRow.setAttribute("data-path", "Dir/a.md");
  host.append(folderRow, noteRow);
  const menu = createExplorerContextMenu({ host, documentRef: local.document, windowRef: local.document.defaultView });

  assert.equal(menu.openFor({ kind: "folder", path: "Dir" }), true);
  assert.equal(menu.itemFor("publishFolder").hidden, false, "a folder row can be published");
  assert.equal(menu.itemFor("unpublishFolder").hidden, false);
  menu.close({ returnFocus: false });

  assert.equal(menu.openFor({ kind: "note", path: "Dir/a.md" }), true);
  assert.equal(menu.itemFor("publishFolder").hidden, true, "a note keeps its own Publish button");
  menu.destroy();
});
