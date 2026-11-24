// Loader for the bundled Base Prompt pack: `app/prompts/base/manifest.json` plus
// the Markdown files it names.
//
// The pack is read once at startup (or by a test) and handed to the rest of the
// server as an immutable snapshot, so one request can never mix two revisions.
// Nothing here touches the Vault, the network, or the environment.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PROMPT_BASE_LIMITS,
  PROMPT_BASE_INVALID,
  PromptBaseError,
  validateBasePack,
} from "./schema.js";

function readManifest(rootDir) {
  const file = join(rootDir, "manifest.json");
  let raw;
  try {
    raw = readFileSync(file);
  } catch (error) {
    throw new PromptBaseError("manifest unreadable", error.code ?? error.message);
  }
  if (raw.length > PROMPT_BASE_LIMITS.manifest) throw new PromptBaseError("manifest over limit", file);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new PromptBaseError("manifest is not JSON", error.message);
  }
}

/** Read one pack file, refusing anything that resolves outside the pack root. */
function readPackFile(rootDir, relativePath) {
  const target = resolve(rootDir, relativePath);
  const inside = relative(resolve(rootDir), target);
  if (inside === "" || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new PromptBaseError("file path escapes the pack", relativePath);
  }
  let real;
  try {
    real = realpathSync(target);
  } catch (error) {
    throw new PromptBaseError("missing file", `${relativePath} (${error.code ?? error.message})`);
  }
  const realRoot = realpathSync(rootDir);
  const realInside = relative(realRoot, real);
  if (realInside === "" || realInside.startsWith(`..${sep}`) || isAbsolute(realInside)) {
    throw new PromptBaseError("file path escapes the pack", relativePath);
  }
  if (!statSync(real).isFile()) throw new PromptBaseError("not a file", relativePath);
  return readFileSync(real);
}

/**
 * Load and validate the pack shipped beside the code. `rootDir` is the pack
 * directory itself, so a caller cannot point it at a Vault by accident.
 */
export function loadBundledBase({ rootDir, toolNames = [], compactDomains = [], promptNames = [] } = {}) {
  if (typeof rootDir !== "string" || rootDir === "") throw new PromptBaseError("rootDir is required");
  const manifest = readManifest(rootDir);
  const files = new Map();
  for (const entry of Object.values(manifest.keys ?? {})) {
    const file = entry?.file;
    if (typeof file === "string" && !files.has(file)) files.set(file, readPackFile(rootDir, file));
  }
  return validateBasePack({ manifest, files, toolNames, compactDomains, promptNames });
}

/**
 * Read-only adapter. P1 swaps it for the live registry; both expose
 * `snapshot()`, so consumers never learn which one they hold.
 */
export function createBundledPromptReader(basePack) {
  if (basePack === null || typeof basePack !== "object" || typeof basePack.values !== "object") {
    throw new PromptBaseError("basePack is required");
  }
  const snapshot = Object.freeze({
    revision: 0,
    baseDigest: basePack.digest,
    effectiveDigest: basePack.digest,
    overrideCount: 0,
    status: "bundled",
    values: basePack.values,
  });
  return Object.freeze({ snapshot: () => snapshot });
}

export { PROMPT_BASE_INVALID, PromptBaseError };
