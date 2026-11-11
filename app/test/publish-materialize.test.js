// Task 6: a note marked `publish: true` keeps its own address (one registry record), even
// inside a folder that is not published. The trigger is a note read, never a public read.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-publish-materialize-"));
const vaultRoot = path.join(root, "vault");
const data = path.join(root, "data");
await fs.mkdir(path.join(vaultRoot, "Free"), { recursive: true });
process.env.VAULT_PATH = vaultRoot;
process.env.DATA_PATH = data;
process.env.WEB_CATALOG_DIR = path.join(root, "catalog");
delete process.env.WEB_VAULTS_ROOT;

const { PublishService } = await import("../src/publish/service.js");
const { installNoteReadMaterializer, syncNotePublishRecord } = await import("../src/publish/materialize.js");
const { createVaultCatalogSource } = await import("../src/app/web-catalog/indexer.js");
const { closeWebCatalogRuntime, getWebCatalogRuntime } = await import("../src/app/web-catalog/runtime.js");
const { createWebAppRouter } = await import("../src/app/routes.js");

const service = new PublishService({ file: path.join(data, "publish", "materialize-state.json") });
const vault = { id: "default" };
const vaultObject = { id: "default", root: vaultRoot };
let publicId = null;

test.after(async () => {
  closeWebCatalogRuntime("default");
  await fs.rm(root, { recursive: true, force: true });
});

// Starts the real Web app so the record's address is fetched, not simulated.
async function fetchPublished() {
  const app = express();
  app.use(createWebAppRouter({ provider: { recordAudit() {} }, secureCookie: false, publishService: service }));
  const server = await new Promise((resolve) => {
    const listener = http.createServer(app).listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: (href) => fetch(`${base}${href}`), close: () => new Promise((resolve) => server.close(resolve)) };
}

test("a marked note gets one record and an address", async () => {
  await fs.writeFile(path.join(vaultRoot, "Free", "n.md"), "---\npublish: true\n---\n# n\n\nMATERIALIZED-BODY\n", "utf8");
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/n.md", data: { publish: true } }), "created");
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/n.md", data: { publish: true } }), "unchanged");
  const records = await service.list({ vaultIds: [vault.id] });
  assert.equal(records.filter((r) => r.path === "Free/n.md").length, 1);
  publicId = records.find((r) => r.path === "Free/n.md").id;
});

// Task 6, Important 2: a repeat ask over an already-recorded note writes no state file.
test("a second pass over a recorded note writes no state file", async () => {
  const saves = [];
  const original = service.save.bind(service);
  service.save = () => {
    saves.push(1);
    return original();
  };
  try {
    assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/n.md", data: { publish: true } }), "unchanged");
  } finally {
    delete service.save;
  }
  assert.equal(saves.length, 0, "an unchanged marker must not rewrite publish/state.json");
});

// Task 6, end-to-end: the synced record answers on its own address through the HTTP app.
test("the synced record answers 200 with the note content", async () => {
  const app = await fetchPublished();
  try {
    const response = await app.get(`/publish/${publicId}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /MATERIALIZED-BODY/);
  } finally {
    await app.close();
  }
});

// Task 6, Important 4: the record exists before this call, so "retired" must bite.
test("removing the marker retires the record and the address 404s", async () => {
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/n.md", data: { publish: false } }), "retired");
  assert.equal(await service.list({ vaultIds: [vault.id] }).then((r) => r.length), 0);
  const app = await fetchPublished();
  try {
    assert.equal((await app.get(`/publish/${publicId}`)).status, 404);
  } finally {
    await app.close();
  }
});

// C1: "none" is no opinion, not a retirement order. A note published through the Publish
// button or `manage_publish` has no `publish:` key, and a sweep must not delete its record.
test("a note without a marker keeps an explicit record through a sync", async () => {
  await fs.writeFile(path.join(vaultRoot, "Manual.md"), "# Manual\n\nMANUAL-BODY\n", "utf8");
  const published = await service.publish("default", "Manual.md");
  const saves = [];
  const original = service.save.bind(service);
  service.save = () => {
    saves.push(1);
    return original();
  };
  try {
    assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Manual.md", data: {} }), "unchanged");
  } finally {
    service.save = original;
  }
  assert.equal(saves.length, 0, "a missing marker writes no state file");
  const records = (await service.list({ vaultIds: [vault.id] })).filter((record) => record.path === "Manual.md");
  assert.equal(records.length, 1, "an explicit record survives the sweep");
  assert.equal(records[0].id, published.id);
  const app = await fetchPublished();
  try {
    const response = await app.get(`/publish/${published.id}`);
    assert.equal(response.status, 200, "the address still answers");
    assert.match(await response.text(), /MANUAL-BODY/);
  } finally {
    await app.close();
  }
});

// C1: the other half — "private" still retires, so the fix must not stop a real revocation.
test("publish: false retires the record and its address, and a missing marker does not", async () => {
  await fs.writeFile(path.join(vaultRoot, "Dropped.md"), "# Dropped\n\nDROPPED-BODY\n", "utf8");
  const first = await service.publish("default", "Dropped.md");
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Dropped.md", data: { publish: false } }), "retired");
  const app = await fetchPublished();
  try {
    assert.equal((await app.get(`/publish/${first.id}`)).status, 404, "a retired record answers 404");
    const second = await service.publish("default", "Dropped.md");
    assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Dropped.md", data: {} }), "unchanged");
    assert.equal((await app.get(`/publish/${second.id}`)).status, 200, "a missing marker is no revocation");
  } finally {
    await app.close();
  }
});

test("publish:false never creates a record", async () => {
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: "Free/m.md", data: { publish: false } }), "unchanged");
  const records = await service.list({ vaultIds: [vault.id], includeInactive: true });
  assert.deepEqual(records.filter((r) => r.path === "Free/m.md"), []);
});

test("a throwing note-read observer never fails the catalog read", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const source = createVaultCatalogSource({
      vaultRoot,
      stat: async () => ({ size: 0, mtimeMs: 0, ctimeMs: 0, ino: 0 }),
      readNote: async (absolute) => ({
        path: path.posix.basename(absolute),
        raw: "",
        content: "",
        frontmatter: {},
        revision: "sha256:x",
        stat: { size: 0, created: "1970-01-01T00:00:00.000Z", modified: "1970-01-01T00:00:00.000Z" },
      }),
      readBase: async () => ({}),
      toVaultPath: (absolute) => path.posix.basename(absolute),
      onNoteRead: () => {
        throw new Error("observer boom");
      },
    });
    const read = await source.read("n.md");
    assert.equal(read.path, "n.md");
  } finally {
    console.error = originalError;
  }
  assert.match(errors.join("\n"), /observer boom/);
});

// Task 6, Important 3: a read-only deployment installs no observer, so indexing writes nothing.
test("a read-only deployment indexes a marked note and writes no record", async () => {
  await fs.mkdir(path.join(vaultRoot, "Marked"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Marked", "r.md"), "---\npublish: true\n---\n# r\n\nINDEXED-BODY\n", "utf8");
  assert.equal(installNoteReadMaterializer({ service, readOnly: true }), false);
  const runtime = getWebCatalogRuntime(vaultObject, { startReconcile: false });
  await runtime.drain();
  assert.deepEqual(
    (await service.list({ vaultIds: [vault.id], includeInactive: true })).filter((record) => record.path === "Marked/r.md"),
    [],
  );
  // The catalog itself still indexed the note: only the publish record is absent.
  assert.equal(runtime.store.locate("Marked/r.md").path, "Marked/r.md");
});

test("an installed observer records a marked note during indexing, and its address serves it", async () => {
  // A new file: the reconcile re-reads a changed note only, and the observer is the read hook.
  await fs.writeFile(path.join(vaultRoot, "Marked", "s.md"), "---\npublish: true\n---\n# s\n\nINDEXED-BODY\n", "utf8");
  assert.equal(installNoteReadMaterializer({ service, readOnly: false }), true);
  const runtime = getWebCatalogRuntime(vaultObject, { startReconcile: false });
  await runtime.drain();
  const record = (await service.list({ vaultIds: [vault.id] })).find((r) => r.path === "Marked/s.md");
  assert.ok(record, "indexing a publish:true note must give it a record");
  const app = await fetchPublished();
  try {
    const response = await app.get(`/publish/${record.id}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /INDEXED-BODY/);
  } finally {
    await app.close();
  }
});

test("a folder record that shares the note's stem survives a retire", async () => {
  // Ruling I1: the sync states `kind: "document"`. A folder published as `Stem` must not be
  // revoked while the note `Stem.md` loses its own record.
  const notePath = "Stem.md";
  await fs.writeFile(path.join(vaultRoot, notePath), "---\npublish: true\n---\nbody\n", "utf8");
  assert.equal(await syncNotePublishRecord({ service, vault, relPath: notePath, data: { publish: true } }), "created");
  await fs.mkdir(path.join(vaultRoot, "Stem"), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, "Stem", "inner.md"), "body\n", "utf8");
  const folder = await service.publish(vault.id, "Stem", { kind: "folder" });

  assert.equal(await syncNotePublishRecord({ service, vault, relPath: notePath, data: { publish: false } }), "retired");
  const records = await service.list({ vaultIds: [vault.id] });
  assert.equal(records.some((item) => item.path === notePath), false, "the note record is gone");
  assert.ok(await service.resolve(folder.id), "the folder record and its address survive");
});
