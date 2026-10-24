import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Environment must be configured before importing config/vault modules.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-context-security-"));
const vault = path.join(root, "vault");
const outside = path.join(root, "outside");
const data = path.join(root, "data");
process.env.VAULT_PATH = vault;
process.env.DATA_PATH = data;
process.env.HISTORY_PATH = path.join(data, "history");
process.env.RETRIEVAL_INDEX_PATH = path.join(data, "index", "retrieval-index.json");
process.env.RETRIEVAL_AUTO_EMBED = "false";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.GIT_ENABLED = "false";
process.env.MAX_READ_BYTES = "64kb";

const EXTERNAL_MARKER = "EXTERNAL_SECRET_MUST_NOT_BE_READ";
const INSIDE_BODY = "# Inside\n\ninside body only\n";

await fs.mkdir(vault, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.writeFile(path.join(outside, "secret.md"), `# Outside\n\n${EXTERNAL_MARKER}\n`, "utf8");
await fs.writeFile(path.join(vault, "Inside.md"), INSIDE_BODY, "utf8");
await fs.writeFile(path.join(vault, "Oversized.md"), `# Oversized\n\n${"z".repeat(100 * 1024)}\n`, "utf8");

const { buildNoteContext } = await import("../src/context-service.js");
const { getVaultIndex } = await import("../src/vault-index.js");
const { readFileWithinCap } = await import("../src/bounded-read.js");
const { readLimitedText } = await import("../src/vault.js");

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// Creates a symlink or, only on Windows where the privilege is unavailable,
// marks the test skipped with an explicit reason. Directory junctions need no
// Windows privilege, so the intermediate-directory escape is still exercised
// there; anywhere else a failure is a real failure so Linux CI must actually
// exercise the escape.
async function symlinkOrSkip(t, target, linkPath, type) {
  const attempts = process.platform === "win32" && type === "dir" ? ["dir", "junction"] : [type];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      await fs.symlink(target, linkPath, attempt);
      return true;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error.code)) throw error;
    }
  }
  t.skip(`symlink privilege unavailable on Windows: ${lastError?.code}`);
  return false;
}

// Records every stat/open/read/lstat for the watched paths. `assertCanonicalInsideVault`
// resolves with realpath (the security primitive), which must never read or
// stat external content, so a non-empty list proves an escape.
function installFsSpy(watchedPaths) {
  const watched = new Set(watchedPaths.map(String));
  const touched = [];
  const original = { stat: fs.stat, open: fs.open, readFile: fs.readFile, lstat: fs.lstat };
  const record = (op) => async (target, ...rest) => {
    if (watched.has(String(target))) touched.push({ op, target: String(target) });
    return original[op].call(fs, target, ...rest);
  };
  fs.stat = record("stat");
  fs.open = record("open");
  fs.readFile = record("readFile");
  fs.lstat = record("lstat");
  return {
    touched,
    restore() {
      fs.stat = original.stat;
      fs.open = original.open;
      fs.readFile = original.readFile;
      fs.lstat = original.lstat;
    },
  };
}

test("a final-name symlink that escapes the vault is rejected before any external stat/read", async (t) => {
  const linkPath = path.join(vault, "Escape.md");
  if (!(await symlinkOrSkip(t, path.join(outside, "secret.md"), linkPath, "file"))) return;
  const spy = installFsSpy([linkPath, path.join(outside, "secret.md")]);
  try {
    await assert.rejects(
      () => buildNoteContext({ path: "Escape", includeBacklinks: false }),
      (error) => {
        assert.match(error.message, /escapes the vault/i);
        assert.equal(String(error.message).includes(EXTERNAL_MARKER), false);
        return true;
      },
    );
    assert.deepEqual(spy.touched, [], "no external stat/open/read may run for an escaping final-name symlink");
  } finally {
    spy.restore();
  }
});

test("an intermediate directory symlink that escapes the vault is rejected before any external stat/read", async (t) => {
  const linkDir = path.join(vault, "EscapeDir");
  if (!(await symlinkOrSkip(t, outside, linkDir, "dir"))) return;
  const watched = [linkDir, path.join(linkDir, "secret.md"), path.join(outside, "secret.md")];
  const spy = installFsSpy(watched);
  try {
    await assert.rejects(
      () => buildNoteContext({ path: "EscapeDir/secret", includeBacklinks: false }),
      /escapes the vault/i,
    );
    assert.deepEqual(spy.touched, [], "no external stat/open/read may run for an escaping directory symlink");
  } finally {
    spy.restore();
  }
});

test("a missing note under an escaping directory symlink is rejected, not treated as not_found", async (t) => {
  const linkDir = path.join(vault, "EscapeDirMissing");
  if (!(await symlinkOrSkip(t, outside, linkDir, "dir"))) return;
  const spy = installFsSpy([linkDir, path.join(linkDir, "missing.md")]);
  try {
    await assert.rejects(
      () => buildNoteContext({ path: "EscapeDirMissing/missing", includeBacklinks: false }),
      /escapes the vault/i,
    );
    assert.deepEqual(spy.touched, []);
  } finally {
    spy.restore();
  }
});

test("readFileWithinCap enforces the canonical vault boundary itself", async (t) => {
  const linkPath = path.join(vault, "EscapeRead.md");
  if (!(await symlinkOrSkip(t, path.join(outside, "secret.md"), linkPath, "file"))) return;
  const spy = installFsSpy([linkPath, path.join(outside, "secret.md")]);
  try {
    await assert.rejects(() => readFileWithinCap(linkPath, 4096), /escapes the vault/i);
    assert.deepEqual(spy.touched, []);
  } finally {
    spy.restore();
  }
});

test("a within-vault symlink still reads normally", async (t) => {
  const linkPath = path.join(vault, "Alias.md");
  if (!(await symlinkOrSkip(t, path.join(vault, "Inside.md"), linkPath, "file"))) return;
  const read = await readFileWithinCap(linkPath, 4096);
  assert.equal(read.tooLarge, false);
  assert.equal(read.changed, false);
  assert.equal(read.data.toString("utf8"), INSIDE_BODY);
  const context = await buildNoteContext({ path: "Alias", includeBacklinks: false });
  assert.equal(context.status, "ok");
  assert.equal(context.items[0].kind, "target");
});

test("bounded read is not redirected by a symlink swap after canonical validation", async (t) => {
  const linkPath = path.join(vault, "RaceAlias.md");
  const insidePath = path.join(vault, "Inside.md");
  if (!(await symlinkOrSkip(t, insidePath, linkPath, "file"))) return;

  const originalRealpath = fs.realpath;
  let swapped = false;
  fs.realpath = async (candidate, ...rest) => {
    const resolved = await originalRealpath.call(fs, candidate, ...rest);
    if (!swapped && String(candidate) === linkPath) {
      swapped = true;
      await fs.unlink(linkPath);
      await fs.symlink(path.join(outside, "secret.md"), linkPath, "file");
    }
    return resolved;
  };
  try {
    const read = await readFileWithinCap(linkPath, 4096);
    assert.equal(swapped, true, "test must swap the symlink after canonical realpath resolves");
    assert.equal(read.tooLarge, false);
    assert.equal(read.data.toString("utf8"), INSIDE_BODY);
    assert.equal(read.data.toString("utf8").includes(EXTERNAL_MARKER), false);
  } finally {
    fs.realpath = originalRealpath;
    await fs.rm(linkPath, { force: true });
  }
});

test("readLimitedText keeps MAX_READ_BYTES hard when a file grows after the size check", async () => {
  const target = path.join(vault, "Growing.md");
  await fs.writeFile(target, "small", "utf8");
  const oversized = `prefix-${"g".repeat(80 * 1024)}-growth-sentinel`;

  const originalStat = fs.stat;
  const originalOpen = fs.open;
  let grew = false;
  const growOnce = async () => {
    if (grew) return;
    grew = true;
    await fs.writeFile(target, oversized, "utf8");
  };
  fs.stat = async (candidate, ...rest) => {
    const result = await originalStat.call(fs, candidate, ...rest);
    if (String(candidate) === target) await growOnce();
    return result;
  };
  fs.open = async (candidate, ...rest) => {
    const handle = await originalOpen.call(fs, candidate, ...rest);
    if (String(candidate) === target) {
      const handleStat = handle.stat.bind(handle);
      handle.stat = async (...args) => {
        const result = await handleStat(...args);
        await growOnce();
        return result;
      };
    }
    return handle;
  };
  try {
    await assert.rejects(() => readLimitedText(target), /MAX_READ_BYTES|read limit|exceeds/i);
  } finally {
    fs.stat = originalStat;
    fs.open = originalOpen;
  }
});

test("getVaultIndex propagates a permission error instead of silently skipping", async () => {
  const target = path.join(vault, "Inside.md");
  const originalStat = fs.stat;
  const denied = Object.assign(new Error("EACCES: permission denied, stat 'Inside.md'"), { code: "EACCES" });
  fs.stat = async (candidate, ...rest) => {
    if (String(candidate) === target) throw denied;
    return originalStat.call(fs, candidate, ...rest);
  };
  try {
    await assert.rejects(() => getVaultIndex({ force: true }), (error) => error.code === "EACCES");
  } finally {
    fs.stat = originalStat;
  }
});

test("getVaultIndex propagates an unexpected FileHandle read failure", async () => {
  const target = path.join(vault, "Inside.md");
  const originalOpen = fs.open;
  const boom = new Error("unexpected read failure");
  let injected = false;
  let closed = false;
  fs.open = async (candidate, ...rest) => {
    const handle = await originalOpen.call(fs, candidate, ...rest);
    if (String(candidate) === target) {
      const realClose = handle.close.bind(handle);
      handle.read = async () => {
        injected = true;
        throw boom;
      };
      handle.close = async (...args) => {
        closed = true;
        return realClose(...args);
      };
    }
    return handle;
  };
  try {
    await assert.rejects(() => getVaultIndex({ force: true }), /unexpected read failure/);
    assert.equal(injected, true, "fault injection must hit the active FileHandle.read path");
    assert.equal(closed, true, "readLimitedText must close the FileHandle after an unexpected read failure");
  } finally {
    fs.open = originalOpen;
  }
});

test("getVaultIndex still skips an oversized note and indexes the rest", async () => {
  const index = await getVaultIndex({ force: true });
  assert.ok(index.records.some((record) => record.path === "Inside.md"));
  assert.equal(index.records.some((record) => record.path === "Oversized.md"), false);
  assert.ok(index.stats.skipped >= 1, `expected the oversized note to be skipped, saw ${index.stats.skipped}`);
});
