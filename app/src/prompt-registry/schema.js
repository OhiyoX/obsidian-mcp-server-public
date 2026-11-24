// Prompt Base schema: the one place that decides what a Base Prompt pack may
// contain. Everything here is pure: no filesystem, no network, no environment.
//
// The Base pack is the developer-maintained, Git-versioned source of every
// Agent-facing natural-language string. It never carries execution authority:
// Scope, AuthZ, schemas, tool names and routing stay in code, so a text edit
// cannot widen what the server does.

import { createHash } from "node:crypto";

export const PROMPT_BASE_SCHEMA_VERSION = 1;
export const PROMPT_BASE_INVALID = "PROMPT_BASE_INVALID";

/** Single-segment ceilings; the pack ceiling is separate (design 5.2). */
export const PROMPT_BASE_LIMITS = Object.freeze({
  "tools.canonical.": 4096,
  "tools.compact.": 400,
  "bootstrap.": 4096,
  "memory.": 2048,
  "prompts.research_brief.body": 8192,
  "prompts.": 4096,
  pack: 1024 * 1024,
  manifest: 64 * 1024,
});

/** Keys every pack must carry, whatever the catalog says. */
const REQUIRED_LITERAL_KEYS = Object.freeze([
  "bootstrap.instructions",
  "bootstrap.workflow.start",
  "bootstrap.workflow.reuse-and-improve",
  "bootstrap.workflow.checkpoint",
  "bootstrap.workflow.doc-hygiene",
  "bootstrap.workflow.write",
  "bootstrap.workflow.verify",
  "bootstrap.compatibility.toolNaming",
  "bootstrap.compatibility.fallback",
  "bootstrap.compatibility.activation",
  "memory.firstRead",
  "memory.checkpoint",
  "memory.afterWrite",
  "memory.readHint",
  "memory.writeHint",
  "prompts.research_brief.title",
  "prompts.research_brief.description",
  "prompts.research_brief.body",
]);

/** Boundary text is a list whose length is a code decision, not a prompt decision. */
const REQUIRED_BOUNDARY_KEY = /^bootstrap\.boundary\.(\d+)$/;
export const PROMPT_BASE_BOUNDARY_COUNT = 8;

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CANONICAL_PREFIX = "tools.canonical.";
const CANONICAL_SUFFIX = ".description";
const COMPACT_PREFIX = "tools.compact.";
const COMPACT_SUFFIX = ".summary";
// Everything a template may interpolate must be declared in the manifest. The
// patterns are deliberately narrow: a template is text, never a program.
const PLACEHOLDER = /\{\{([^{}\s]+)\}\}/g;

export class PromptBaseError extends Error {
  constructor(reason, detail) {
    super(`${PROMPT_BASE_INVALID}: ${reason}${detail === undefined ? "" : ` (${detail})`}`);
    this.name = "PromptBaseError";
    this.code = PROMPT_BASE_INVALID;
    this.reason = reason;
    this.detail = detail;
  }
}

function invalid(reason, detail) {
  throw new PromptBaseError(reason, detail);
}

/** The single declared limit for a key. Unknown prefixes never pass validation. */
export function limitFor(key) {
  for (const [prefix, limit] of Object.entries(PROMPT_BASE_LIMITS)) {
    if (prefix.endsWith(".") ? key.startsWith(prefix) : key === prefix) return limit;
  }
  return undefined;
}

/** UTF-8 decode with exactly one trailing line break removed, interior blank lines kept. */
export function readBaseText(fileBytes, { stripFinalNewline = true } = {}) {
  const bytes = Buffer.isBuffer(fileBytes) ? fileBytes : Buffer.from(fileBytes ?? "");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    invalid("not utf-8", error.message);
  }
  if (!stripFinalNewline) return text;
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function rejectUnsafeText(key, value) {
  const limit = limitFor(key);
  if (limit === undefined) invalid("unknown key", key);
  if (value.trim() === "") invalid("blank text", key);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid("control character", key);
  if (Buffer.byteLength(value, "utf8") > limit) invalid("text over limit", key);
}

function checkFileKey(key, file) {
  if (typeof file !== "string" || file === "") invalid("missing file path", key);
  if (file.startsWith("/") || file.includes("\\")) invalid("file path must be a relative posix path", key);
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    invalid("file path escapes the pack", key);
  }
  if (!file.endsWith(".md")) invalid("file must end with .md", key);
}

function expectedToolKeys(toolNames) {
  if (!Array.isArray(toolNames)) invalid("toolNames must be an array");
  return toolNames.map((name) => `${CANONICAL_PREFIX}${name}${CANONICAL_SUFFIX}`);
}

/** A digest over the canonical key/value pairs: same text, same digest, any order. */
export function promptBaseDigest(values) {
  const hash = createHash("sha256");
  for (const key of Object.keys(values).sort()) {
    hash.update(`${key}\u0000${Buffer.byteLength(values[key], "utf8")}\u0000`);
    hash.update(values[key], "utf8");
    hash.update("\u0000");
  }
  return `sha256:${hash.digest("hex")}`;
}

function declaredFiles(manifest) {
  const entries = manifest?.keys;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    invalid("manifest.keys must be an object");
  }
  return entries;
}

/**
 * Validate a pack given as a value map (the Admin JSON shape) instead of files.
 * It runs the very same rules as `validateBasePack`, so the two publish shapes
 * can never disagree about what a valid pack is.
 */
export function validateBaseValues({ manifest, values, toolNames, compactDomains, promptNames } = {}) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) invalid("values must be an object");
  const entries = declaredFiles(manifest);
  // Without a code catalog, the manifest's own key set is the inventory: the two
  // shapes then agree on which keys exist, and the route still passes the live one.
  const declared = Object.keys(entries);
  toolNames ??= declared.filter((key) => key.startsWith(CANONICAL_PREFIX)).map((key) => key.slice(CANONICAL_PREFIX.length, -CANONICAL_SUFFIX.length));
  compactDomains ??= declared.filter((key) => key.startsWith(COMPACT_PREFIX)).map((key) => key.slice(COMPACT_PREFIX.length, -COMPACT_SUFFIX.length));
  promptNames ??= declared.filter((key) => key.startsWith("prompts.")).map((key) => key.split(".")[1]);
  const files = new Map();
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(entries, key)) invalid("unknown key", key);
  }
  for (const [key, entry] of Object.entries(entries)) {
    const text = values[key];
    if (typeof text !== "string") invalid("missing value", key);
    // A file is read back with one trailing line break stripped, so the value map
    // round-trips through the same file path it is validated against.
    files.set(entry.file, Buffer.from(entry.keepFinalNewline === true ? text : `${text}\n`, "utf8"));
  }
  return validateBasePack({ manifest, files, toolNames, compactDomains, promptNames });
}

/**
 * Validate a whole pack. A pack is all-or-nothing: one bad key rejects the lot, so
 * a publish can never leave half the copy updated.
 */
export function validateBasePack({ manifest, files, toolNames = [], compactDomains = [], promptNames = [] } = {}) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) invalid("manifest must be an object");
  if (manifest.schemaVersion !== PROMPT_BASE_SCHEMA_VERSION) {
    invalid("unsupported schemaVersion", String(manifest.schemaVersion));
  }
  const entries = manifest.keys;
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) invalid("manifest.keys must be an object");
  if (!(files instanceof Map)) invalid("files must be a Map");

  const keys = Object.keys(entries);
  if (keys.length === 0) invalid("manifest has no keys");

  const seenFiles = new Map();
  const values = {};
  let total = 0;

  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) invalid("invalid key name", key);
    const entry = entries[key];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid("key entry must be an object", key);
    checkFileKey(key, entry.file);
    const other = seenFiles.get(entry.file);
    if (other !== undefined) invalid("duplicate file", `${other} and ${key} both use ${entry.file}`);
    seenFiles.set(entry.file, key);

    const bytes = files.get(entry.file);
    if (bytes === undefined) invalid("missing file", entry.file);
    const text = readBaseText(bytes, { stripFinalNewline: entry.keepFinalNewline !== true });
    rejectUnsafeText(key, text);

    const declared = entry.placeholders ?? [];
    if (!Array.isArray(declared) || declared.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_]+$/.test(name))) {
      invalid("placeholders must be identifier strings", key);
    }
    const found = [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
    for (const name of declared) {
      const count = found.filter((value) => value === name).length;
      if (count !== 1) invalid("declared placeholder must appear exactly once", `${key} {{${name}}} x${count}`);
    }
    for (const name of new Set(found)) {
      if (!declared.includes(name)) invalid("undeclared placeholder", `${key} {{${name}}}`);
    }

    total += Buffer.byteLength(text, "utf8");
    values[key] = text;
  }

  if (total > PROMPT_BASE_LIMITS.pack) invalid("pack over limit", `${total} bytes`);

  // A file the manifest does not name would never be read: silently ignoring it
  // turns a typo into a no-op "publish" that changed nothing.
  for (const file of files.keys()) {
    if (!seenFiles.has(file)) invalid("undeclared file", file);
  }

  for (const key of REQUIRED_LITERAL_KEYS) {
    if (!(key in values)) invalid("missing required key", key);
  }
  for (let index = 1; index <= PROMPT_BASE_BOUNDARY_COUNT; index += 1) {
    if (!(`bootstrap.boundary.${index}` in values)) invalid("missing required key", `bootstrap.boundary.${index}`);
  }
  for (const key of Object.keys(values)) {
    const boundary = REQUIRED_BOUNDARY_KEY.exec(key);
    if (boundary !== null && Number(boundary[1]) > PROMPT_BASE_BOUNDARY_COUNT) invalid("unknown boundary index", key);
  }

  for (const key of expectedToolKeys(toolNames)) {
    if (!(key in values)) invalid("missing canonical description", key);
  }
  for (const key of Object.keys(values)) {
    if (!key.startsWith(CANONICAL_PREFIX)) continue;
    const name = key.slice(CANONICAL_PREFIX.length, key.length - CANONICAL_SUFFIX.length);
    if (!key.endsWith(CANONICAL_SUFFIX) || !toolNames.includes(name)) invalid("unknown canonical tool key", key);
  }

  for (const domain of compactDomains) {
    const key = `${COMPACT_PREFIX}${domain}${COMPACT_SUFFIX}`;
    if (key in values) continue;
    // A group summary is optional: no summary means no intent sentence, which is
    // what a domain without copy carries today.
  }
  for (const key of Object.keys(values)) {
    if (!key.startsWith(COMPACT_PREFIX)) continue;
    const domain = key.slice(COMPACT_PREFIX.length, key.length - COMPACT_SUFFIX.length);
    if (!key.endsWith(COMPACT_SUFFIX) || !compactDomains.includes(domain)) invalid("unknown compact domain key", key);
  }

  for (const name of promptNames) {
    for (const field of ["title", "description", "body"]) {
      if (!(`prompts.${name}.${field}` in values)) invalid("missing prompt key", `prompts.${name}.${field}`);
    }
  }
  for (const key of Object.keys(values)) {
    if (!key.startsWith("prompts.")) continue;
    const match = /^prompts\.([A-Za-z0-9_-]+)\.(title|description|body)$/.exec(key);
    if (match === null || !promptNames.includes(match[1])) invalid("unknown prompt key", key);
  }

  const digest = promptBaseDigest(values);
  return Object.freeze({
    schemaVersion: PROMPT_BASE_SCHEMA_VERSION,
    digest,
    manifest: Object.freeze({ ...manifest, keys: Object.freeze({ ...entries }) }),
    values: Object.freeze({ ...values }),
  });
}

/** Fill a validated template. Only declared placeholders are replaced, once each. */
export function renderPromptTemplate(text, values = {}) {
  return text.replace(PLACEHOLDER, (whole, name) => {
    if (!Object.hasOwn(values, name)) invalid("no value for placeholder", name);
    const value = values[name];
    if (typeof value !== "string") invalid("placeholder value must be a string", name);
    return value;
  });
}

/** The numeric runtime tunings an operator may change; text keys are separate. */
export const PROMPT_TUNING_LIMITS = Object.freeze({ repeatAfterReads: { min: 1, max: 100 } });

export const INVALID_OVERRIDE_KEY = "INVALID_OVERRIDE_KEY";

/**
 * Validate a sparse override patch against the pack's allowlist.
 *
 * `set` maps a key to text; `removeKeys` is the only way to delete an override —
 * an empty string is never a deletion, because a blank rule that silently falls
 * back would be indistinguishable from a forgotten one.
 */
export function validateOverridePatch({ patch, basePack } = {}) {
  if (basePack === null || typeof basePack !== "object" || typeof basePack?.manifest?.keys !== "object") {
    throw new PromptBaseError("base pack manifest is required");
  }
  const set = patch?.set ?? {};
  const removeKeys = patch?.removeKeys ?? [];
  const tuning = patch?.tuning ?? {};
  if (set === null || typeof set !== "object" || Array.isArray(set)) throw new PromptBaseError("set must be an object");
  if (!Array.isArray(removeKeys)) throw new PromptBaseError("removeKeys must be an array");
  if (tuning === null || typeof tuning !== "object" || Array.isArray(tuning)) throw new PromptBaseError("tuning must be an object");

  const entries = basePack.manifest.keys;
  const fail = (detail) => {
    const error = new PromptBaseError("override", detail);
    error.code = INVALID_OVERRIDE_KEY;
    throw error;
  };

  for (const [key, value] of Object.entries(set)) {
    const entry = entries[key];
    if (entry === undefined) fail(`unknown key: ${key}`);
    if (entry.overrideAllowed !== true) fail(`base-only key: ${key}`);
    if (typeof value !== "string") fail(`${key} must be text`);
    try {
      rejectUnsafeText(key, value);
    } catch (error) {
      fail(`${key}: ${error.reason ?? error.message}`);
    }
    const declared = entry.placeholders ?? [];
    const found = [...value.matchAll(PLACEHOLDER)].map((match) => match[1]);
    for (const name of new Set(found)) {
      if (!declared.includes(name)) fail(`${key} uses undeclared placeholder {{${name}}}`);
    }
    for (const name of declared) {
      if (found.filter((item) => item === name).length !== 1) fail(`${key} must carry {{${name}}} exactly once`);
    }
  }

  for (const key of removeKeys) {
    if (typeof key !== "string") fail("removeKeys must be strings");
    if (entries[key] === undefined) fail(`unknown key: ${key}`);
    if (entries[key].overrideAllowed !== true) fail(`base-only key: ${key}`);
    if (Object.hasOwn(set, key)) fail(`${key} is both set and removed`);
  }

  for (const [name, value] of Object.entries(tuning)) {
    const limit = PROMPT_TUNING_LIMITS[name];
    if (limit === undefined) fail(`unknown tuning: ${name}`);
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      fail(`${name} must be an integer ${limit.min}..${limit.max}`);
    }
  }

  return Object.freeze({
    set: Object.freeze({ ...set }),
    removeKeys: Object.freeze([...removeKeys]),
    tuning: Object.freeze({ ...tuning }),
    changedKeys: Object.freeze([...Object.keys(set), ...removeKeys].sort()),
  });
}
