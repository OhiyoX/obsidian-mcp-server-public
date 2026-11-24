// The Base pack that ships inside the image, loaded once per process and on
// first use.
//
// It is the same Git content a publish sends to `/data`, kept here so a fresh
// install or a disaster recovery has a validated starting point. It is not a
// second editable layer: `promptctl base publish` replaces what the server reads.
//
// Loading is lazy because the pack's own validation needs the compact domain list,
// and `compact-tools.js` reads the pack: an eager load would close that cycle
// during module initialization.

import { fileURLToPath } from "node:url";
import { loadBundledBase, createBundledPromptReader } from "./base-pack.js";
import { TOOL_NAMES } from "../config.js";
import { COMPACT_GROUPS } from "../compact-tools.js";
import { MCP_PROMPT_NAMES } from "../prompts.js";

const PACK_ROOT = fileURLToPath(new URL("../../prompts/base/", import.meta.url));

let pack;
let reader;

/** The validated bundled pack. Throws once, on first use, if the shipped pack is broken. */
export function bundledBasePack() {
  pack ??= loadBundledBase({
    rootDir: PACK_ROOT,
    toolNames: [...TOOL_NAMES],
    compactDomains: Object.keys(COMPACT_GROUPS),
    promptNames: [...MCP_PROMPT_NAMES],
  });
  return pack;
}

/** Read-only registry over the bundled pack; P1 replaces it with the live store. */
export function bundledPromptRegistry() {
  reader ??= createBundledPromptReader(bundledBasePack());
  return reader;
}
