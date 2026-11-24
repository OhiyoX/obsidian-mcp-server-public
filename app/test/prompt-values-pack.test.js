// The Admin JSON "values" publish shape must enforce exactly the same rules as the
// manifest + files shape. One review finding (#827 F-1) was that it enforced none of
// them: a bad template published through it broke `tools/list` for every session and
// survived a restart.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { bundledBasePack } from "../src/prompt-registry/bundled.js";
import { PROMPT_BASE_LIMITS, validateBaseValues } from "../src/prompt-registry/schema.js";
import { PACK_FILE_LIMIT } from "../src/prompt-registry/store.js";
import { TOOL_NAMES } from "../src/config.js";
import { COMPACT_GROUPS } from "../src/compact-tools.js";
import { MCP_PROMPT_NAMES } from "../src/prompts.js";
import { adminLogin, prepareEnv, startStack } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

const base = bundledBasePack();
const catalog = {
  toolNames: [...TOOL_NAMES],
  compactDomains: Object.keys(COMPACT_GROUPS),
  promptNames: [...MCP_PROMPT_NAMES],
};
const values = () => ({ ...base.values });
const rejects = (mutate, pattern) => {
  const next = values();
  mutate(next);
  assert.throws(() => validateBaseValues({ manifest: base.manifest, values: next, ...catalog }), pattern);
};

test("the shipped values pass the value-map validator unchanged", () => {
  const checked = validateBaseValues({ manifest: base.manifest, values: values(), ...catalog });
  assert.equal(checked.digest, base.digest, "the same text produces the same digest in either shape");
});

test("an undeclared placeholder is refused", () => {
  rejects((next) => {
    next["tools.canonical.get_note.description"] = "Use {{topic}} here.";
  }, /undeclared placeholder/);
});

test("a key the manifest does not declare is refused", () => {
  rejects((next) => {
    next["tools.canonical.not_a_tool.description"] = "invented";
  }, /unknown key/);
});

test("a missing key is refused", () => {
  const next = values();
  delete next["tools.canonical.get_note.description"];
  assert.throws(() => validateBaseValues({ manifest: base.manifest, values: next, ...catalog }), /missing value/);
});

test("control characters and over-limit text are refused", () => {
  rejects((next) => {
    next["tools.canonical.get_note.description"] = "bad\u0007byte";
  }, /control character/);
  const compactKey = Object.keys(values()).find((key) => key.startsWith("tools.compact."));
  if (compactKey !== undefined) {
    rejects((next) => {
      next[compactKey] = "x".repeat(PROMPT_BASE_LIMITS["tools.compact."] + 1);
    }, /over limit/);
  }
});

test("the per-key ceilings cannot reach the pack budget (so a publish can never be oversized)", () => {
  const maximum = Object.keys(values()).reduce((total, key) => total + (PROMPT_BASE_LIMITS[Object.keys(PROMPT_BASE_LIMITS).find(
    (prefix) => (prefix.endsWith(".") ? key.startsWith(prefix) : key === prefix),
  )] ?? 0), 0);
  assert.ok(maximum < PROMPT_BASE_LIMITS.pack, `worst-case pack ${maximum} stays under ${PROMPT_BASE_LIMITS.pack}`);
  // ...and the staged pack file still fits the limit the startup read path enforces.
  assert.ok(PACK_FILE_LIMIT >= PROMPT_BASE_LIMITS.pack * 2, "a published pack must survive a restart");
});

test("the Admin route refuses the same bad value map, and the server keeps serving", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const bad = values();
  bad["tools.canonical.get_note.description"] = "Use {{topic}} here.";
  const response = await fetch(`${stack.origin}/admin/auth/prompt-registry/base/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ csrf: admin.csrf, expectedRevision: 0, reason: "test", pack: { values: bad } }),
  });
  assert.equal(response.status, 422);
  assert.equal(stack.store.status().revision, 0, "nothing was published");
  assert.match(stack.store.snapshot().values["tools.canonical.get_note.description"], /\S/);
});

test("the Admin body limit is 2x the pack budget, not 3x", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/admin/routes/prompt-registry.js", import.meta.url), "utf8");
  assert.match(source, /PROMPT_BASE_LIMITS\.pack \* 2/);
  assert.doesNotMatch(source, /PROMPT_BASE_LIMITS\.pack \* 3/);
});
