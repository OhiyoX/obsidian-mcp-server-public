// A1 — Publish target pure helper (#278 / contract §6, §12.1, §12.2).
//
// The module under test is injected, not imported from Web: `resolvePath` and `stat`
// are test doubles that stand in for `resolveWebVaultPath(..., { assumeMarkdown: true })`
// and the stat probe. The Vault resolver double deliberately does NOT append `.md`,
// so the §6 rule-2 responsibility stays with the module under test.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MAX_READ_BYTES } from "../src/config.js";
import {
  MARKDOWN_EXTENSION,
  PUBLISH_TARGET_ERROR_CODES,
  PUBLISH_TARGET_MISSING,
  PUBLISH_TARGET_NOT_A_FILE,
  PUBLISH_TARGET_TOO_LARGE,
  INVALID_PUBLISH_TARGET_PATH,
  PublishTargetError,
  UNSUPPORTED_PUBLISH_TARGET,
  assertPublishableMarkdownPath,
  assertPublishableTarget,
  isMarkdownTargetPath,
  isPublishTargetError,
  normalizePublishTarget,
} from "../src/publish/target.js";

const VAULT_ROOT = "/vault";
const TARGET_SOURCE = new URL("../src/publish/target.js", import.meta.url);

// Stand-in for the canonical Vault resolution: same normalization and containment
// refusals as `normalizeVaultInput` + `resolveWebVaultPath`, no `.md` completion, and
// every call recorded so the tests can assert what the helper actually passed down.
function vaultResolver() {
  const calls = [];
  const resolvePath = async (userPath, options = {}) => {
    calls.push({ userPath, options });
    const normalized = path.posix.normalize(String(userPath).replaceAll("\\", "/").replace(/^\/+/, ""));
    const segments = normalized.split("/");
    if (!normalized || segments.includes("..")) throw new Error("Invalid Vault path");
    return { path: normalized, absolute: path.posix.join(VAULT_ROOT, normalized) };
  };
  return { calls, resolvePath };
}

// A resolver that answers with whatever it was handed (no normalization, no
// containment check) — used to prove the helper refuses escape attempts on its own.
const permissiveResolver = async (userPath) => ({
  path: String(userPath),
  absolute: path.posix.join(VAULT_ROOT, String(userPath)),
});

const statFor = (entries, fallback = null) => async ({ path: notePath }) => entries[notePath] ?? fallback;
const file = (size) => ({ isFile: true, size });

async function rejectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "PublishTargetError");
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

function throwCode(operation, code) {
  assert.throws(operation, (error) => {
    assert.equal(error.name, "PublishTargetError");
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

// --- §12.1 Accept ---------------------------------------------------------------

test("accepts an existing Markdown path and returns the canonical target", async () => {
  const { calls, resolvePath } = vaultResolver();
  const target = await normalizePublishTarget("Notes/a.md", { resolvePath });
  assert.deepEqual(target, { path: "Notes/a.md", absolute: "/vault/Notes/a.md" });
  assert.deepEqual(calls, [{ userPath: "Notes/a.md", options: { assumeMarkdown: true } }]);
  assert.ok(Object.isFrozen(target));
  assert.equal(assertPublishableMarkdownPath(target.path), "Notes/a.md");
});

test("accepts .MD / .Md as Markdown and preserves the canonical spelling", async () => {
  const { resolvePath } = vaultResolver();
  for (const input of ["Notes/A.MD", "Notes/A.Md", "Notes/A.mD"]) {
    const target = await normalizePublishTarget(input, { resolvePath });
    assert.equal(target.path, input);
    assert.equal(isMarkdownTargetPath(target.path), true);
  }
});

test("completes an extension-less path to .md with the existing assumeMarkdown semantics", async () => {
  const { calls, resolvePath } = vaultResolver();
  const target = await normalizePublishTarget("Notes/a", { resolvePath });
  assert.deepEqual(calls, [{ userPath: "Notes/a.md", options: { assumeMarkdown: true } }]);
  assert.equal(target.path, "Notes/a.md");
  assert.equal(target.absolute, "/vault/Notes/a.md");
});

test("treats a name whose extension is not .md as non-Markdown (same rule as assumeMarkdown)", async () => {
  const { calls, resolvePath } = vaultResolver();
  await rejectCode(assertPublishableTarget("Notes/v1.2 notes", { resolvePath, stat: statFor({}) }), UNSUPPORTED_PUBLISH_TARGET);
  assert.deepEqual(calls, [{ userPath: "Notes/v1.2 notes", options: { assumeMarkdown: true } }]);
});

// The canonicalizer deliberately does NOT apply the type gate: revoke must be able to
// canonicalize a missing, renamed or historical non-Markdown target (contract §12.3,
// §13.3 — "revoke 不因 allowMissing 而放宽 canonical path containment").
test("canonicalizes a non-Markdown or missing target without gating it", async () => {
  const { resolvePath } = vaultResolver();
  const canvas = await normalizePublishTarget("Notes/a.canvas", { resolvePath });
  assert.deepEqual(canvas, { path: "Notes/a.canvas", absolute: "/vault/Notes/a.canvas" });
  const missing = await normalizePublishTarget("Notes/gone", { resolvePath });
  assert.equal(missing.path, "Notes/gone.md");
});

test("accepts an existing Markdown target within the size limit", async () => {
  const { resolvePath } = vaultResolver();
  const target = await assertPublishableTarget("Notes/a.md", {
    resolvePath,
    stat: statFor({ "Notes/a.md": file(2048) }),
  });
  assert.deepEqual(target, { path: "Notes/a.md", absolute: "/vault/Notes/a.md", size: 2048 });
});

test("accepts nested, non-ASCII and backslash-separated Vault paths", async () => {
  const { resolvePath } = vaultResolver();
  const nested = await normalizePublishTarget("笔记/深层/note.md", { resolvePath });
  assert.equal(nested.path, "笔记/深层/note.md");
  const backslashed = await normalizePublishTarget("Notes\\a.md", { resolvePath });
  assert.equal(backslashed.path, "Notes/a.md");
  const padded = await normalizePublishTarget("  Notes/a.md  ", { resolvePath });
  assert.equal(padded.path, "Notes/a.md");
});

test("accepts a resolver that answers with a bare canonical path string", async () => {
  const target = await normalizePublishTarget("Notes/a.md", { resolvePath: async () => "Notes/a.md" });
  assert.deepEqual(target, { path: "Notes/a.md", absolute: null });
});

// --- §12.2 Reject ---------------------------------------------------------------

test("rejects explicit non-Markdown targets with unsupported_publish_target before any stat", async () => {
  const { resolvePath } = vaultResolver();
  let statCalls = 0;
  const stat = async () => { statCalls += 1; return file(1); };
  for (const input of ["Notes/a.canvas", "Notes/a.base", "Notes/a.json", "Notes/a.txt", "Notes/a.png"]) {
    await rejectCode(assertPublishableTarget(input, { resolvePath, stat }), UNSUPPORTED_PUBLISH_TARGET);
    throwCode(() => assertPublishableMarkdownPath(input), UNSUPPORTED_PUBLISH_TARGET);
  }
  assert.equal(statCalls, 0, "the type gate must run before the existence probe");
});

test("rejects extensions that merely contain \"md\"", async () => {
  const { resolvePath } = vaultResolver();
  for (const input of ["Notes/x.mdx", "Notes/x.mdown", "Notes/x.markdown", "Notes/x.md.bak", "Notes/x.md5"]) {
    await rejectCode(assertPublishableTarget(input, { resolvePath, stat: statFor({}) }), UNSUPPORTED_PUBLISH_TARGET);
  }
});

test("rejects an extension-less target whose completed .md target is missing", async () => {
  const { resolvePath } = vaultResolver();
  await rejectCode(
    assertPublishableTarget("Notes/missing", { resolvePath, stat: statFor({}) }),
    PUBLISH_TARGET_MISSING,
  );
});

test("rejects a resolver ENOENT as publish_target_missing and keeps the cause", async () => {
  const enoent = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  await assert.rejects(
    normalizePublishTarget("Notes/gone.md", { resolvePath: async () => { throw enoent; } }),
    (error) => {
      assert.equal(error.code, PUBLISH_TARGET_MISSING);
      assert.equal(error.cause, enoent);
      return true;
    },
  );
});

test("rejects a directory target with publish_target_not_a_file", async () => {
  const { resolvePath } = vaultResolver();
  await rejectCode(
    assertPublishableTarget("Notes/folder.md", { resolvePath, stat: statFor({ "Notes/folder.md": { isFile: false } }) }),
    PUBLISH_TARGET_NOT_A_FILE,
  );
});

test("rejects an extension-less directory as a missing Markdown target", async () => {
  const { resolvePath } = vaultResolver();
  await rejectCode(
    assertPublishableTarget("Notes/folder", { resolvePath, stat: statFor({}) }),
    PUBLISH_TARGET_MISSING,
  );
});

test("rejects an oversize Markdown target with size and limit attached", async () => {
  const { resolvePath } = vaultResolver();
  const maxBytes = 1024;
  await assert.rejects(
    assertPublishableTarget("Notes/big.md", { resolvePath, stat: statFor({ "Notes/big.md": file(1025) }), maxBytes }),
    (error) => {
      assert.equal(error.code, PUBLISH_TARGET_TOO_LARGE);
      assert.equal(error.size, 1025);
      assert.equal(error.maxBytes, maxBytes);
      return true;
    },
  );
});

test("size gate defaults to the config MAX_READ_BYTES limit and accepts exactly the limit", async () => {
  const { resolvePath } = vaultResolver();
  const atLimit = await assertPublishableTarget("Notes/a.md", {
    resolvePath,
    stat: statFor({ "Notes/a.md": file(MAX_READ_BYTES) }),
  });
  assert.equal(atLimit.size, MAX_READ_BYTES);
  await rejectCode(
    assertPublishableTarget("Notes/a.md", { resolvePath, stat: statFor({ "Notes/a.md": file(MAX_READ_BYTES + 1) }) }),
    PUBLISH_TARGET_TOO_LARGE,
  );
});

test("rejects traversal input through the resolver refusal", async () => {
  const { calls, resolvePath } = vaultResolver();
  for (const input of ["../outside.md", "Notes/../../outside.md"]) {
    await rejectCode(normalizePublishTarget(input, { resolvePath }), INVALID_PUBLISH_TARGET_PATH);
  }
  // Traversal refusal stays where it already lives: the canonical resolver.
  assert.equal(calls.length, 2);
});

test("rejects absolute input before any resolution", async () => {
  const { calls, resolvePath } = vaultResolver();
  for (const input of ["/etc/passwd.md", "C:/Windows/notes.md", "\\\\server\\share\\a.md", "  /etc/passwd.md"]) {
    await rejectCode(normalizePublishTarget(input, { resolvePath }), INVALID_PUBLISH_TARGET_PATH);
  }
  assert.deepEqual(calls, []);
});

test("rejects escape and absolute answers from a permissive resolver", async () => {
  for (const input of ["../../outside.md", "/etc/passwd.md", "Notes/../outside.md", "Notes//a.md", "Notes/a.md/"]) {
    await rejectCode(normalizePublishTarget(input, { resolvePath: permissiveResolver }), INVALID_PUBLISH_TARGET_PATH);
  }
});

test("rejects an empty or missing path", async () => {
  const { calls, resolvePath } = vaultResolver();
  for (const input of ["", "   ", null, undefined, "\0"]) {
    await rejectCode(normalizePublishTarget(input, { resolvePath }), INVALID_PUBLISH_TARGET_PATH);
  }
  assert.deepEqual(calls, []);
  throwCode(() => assertPublishableMarkdownPath(""), INVALID_PUBLISH_TARGET_PATH);
  throwCode(() => assertPublishableMarkdownPath(null), INVALID_PUBLISH_TARGET_PATH);
});

test("rejects a canonical path that is not a plain Vault-relative posix path", async () => {
  for (const answer of ["", "   ", "/vault/a.md", "C:/a.md", "Notes\\a.md", " Notes/a.md", "Notes/a.md "]) {
    await rejectCode(normalizePublishTarget("Notes/a.md", { resolvePath: async () => answer }), INVALID_PUBLISH_TARGET_PATH);
  }
});

test("does not trust the resolver to answer with a Markdown path", async () => {
  const stripsExtension = async (userPath) => ({ path: String(userPath).replace(/\.md$/, "") });
  await rejectCode(
    assertPublishableTarget("Notes/a", { resolvePath: stripsExtension, stat: statFor({}) }),
    UNSUPPORTED_PUBLISH_TARGET,
  );
});

test("treats a non-ENOENT resolver refusal as an invalid path with the cause preserved", async () => {
  const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  await assert.rejects(
    normalizePublishTarget("Notes/a.md", { resolvePath: async () => { throw denied; } }),
    (error) => {
      assert.equal(error.code, INVALID_PUBLISH_TARGET_PATH);
      assert.equal(error.cause, denied);
      return true;
    },
  );
});

test("rejects a Markdown-named target in every stat failure mode", async () => {
  const { resolvePath } = vaultResolver();
  await rejectCode(assertPublishableTarget("Notes/a.canvas", { resolvePath, stat: statFor({}) }), UNSUPPORTED_PUBLISH_TARGET);
  await rejectCode(assertPublishableTarget("Notes/a.md", { resolvePath, stat: statFor({}) }), PUBLISH_TARGET_MISSING);
  await rejectCode(
    assertPublishableTarget("Notes/a.md", { resolvePath, stat: statFor({ "Notes/a.md": { isFile: false, size: 10 } }) }),
    PUBLISH_TARGET_NOT_A_FILE,
  );
});

// --- wiring contract ------------------------------------------------------------

test("requires the injected resolver and stat probe instead of defaulting", async () => {
  await assert.rejects(normalizePublishTarget("Notes/a.md"), TypeError);
  await assert.rejects(assertPublishableTarget("Notes/a.md", { resolvePath: async () => "Notes/a.md" }), TypeError);
  await assert.rejects(assertPublishableTarget({ path: "Notes/a.md" }), TypeError);
});

test("accepts an already-normalized target object and ignores extra fields", async () => {
  const target = await assertPublishableTarget(
    { path: "Notes/a.md", absolute: "/vault/Notes/a.md", extra: "ignored" },
    { stat: statFor({ "Notes/a.md": file(12) }) },
  );
  assert.deepEqual(target, { path: "Notes/a.md", absolute: "/vault/Notes/a.md", size: 12 });
});

// --- error contract (§7) --------------------------------------------------------

test("exports a frozen, duplicate-free error code set", () => {
  assert.ok(Object.isFrozen(PUBLISH_TARGET_ERROR_CODES));
  assert.equal(new Set(PUBLISH_TARGET_ERROR_CODES).size, PUBLISH_TARGET_ERROR_CODES.length);
  assert.deepEqual([...PUBLISH_TARGET_ERROR_CODES], [
    "unsupported_publish_target",
    "invalid_publish_target_path",
    "publish_target_missing",
    "publish_target_not_a_file",
    "publish_target_too_large",
  ]);
  assert.equal(MARKDOWN_EXTENSION, ".md");
});

test("recognizes its own errors and lookalike codes, not arbitrary failures", () => {
  assert.ok(isPublishTargetError(new PublishTargetError(UNSUPPORTED_PUBLISH_TARGET, "x")));
  assert.ok(isPublishTargetError({ code: PUBLISH_TARGET_MISSING }));
  assert.ok(!isPublishTargetError(new Error("boom")));
  assert.ok(!isPublishTargetError(undefined));
  assert.ok(!isPublishTargetError({ code: "ENOENT" }));
});

test("carries no secret or absolute Vault root in the error message", async () => {
  const { resolvePath } = vaultResolver();
  await assert.rejects(assertPublishableTarget("Notes/a.canvas", { resolvePath, stat: statFor({}) }), (error) => {
    assert.ok(!error.message.includes(VAULT_ROOT));
    assert.equal(error.path, "Notes/a.canvas");
    return true;
  });
});

// --- module boundary ratchet (§16 / brief §1) -----------------------------------

test("imports only node:path and config, so it can neither read content nor reach the Web layer", async () => {
  const source = await fs.readFile(TARGET_SOURCE, "utf8");
  const specifiers = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(specifiers, ["node:path", "../config.js"]);
  assert.ok(source.replaceAll("\r\n", "\n").trimEnd().split("\n").length <= 500, "target.js exceeds the local 500-line cap");
});
