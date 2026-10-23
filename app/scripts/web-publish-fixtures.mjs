// Synthetic fixture Vault for the Web Publish surface browser contract (Wave C / C3).
//
// Deliberately self-contained and writes ONLY generated text; it never reads a real
// user Vault, credentials, or any path outside the caller-provided `rootDir`.
//
// Layout under `rootDir`:
//
//   vault/                 (VAULT_PATH -> single Web Vault, id `default`)
//     Published.md         registered and active   -> must be a public candidate
//     Orphan.md            registered, then deleted -> retired, must NOT be public
//     Plain.md             never registered         -> private
//     Decoy.md             frontmatter `published: true` but never registered (#270)
//     Assets/Diagram.canvas  target of a hand-written *invalid* registry record
//   data/publish/state.json  seeded v2 state with the invalid record
//
// The invalid record can only come from a state file: `PublishService.publish` is
// Markdown-only, so there is no API path that creates it (§12.3 historical record).
import fs from "node:fs/promises";
import path from "node:path";

// `defaultWebVaultId()` returns `default` when the deployment uses a single
// VAULT_PATH (no WEB_VAULTS_ROOT), which is exactly this fixture's layout.
export const WEB_PUBLISH_VAULT_ID = "default";
export const WEB_PUBLISH_STAMP = "2026-10-07T00:00:00.000Z";
export const WEB_PUBLISH_INVALID_ID = "K".repeat(43);

export const WEB_PUBLISH_FILES = Object.freeze({
  active: "Published.md",
  orphan: "Orphan.md",
  plain: "Plain.md",
  decoy: "Decoy.md",
  invalid: "Assets/Diagram.canvas",
});

// #447: the unbreakable tokens the public page must survive on a phone viewport — a long
// Vault path, a backup tarball, two 64-char SHA-256 digests and a query-string URL — plus one
// fenced line long enough to overflow the code block itself, so a check can measure the
// inline-code and the block-level `pre` contracts on the same served page.
export const WEB_PUBLISH_LONG_PATH = "/srv/obsidian-mcp-server";
export const WEB_PUBLISH_LONG_TAR = "/srv/backups/obsidian-mcp-server-2026-10-07T03-14-22Z.tar.gz";
export const WEB_PUBLISH_SHA_APP = "9f2c1f0a7d3e4b5c6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f";
export const WEB_PUBLISH_SHA_EDITOR = "b7f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1";
export const WEB_PUBLISH_LONG_URL = "https://mcp.example.com/app/assets/reader.js?v=2026.10.07.2&source=publish";
export const WEB_PUBLISH_PROBE_LINE = "/healthz 200，匿名 /app 303";
export const WEB_PUBLISH_LONG_BLOCK_LINE = `${WEB_PUBLISH_LONG_PATH}/app/src/app/assets/app.js#${WEB_PUBLISH_SHA_APP}+${WEB_PUBLISH_SHA_EDITOR}`;
// The second fenced line: the oversize block is measured, so the check needs the block to be
// present at all — a vanished `pre` must fail instead of silently skipping its assertions.
export const WEB_PUBLISH_BLOCK_SECOND_LINE = WEB_PUBLISH_SHA_APP;
// The list-item case: a long path token inside a bulleted list, not a standalone paragraph.
export const WEB_PUBLISH_LIST_TOKEN = `${WEB_PUBLISH_LONG_PATH}/app/src/app/assets/editor.js?v=1#${WEB_PUBLISH_SHA_EDITOR}`;

// #447 sample contract. These literals are *independent* of `WEB_PUBLISH_ACTIVE_BODY` below
// on purpose: the browser check asserts every named sample is present on the served page and
// then measures that very sample, and the fast stylesheet test asserts the fixture body still
// contains each named sample. Removing a sample from either place therefore fails a gate
// instead of turning a measurement loop vacuously green (the pre=0 counterexample of #447).
export const WEB_PUBLISH_INLINE_SAMPLES = Object.freeze([
  { id: "vault-path", text: WEB_PUBLISH_LONG_PATH },
  { id: "backup-tar-path", text: WEB_PUBLISH_LONG_TAR },
  { id: "sha256-app", text: WEB_PUBLISH_SHA_APP },
  { id: "sha256-editor", text: WEB_PUBLISH_SHA_EDITOR },
  { id: "query-string-url", text: WEB_PUBLISH_LONG_URL },
  { id: "list-item-token", text: WEB_PUBLISH_LIST_TOKEN },
  // Positive control: a short inline span must also stay inside its parent (it never did fail).
  { id: "short-probe-control", text: WEB_PUBLISH_PROBE_LINE },
]);
export const WEB_PUBLISH_BLOCK_SAMPLES = Object.freeze([
  { id: "block-oversize-composite-line", text: WEB_PUBLISH_LONG_BLOCK_LINE },
  { id: "block-second-line", text: WEB_PUBLISH_BLOCK_SECOND_LINE },
]);
export const WEB_PUBLISH_ACTIVE_BODY = [
  `路径样本：\`${WEB_PUBLISH_LONG_PATH}\` 以及备份包 \`${WEB_PUBLISH_LONG_TAR}\`。`,
  "",
  `哈希样本：\`${WEB_PUBLISH_SHA_APP}\`（app.js）与 \`${WEB_PUBLISH_SHA_EDITOR}\`（editor.js）。`,
  "",
  `地址样本：\`${WEB_PUBLISH_LONG_URL}\``,
  "",
  `探测样本：\`${WEB_PUBLISH_PROBE_LINE}\``,
  "",
  `- 列表项里的超长行：\`${WEB_PUBLISH_LONG_PATH}/app/src/app/assets/editor.js?v=1#${WEB_PUBLISH_SHA_EDITOR}\``,
  "",
  "```text",
  WEB_PUBLISH_LONG_BLOCK_LINE,
  WEB_PUBLISH_SHA_APP,
  "```",
].join("\n");

export async function createWebPublishFixtureVault(rootDir) {
  const vault = path.join(rootDir, "vault");
  const data = path.join(rootDir, "data");
  const assets = path.join(vault, "Assets");
  await fs.mkdir(assets, { recursive: true });

  await fs.writeFile(path.join(vault, WEB_PUBLISH_FILES.active), `# Published\n\n${WEB_PUBLISH_ACTIVE_BODY}\n`);
  await fs.writeFile(path.join(vault, WEB_PUBLISH_FILES.orphan), "# Orphan\n\npublished, deleted, then recreated at the same path\n");
  await fs.writeFile(path.join(vault, WEB_PUBLISH_FILES.plain), "# Plain\n\nnever registered\n");
  // The #270 decoy: a lookalike frontmatter field that must never satisfy `published:`.
  await fs.writeFile(path.join(vault, WEB_PUBLISH_FILES.decoy), "---\npublished: true\n---\n# Decoy\n\nfrontmatter lookalike\n");
  await fs.writeFile(path.join(vault, ...WEB_PUBLISH_FILES.invalid.split("/")), "{}\n");

  const stateFile = path.join(data, "publish", "state.json");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 2,
    records: [{
      id: WEB_PUBLISH_INVALID_ID,
      vaultId: WEB_PUBLISH_VAULT_ID,
      path: WEB_PUBLISH_FILES.invalid,
      lifecycle: "active",
      createdAt: WEB_PUBLISH_STAMP,
      updatedAt: WEB_PUBLISH_STAMP,
      createdBy: "fixture",
    }],
  }, null, 2)}\n`, "utf8");

  return {
    root: rootDir,
    vault,
    data,
    stateFile,
    invalidId: WEB_PUBLISH_INVALID_ID,
    files: WEB_PUBLISH_FILES,
    serverEnv: {
      VAULT_PATH: vault,
      DATA_PATH: data,
      WEB_CATALOG_ENABLED: "true",
      WEB_CATALOG_DIR: path.join(rootDir, "catalog"),
    },
  };
}

/** Canonical absolute path of a fixture note, so a check can delete/recreate it. */
export function fixtureNotePath(fixtures, relative) {
  return path.join(fixtures.vault, ...relative.split("/"));
}
