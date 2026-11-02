// v1 → v2 Publish state migration fixture (issues #277/#278, Wave D).
//
// Contract (authoritative):
//   _Workspace/40-Projects/obsidian_mcp_server/Web/
//     DEVELOPMENT - Issues 277-278 Publish 生命周期与 Markdown-only 边界收口.md
//   §8 persistence/migration · §8.1 fail-closed legacy records · §8.2 atomic save ·
//   §12.3 historical record · §15 S02/S03/S07 · §17 "迁移无 fixture" → RETURN.
//
// This module owns *data only*: the checked-in v1/v2 state-file samples under
// `test/fixtures/publish-state/`, the temporary Vault those samples point at, and the
// case descriptors. The executor is `run-publish-migration-checks.mjs`; it drives the
// real `PublishService` (real file IO, no stubs) against a throwaway data root.
//
// The samples are deliberately hand-written rather than generated in code: a migration
// fixture is only useful if it pins the *on-disk* v1 shape a real deployment can carry,
// including unknown keys, dropped records and a corrupt file that must never be
// rewritten in place.
import fs from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");

export const PUBLISH_MIGRATION_FIXTURE_DIR = path.join(appRoot, "test", "fixtures", "publish-state");

// Temporary Vault the samples resolve against. `Notes/Legacy-Missing.md` is the one
// path that is intentionally absent (§8.1 "missing historical record must fail closed").
export const PUBLISH_MIGRATION_VAULT_FILES = Object.freeze({
  legacyMarkdown: ["Notes/Legacy-Markdown.md", "# Legacy markdown\n\npublished before the v2 lifecycle existed\n"],
  legacyNonMarkdown: ["Notes/Legacy-NonMarkdown.canvas", "{}\n"],
  droppedFields: ["Notes/Dropped-Fields.md", "# Dropped-Fields\n"],
  unknownLifecycle: ["Notes/Unknown-Lifecycle.md", "# Unknown-Lifecycle\n"],
  firstWins: ["Notes/First-Wins.md", "# First-Wins\n"],
  secondDropped: ["Notes/Second-Dropped.md", "# Second-Dropped\n"],
  historicCanvas: ["Notes/Historic.canvas", "{}\n"],
  atomicOne: ["Notes/Atomic.md", "# Atomic\n"],
  atomicTwo: ["Notes/Atomic2.md", "# Atomic2\n"],
});

export const PUBLISH_MIGRATION_MISSING_PATH = "Notes/Legacy-Missing.md";

// `guard` is the product invariant the case exists to protect; it is what the
// env-gated negative control (`P278_D_MIGRATION_NEGATIVE`) proves is a real detector.
export const PUBLISH_MIGRATION_CASES = Object.freeze([
  Object.freeze({
    id: "v1-legacy",
    name: "a v1 state loads without assuming active, then decides each legacy record fail-closed",
    stateFile: "v1-legacy.json",
    guard: "an absent lifecycle is never a published candidate before observation",
  }),
  Object.freeze({
    id: "v1-partial-records",
    name: "one bad v1 record cannot stop the service and can never become public",
    stateFile: "v1-partial-records.json",
    guard: "missing fields / unknown lifecycle / unsafe path all fail closed per record",
  }),
  Object.freeze({
    id: "v1-duplicates",
    name: "duplicate v1 identities keep the first occurrence instead of double-serving",
    stateFile: "v1-duplicates.json",
    guard: "one record per id and per vaultId+path",
  }),
  Object.freeze({
    id: "v2-active-nonmarkdown",
    name: "a hand-written v2 active record on a non-Markdown target is retired on first read",
    stateFile: "v2-active-nonmarkdown.json",
    guard: "anonymous resolve never serves a non-Markdown historical record (§15 S01/S07)",
  }),
  Object.freeze({
    id: "corrupt-not-json",
    name: "a corrupt state file is rejected and never rewritten in place",
    stateFile: "corrupt-not-json.json",
    guard: "corrupt JSON is fatal and the original bytes survive (§8.2 no half-write)",
  }),
  Object.freeze({
    id: "unsupported-version",
    name: "an unknown state version is rejected instead of being guessed at",
    stateFile: "unsupported-version.json",
    guard: "unsupported state version is fatal",
  }),
  Object.freeze({
    id: "records-not-array",
    name: "a structurally broken state file is rejected",
    stateFile: "records-not-array.json",
    guard: "a non-array records field is fatal (§8.1 structure, not a single record)",
  }),
  Object.freeze({
    id: "top-level-array",
    name: "a top-level array is rejected as a malformed state file",
    stateFile: "top-level-array.json",
    guard: "the state file must be a JSON object",
  }),
  Object.freeze({
    id: "save-atomicity",
    name: "a failed save leaves no partial state file and no temp residue",
    stateFile: null,
    guard: "temp file + rename keeps the persisted state whole (§8.2)",
  }),
]);

export const PUBLISH_MIGRATION_CASE_IDS = Object.freeze(PUBLISH_MIGRATION_CASES.map((entry) => entry.id));

export async function fixtureBytes(name) {
  return fs.readFile(path.join(PUBLISH_MIGRATION_FIXTURE_DIR, name));
}

export async function fixtureText(name) {
  return fs.readFile(path.join(PUBLISH_MIGRATION_FIXTURE_DIR, name), "utf8");
}

export async function fixtureJson(name) {
  return JSON.parse(await fixtureText(name));
}

/** Materialize the temporary Vault the samples point at. Never reads a real Vault. */
export async function createFixtureVault(vaultRoot) {
  for (const [relative, content] of Object.values(PUBLISH_MIGRATION_VAULT_FILES)) {
    const absolute = path.join(vaultRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  return vaultRoot;
}

/** `{ "Notes/a.md": "<id>" }` for a parsed state object. */
export function idsByPath(state) {
  const index = {};
  for (const record of state.records || []) {
    if (record && typeof record.path === "string") index[record.path] = record.id;
  }
  return index;
}
