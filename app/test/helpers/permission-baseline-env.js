// Shared environment for the P0 baseline tests.
//
// `src/config.js` resolves every path at module evaluation, so the environment must be complete
// BEFORE anything imports it. Each test therefore calls `seedPermissionBaselineEnv()` first and
// only then dynamically imports the plane/collector.
//
// The isolated DATA_PATH and the synthetic Vaults live under `os.tmpdir()`, not under the repo:
// this worktree sits on a CIFS mount, where SQLite (the Web catalog) cannot take a lock and every
// Web write would fail with `database is locked`. The isolation the plan asks for still holds —
// nothing is written inside the checkout.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function seedPermissionBaselineEnv() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-permission-baseline-"));
  const vaults = path.join(root, "vaults");
  const primary = path.join(vaults, "vault");
  const dataPath = path.join(root, "data");
  for (const vault of ["vault", "alpha", "denied-vault"]) await fs.mkdir(path.join(vaults, vault, ".obsidian"), { recursive: true });
  await fs.mkdir(dataPath, { recursive: true });
  process.env.WEB_VAULTS_ROOT = vaults;
  process.env.WEB_DEFAULT_VAULT = "vault";
  process.env.VAULT_PATH = primary;
  process.env.DATA_PATH = dataPath;
  process.env.API_KEY = "permission-baseline-env-key";
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1:18923";
  process.env.OAUTH_ADMIN_PASSWORD = "baseline-admin-password";
  process.env.OAUTH_INITIAL_USERNAME = "baseline-owner";
  process.env.OAUTH_INITIAL_PASSWORD = "baseline-owner-password";
  process.env.GIT_ENABLED = "false";
  process.env.EMBEDDING_PROVIDER = "disabled";
  return { root, vaults, primary, dataPath };
}
