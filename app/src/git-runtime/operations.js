// Git command layer of the per-vault GitRuntime (Wave A / A6).
//
// Frozen semantics preserved from `app/src/git.js` (W0-D §4-§8): the `-C <root>`
// + `safe.directory=<root>` binding, the commit/push argument shapes and message
// trailers, the `diff --cached --quiet` staging probe, per-author batch commits,
// "commit kept when push fails", push classification/scrubbing, and the
// serializing queue contract.
//
// The class is stateless about *identity*: it receives the runtime's instance
// hooks (enabled config, repo probe, pending model, push-outcome sink, logger)
// and never reads ambient config, environment or request context.

import {
  GIT_RUNTIME_CODES as CODES,
  GitRuntimeError,
  MCP_COMMIT_MESSAGE,
  normalizeAuthor,
  tryRef,
  validateRemoteOrBranch,
} from "./support.js";
import {
  classifyPushFailure,
  formatPushFailureLog,
  scrubCredentials,
} from "../git-push-observability.js";

export class GitOperations {
  #root;
  #exec;
  #execEnv;
  #maxBuffer;
  #authorEmail;
  #pending;
  #history;
  #logger;
  #enabledConfig;
  #currentConfig;
  #probe;
  #idleCleanup;
  #recoverPending;

  constructor(host) {
    this.#root = host.root;
    this.#exec = host.exec;
    this.#execEnv = host.execEnv;
    this.#maxBuffer = host.maxBuffer;
    this.#authorEmail = host.authorEmail;
    this.#pending = host.pending;
    this.#history = host.history;
    this.#logger = host.logger;
    this.#enabledConfig = host.enabledConfig;
    this.#currentConfig = host.currentConfig;
    this.#probe = host.probe;
    this.#idleCleanup = host.idleCleanup;
    this.#recoverPending = host.recoverPending;
  }

  // W0-D §7: every command is bound to this runtime's root, and safe.directory is
  // set for that same root.
  baseArgs() {
    return ["-c", `safe.directory=${this.#root}`, "-c", "core.quotepath=false", "-C", this.#root];
  }

  async runGit(args, options = {}) {
    this.#enabledConfig();
    try {
      const result = await this.#exec("git", [...this.baseArgs(), ...args], {
        encoding: "utf-8",
        maxBuffer: options.maxBuffer ?? this.#maxBuffer,
        ...(this.#execEnv ? { env: typeof this.#execEnv === "function" ? this.#execEnv() : { ...this.#execEnv } } : {}),
      });
      return { stdout: String(result?.stdout ?? "").trimEnd(), stderr: String(result?.stderr ?? "").trimEnd(), exitCode: 0 };
    } catch (error) {
      if (options.allowExitCodes?.includes(error?.code)) {
        return { stdout: String(error.stdout || "").trimEnd(), stderr: String(error.stderr || "").trimEnd(), exitCode: error.code };
      }
      const detail = String(error?.stderr || error?.stdout || error?.message || "").trim();
      // Keep the machine-readable parts: push classification needs the exit code
      // and the raw stderr, not just the flattened message.
      const failure = new GitRuntimeError(CODES.COMMAND_FAILED, `git ${args[0]} failed: ${detail}`);
      failure.gitCommand = args[0];
      failure.exitCode = typeof error?.code === "number" ? error.code : null;
      failure.stderr = String(error?.stderr || "");
      failure.stdout = String(error?.stdout || "");
      throw failure;
    }
  }

  async assertRepository() {
    const state = await this.#probe();
    if (state !== "ready") {
      throw new GitRuntimeError(CODES.REPOSITORY_MISSING, "The mounted vault is not a Git working tree");
    }
  }

  async currentHead() {
    return (await this.runGit(["rev-parse", "HEAD"])).stdout;
  }

  async workTreeStatus() {
    const result = await this.runGit(["status", "--branch", "--porcelain=v1"]);
    const lines = result.stdout ? result.stdout.split("\n") : [];
    if (lines[0]?.startsWith("## ")) lines.shift();
    return { clean: lines.length === 0, changes: lines };
  }

  async commitUnlocked(options = {}) {
    await this.assertRepository();
    const author = normalizeAuthor(options.author);
    const paths = (options.paths || []).map((item) => this.#pending.normalize(item));
    if (!options.includeAll && paths.length === 0) {
      throw new GitRuntimeError(CODES.NO_PATHS, "Provide paths or set includeAll=true");
    }
    // A commit may only consume the batch that existed before it touched the index.
    const pendingSinceBefore = this.#pending.since;
    const detached = options.consumePending ? this.#pending.take(options.includeAll ? null : paths) : null;
    try {
      if (options.includeAll) await this.runGit(["add", "--all"]);
      else await this.runGit(["add", "--all", "--", ...paths]);
      const diffArgs = ["diff", "--cached", "--quiet"];
      if (!options.includeAll) diffArgs.push("--", ...paths);
      const staged = await this.runGit(diffArgs, { allowExitCodes: [1] });
      if (staged.exitCode === 0) {
        this.#restorePending(detached, pendingSinceBefore);
        return { committed: false, reason: "No staged changes", paths };
      }
      const message = `${options.message?.trim() || MCP_COMMIT_MESSAGE}\n\nMCP-Agent: ${author.agent}\nMCP-Model: ${author.model}`;
      const commitArgs = [
        "-c", `user.name=${author.agent} (${author.model})`,
        "-c", `user.email=${this.#authorEmail}`,
        "commit", "--no-gpg-sign", "-m", message,
      ];
      if (!options.includeAll) commitArgs.push("--only", "--", ...paths);
      await this.runGit(commitArgs);
      const hash = await this.currentHead();
      this.#idleCleanup();
      const result = { committed: true, hash, message, author, paths: options.includeAll ? ["*"] : paths };
      if (options.push) {
        // A failed push must never undo a committed batch (W0-D §5): report it.
        try {
          result.push = await this.pushUnlocked({ remote: options.remote, branch: options.branch });
        } catch (error) {
          result.push = error.pushOutcome || {
            pushed: false,
            remote: tryRef(options.remote ?? this.#currentConfig()?.remote, "remote"),
            branch: tryRef(options.branch ?? this.#currentConfig()?.branch, "branch"),
            exitCode: error.exitCode ?? null,
            failureClass: "unknown",
            summary: scrubCredentials(error.message),
          };
        }
        result.pushed = result.push.pushed === true;
      }
      return result;
    } catch (error) {
      this.#restorePending(detached, pendingSinceBefore);
      throw error;
    }
  }

  // W0-D §2/§3: a restored batch must recover its scheduling as well as its data — the
  // pre-migration `restorePendingBatches()` ended in `armPendingTimers()`, so an expired oldest
  // deadline / a failed manual commit still has a future automatic retry.
  #restorePending(batches, since) {
    this.#pending.restore(batches, since);
    this.#recoverPending();
  }

  async pullUnlocked(options = {}) {
    await this.assertRepository();
    const status = await this.workTreeStatus();
    if (!status.clean) {
      throw new GitRuntimeError(CODES.COMMAND_FAILED, "Refusing to pull with uncommitted changes; commit or clean the vault first");
    }
    const config = this.#enabledConfig();
    const remote = validateRemoteOrBranch(options.remote ?? config.remote, "remote");
    const branch = validateRemoteOrBranch(options.branch ?? config.branch, "branch");
    const args = ["pull", "--ff-only", remote];
    if (branch) args.push(branch);
    const result = await this.runGit(args);
    return { pulled: true, remote, branch: branch || null, output: result.stdout || result.stderr, head: await this.currentHead() };
  }

  async pushUnlocked(options = {}) {
    await this.assertRepository();
    const config = this.#enabledConfig();
    const remote = validateRemoteOrBranch(options.remote ?? config.remote, "remote");
    const args = ["push", remote];
    const branch = validateRemoteOrBranch(options.branch ?? config.branch, "branch");
    if (branch) args.push(branch);
    const head = await this.currentHead();
    try {
      const result = await this.runGit(args);
      this.#history.recordPushOutcome({ pushed: true, remote, branch: branch || null, exitCode: 0, failureClass: null, summary: null, head });
      return { pushed: true, remote, branch: branch || null, output: scrubCredentials(result.stdout || result.stderr), head };
    } catch (error) {
      const outcome = this.#history.recordPushOutcome({
        pushed: false,
        remote,
        branch: branch || null,
        exitCode: error.exitCode ?? null,
        failureClass: classifyPushFailure(error),
        summary: scrubCredentials(error.stderr || error.stdout || error.message),
        head,
      });
      this.#logger.log("warn", formatPushFailureLog(outcome));
      const pushError = new GitRuntimeError(CODES.COMMAND_FAILED, `git push failed [${outcome.failureClass}]: ${outcome.summary}`);
      pushError.pushOutcome = outcome;
      pushError.exitCode = outcome.exitCode;
      throw pushError;
    }
  }
}
