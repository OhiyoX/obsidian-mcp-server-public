import fs from "node:fs/promises";
import path from "node:path";
import { MAX_READ_BYTES, VERSION_HISTORY_ENABLED } from "./config.js";
import { resolveGitRuntime } from "./git-runtimes.js";
import { assertCanonicalInsideVault, currentLocalFs, resolveVaultPath, toVaultPath } from "./vault-runtime/request-vault.js";

// Read immutable Git objects, never checkout/reset the working tree. The same
// selected Vault owns both this source and the existing mutation-plan writer.
export async function readGitNoteVersion(notePath, revision) {
  if (!/^(?:[0-9a-fA-F]{4,40}|HEAD(?:~(?:0|[1-9][0-9]{0,5}))?)$/.test(revision)) throw new Error("Invalid Git revision; use a commit, HEAD or HEAD~N");
  const abs = resolveVaultPath(notePath);
  const rel = toVaultPath(abs);
  if (!rel.toLowerCase().endsWith(".md")) throw new Error("Git restore supports Markdown notes only");
  await assertCanonicalInsideVault(abs, { allowMissing: true });
  const runtime = resolveGitRuntime();
  await runtime.assertRepository();
  const run = (args, options = {}) => runtime.runGit(args, { timeout: 10000, ...options });
  const root = await fs.realpath(currentLocalFs().root);
  const top = await run(["rev-parse", "--show-toplevel"]);
  if (path.resolve(await fs.realpath(top.stdout)) !== path.resolve(root)) throw new Error("Git repository must be rooted at the selected Vault");
  const commit = (await run(["rev-parse", "--verify", `${revision}^{commit}`])).stdout;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid resolved Git commit");
  const tree = await run(["--literal-pathspecs", "ls-tree", "--full-tree", commit, "--", rel]);
  const entry = /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(tree.stdout);
  if (!entry || tree.stdout.includes("\n")) throw new Error("Git source must be one regular file (not a symlink)");
  const size = Number((await run(["cat-file", "-s", entry[2]])).stdout);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_READ_BYTES) throw new Error("Git source exceeds MAX_READ_BYTES");
  const bytes = (await run(["cat-file", "blob", entry[2]], { rawStdout: true, maxBuffer: MAX_READ_BYTES + 1 })).stdout;
  const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (bytes.length !== size || content.includes("\0")) throw new Error("Git source must be UTF-8 Markdown text");
  // The journal only finalizes history when enabled. Never overwrite an existing
  // file through this new recovery path without its undo snapshot.
  return { path: rel, content, size, sourceRevision: commit };
}

export function assertGitRestoreHistory(existed) {
  if (existed && !VERSION_HISTORY_ENABLED) throw new Error("Git overwrite requires VERSION_HISTORY_ENABLED for undo");
}
