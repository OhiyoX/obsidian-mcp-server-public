import { z } from "zod/v4";
import { commitGitFor, gitDiffFor, gitLogFor, gitStatusFor, pullGitFor, pushGitFor } from "../git.js";
import { refusalForError, resolveGitRuntime } from "../git-runtimes.js";
import { err, ok } from "../result.js";

/**
 * Wave D / D-git: every Git tool runs against the GitRuntime of the Vault the registrar selected
 * (`requestContext().vaultRuntime` -> `src/git-runtimes.js`), never against the primary facade
 * (contract §29 git lane, §16 per-vault GitRuntime, §21 MV-I07, §47 RETURN list).
 *
 * The three outcomes are distinguishable without prose:
 *   * no Vault selection at all (direct `registerGitTools(server)`, legacy fixtures) -> the primary
 *     repository, byte-identical to the pre-Wave-D behavior;
 *   * a selection whose repository is disabled / config-invalid / missing -> the A6 runtime's
 *     `git_runtime_*` code as a structured payload (the message the tool returned before is kept);
 *   * a selection with no materialized GitRuntime -> `vault_git_unavailable`, never the primary
 *     repository (SEC-MV06).
 */
async function runGitTool(work) {
  let runtime;
  try {
    runtime = resolveGitRuntime();
  } catch (error) {
    return refusalForError(error) ?? err(error);
  }
  try {
    return ok(await work(runtime));
  } catch (error) {
    return refusalForError(error, runtime.vaultId) ?? err(error);
  }
}

export function registerGitTools(server) {
  server.registerTool("git_status", {
    title: "Get Vault Git Status",
    description: "Show the mounted vault Git branch, working-tree changes, and pending MCP auto-commit paths.",
    inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => runGitTool((runtime) => gitStatusFor(runtime)));

  server.registerTool("git_diff", {
    title: "Get Vault Git Diff",
    description: "Show a bounded unstaged or staged diff for the vault or one vault-relative path.",
    inputSchema: { staged: z.boolean().default(false), path: z.string().optional(), maxChars: z.number().int().min(1000).max(500000).default(100000) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (options) => runGitTool((runtime) => gitDiffFor(runtime, options)));

  server.registerTool("git_log", {
    title: "Get Vault Git Log",
    description: "List recent commits in the mounted vault repository.",
    inputSchema: { limit: z.number().int().min(1).max(200).default(20) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => runGitTool(async (runtime) => ({ commits: await gitLogFor(runtime, limit) })));

  server.registerTool("git_commit", {
    title: "Commit Vault Changes",
      description: "Commit selected vault paths, or all changes only when includeAll=true. Records explicit or derived agent/model metadata in Git author metadata. Never pushes unless push=true.",
    inputSchema: { message: z.string().min(1), paths: z.array(z.string().min(1)).default([]), includeAll: z.boolean().default(false), push: z.boolean().default(false), remote: z.string().optional(), branch: z.string().optional() },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, async (options) => runGitTool((runtime) => commitGitFor(runtime, options)));

  server.registerTool("git_pull", {
    title: "Pull Vault Repository",
    description: "Run a fast-forward-only pull. Refuses to run when the vault has uncommitted changes.",
    inputSchema: { remote: z.string().optional(), branch: z.string().optional() }, annotations: { destructiveHint: true, openWorldHint: true },
  }, async (options) => runGitTool((runtime) => pullGitFor(runtime, options)));

  server.registerTool("git_push", {
    title: "Push Vault Repository",
    description: "Push committed vault changes to the configured or specified remote and branch.",
    inputSchema: { remote: z.string().optional(), branch: z.string().optional() }, annotations: { destructiveHint: true, openWorldHint: true },
  }, async (options) => runGitTool((runtime) => pushGitFor(runtime, options)));
}
