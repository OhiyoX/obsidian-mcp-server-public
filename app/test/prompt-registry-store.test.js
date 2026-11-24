// P1 Task 2: durable packs, the atomic head, and what a crash at each step leaves
// behind. Every failure case asserts the same two things: the previous revision is
// still what the server serves, and the head file on disk is untouched.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPromptRegistryStore } from "../src/prompt-registry/store.js";
import { bundledBasePack } from "../src/prompt-registry/bundled.js";

const bundled = bundledBasePack();
const firstKey = Object.keys(bundled.values).sort()[0];

const candidates = [];
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-store-"));
  candidates.push(root);
  return { root, headFile: path.join(root, "agent-prompts.json"), packsDir: path.join(root, "packs") };
}

test.after(async () => {
  await Promise.all(candidates.map((root) => fs.rm(root, { recursive: true, force: true })));
});

function packWith(text) {
  return { values: { ...bundled.values, [firstKey]: text } };
}

/** An io wrapper that fails at one chosen step, to sit on each boundary in turn. */
function failingIo(step) {
  let writes = 0;
  return {
    mkdir: (...args) => fs.mkdir(...args),
    stat: (...args) => fs.stat(...args),
    readFile: (...args) => fs.readFile(...args),
    open: async (...args) => {
      const handle = await fs.open(...args);
      return {
        writeFile: async (...rest) => {
          writes += 1;
          if (step === "pack-write" && writes === 1) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          if (step === "head-write" && writes === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return handle.writeFile(...rest);
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    rename: async (from, to) => {
      if (step === "head-rename" && to.endsWith("agent-prompts.json")) throw new Error("rename failed");
      return fs.rename(from, to);
    },
  };
}

test("a missing head serves the bundled Base at revision 0", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  const status = store.status();
  assert.equal(status.status, "bootstrap");
  assert.equal(status.revision, 0);
  assert.equal(status.baseDigest, bundled.digest);
  assert.equal(status.overrideCount, 0);
  assert.equal(store.snapshot().values[firstKey], bundled.values[firstKey]);
});

test("a published Base survives a new store instance", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  const published = await store.commitBase({ expectedRevision: 0, pack: packWith("published text"), reason: "unit", sourceCommit: "abc123" });
  assert.equal(published.ok, true);
  assert.equal(published.revision, 1);
  assert.equal((await fs.readFile(headFile, "utf8")).includes("published text"), false, "the head points at a pack, it does not hold text");

  const reopened = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await reopened.ready;
  assert.equal(reopened.status().status, "ready");
  assert.equal(reopened.snapshot().revision, 1);
  assert.equal(reopened.snapshot().values[firstKey], "published text");
  assert.equal(reopened.status().drift, true, "a published Base differs from the bundled one");
});

test("a failed pack write leaves revision 0 and writes no head", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled, io: failingIo("pack-write") });
  await store.ready;
  const result = await store.commitBase({ expectedRevision: 0, pack: packWith("never visible"), reason: "unit" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROMPT_STORE_IO");
  assert.equal(store.snapshot().revision, 0);
  await assert.rejects(fs.stat(headFile));
});

test("a failed head write keeps the previous head and snapshot", async () => {
  const { headFile, packsDir } = await workspace();
  const good = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await good.ready;
  assert.equal((await good.commitBase({ expectedRevision: 0, pack: packWith("first"), reason: "unit" })).ok, true);
  const before = await fs.readFile(headFile, "utf8");

  const failing = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled, io: failingIo("head-write") });
  await failing.ready;
  const result = await failing.commitBase({ expectedRevision: 1, pack: packWith("second"), reason: "unit" });
  assert.equal(result.ok, false);
  assert.equal(failing.snapshot().values[firstKey], "first", "the served text is still revision 1");
  assert.equal(failing.snapshot().revision, 1);
  assert.equal(await fs.readFile(headFile, "utf8"), before);
});

test("a failed head rename keeps the previous head and snapshot", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled, io: failingIo("head-rename") });
  await store.ready;
  const result = await store.commitBase({ expectedRevision: 0, pack: packWith("nope"), reason: "unit" });
  assert.equal(result.ok, false);
  assert.equal(store.snapshot().revision, 0);
});

test("a stale expectedRevision is refused without touching anything", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  assert.equal((await store.commitBase({ expectedRevision: 0, pack: packWith("one"), reason: "unit" })).ok, true);
  const second = await store.commitBase({ expectedRevision: 0, pack: packWith("two"), reason: "unit" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "PROMPT_STALE_REVISION");
  assert.equal(store.snapshot().values[firstKey], "one");
});

test("a pack without every Base key or with a wrong digest is refused", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  const incomplete = { values: { [firstKey]: "only one" } };
  assert.equal((await store.commitBase({ expectedRevision: 0, pack: incomplete, reason: "unit" })).code, "PROMPT_INVALID_PACK");

  const forged = { values: { ...bundled.values, [firstKey]: "text" }, digest: "sha256:0000" };
  assert.equal((await store.commitBase({ expectedRevision: 0, pack: forged, reason: "unit" })).code, "PROMPT_INVALID_PACK");
  assert.equal(store.snapshot().revision, 0);
});

test("a corrupt head degrades to the bundled Base and is not overwritten", async () => {
  const { headFile, packsDir } = await workspace();
  await fs.mkdir(path.dirname(headFile), { recursive: true });
  await fs.writeFile(headFile, "{ not json");
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  assert.equal(store.status().status, "degraded");
  assert.equal(store.status().reasonCode, "head-invalid-json");
  assert.equal(store.snapshot().values[firstKey], bundled.values[firstKey]);
  assert.equal(await fs.readFile(headFile, "utf8"), "{ not json", "the broken file stays for repair");
});

test("a head whose pack is gone degrades instead of pretending it is ready", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  await store.commitBase({ expectedRevision: 0, pack: packWith("gone soon"), reason: "unit" });
  const head = JSON.parse(await fs.readFile(headFile, "utf8"));
  await fs.rm(path.join(packsDir, `${head.base.packDigest.replace("sha256:", "")}.json`));

  const reopened = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await reopened.ready;
  assert.equal(reopened.status().status, "degraded");
  assert.equal(reopened.status().reasonCode, "pack-missing");
  assert.equal(reopened.snapshot().revision, 1, "the revision is still reported");
  assert.equal(reopened.snapshot().values[firstKey], bundled.values[firstKey], "text falls back to the bundled pack");
});

test("a pack that a newer schema cannot read degrades rather than half-loading", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  await store.commitBase({ expectedRevision: 0, pack: packWith("readable now"), reason: "unit" });
  const head = JSON.parse(await fs.readFile(headFile, "utf8"));
  const file = path.join(packsDir, `${head.base.packDigest.replace("sha256:", "")}.json`);
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  delete stored.values["tools.canonical.get_note.description"];
  await fs.writeFile(file, JSON.stringify(stored));

  const reopened = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await reopened.ready;
  assert.equal(reopened.status().status, "degraded");
  assert.equal(reopened.status().reasonCode, "pack-incomplete");
});

test("rollback publishes the target pack as a new revision", async () => {
  const { headFile, packsDir } = await workspace();
  const store = createPromptRegistryStore({ headFile, packsDir, bundledBase: bundled });
  await store.ready;
  const one = await store.commitBase({ expectedRevision: 0, pack: packWith("one"), reason: "unit" });
  await store.commitBase({ expectedRevision: one.revision, pack: packWith("two"), reason: "unit" });
  const rolled = await store.rollback({ expectedRevision: 2, targetRevision: 1, reason: "unit" });
  assert.equal(rolled.ok, true);
  assert.equal(rolled.revision, 3, "rollback counts forward, it does not rewind the counter");
  assert.equal(store.snapshot().values[firstKey], "one");
  assert.equal((await store.rollback({ expectedRevision: 3, targetRevision: 99, reason: "unit" })).code, "PROMPT_UNKNOWN_REVISION");
});

test("a pack with a key this image does not have is refused", async () => {
  const space = await workspace();
  const store = createPromptRegistryStore({ ...space, bundledBase: bundled });
  await store.ready;
  const pack = { values: { ...bundled.values, "tools.canonical.ghost.description": "invented copy" } };
  const result = await store.commitBase({ expectedRevision: 0, pack, reason: "unit" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROMPT_INVALID_PACK");
  assert.match(result.detail, /unknown key/);
  assert.equal(store.status().revision, 0);
});

test("a promoted override is dropped only when the new Base already carries that text", async () => {
  const space = await workspace();
  const store = createPromptRegistryStore({ ...space, bundledBase: bundled });
  await store.ready;
  const target = "tools.canonical.get_note.description";
  const published = await store.commitOverrides({
    expectedRevision: 0,
    nextOverrides: { [target]: "published override text" },
    reason: "unit",
  });
  assert.equal(published.ok, true);

  const wrong = await store.commitBase({
    expectedRevision: 1,
    pack: { values: { ...bundled.values, [target]: "a different base text" } },
    reason: "unit",
    resetOverriddenKeys: [target],
    expectedOverrideValues: { [target]: "published override text" },
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "PROMPT_OVERRIDE_MISMATCH");
  assert.equal(store.snapshot().values[target], "published override text", "nothing changed");

  const right = await store.commitBase({
    expectedRevision: 1,
    pack: { values: { ...bundled.values, [target]: "published override text" } },
    reason: "unit",
    resetOverriddenKeys: [target],
    expectedOverrideValues: { [target]: "published override text" },
  });
  assert.equal(right.ok, true);
  assert.equal(store.snapshot().overrideCount, 0);
  assert.equal(store.snapshot().values[target], "published override text", "same text, now from the Base");
});

test("a hand-edited head with an orphan override degrades instead of failing every request", async () => {
  const space = await workspace();
  await fs.mkdir(space.packsDir, { recursive: true });
  const digest = bundled.digest;
  await fs.writeFile(
    path.join(space.packsDir, `${digest.replace(/^sha256:/, "")}.json`),
    JSON.stringify({ digest, values: bundled.values }),
  );
  await fs.writeFile(
    space.headFile,
    JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      base: { revision: 4, packDigest: digest },
      runtime: { revision: 0, overrides: { "tools.canonical.not_a_tool.description": "orphan" }, tuning: {} },
      history: [],
    }),
  );
  const store = createPromptRegistryStore({ ...space, bundledBase: bundled });
  await store.ready;
  const status = store.status();
  assert.equal(status.status, "ready", "the Base still loads");
  assert.equal(store.snapshot().ignoredOverrideKeys.length, 1);
  assert.equal(store.snapshot().overrideCount, 0);
  assert.ok(store.snapshot().values["tools.canonical.get_note.description"].length > 0);
});
