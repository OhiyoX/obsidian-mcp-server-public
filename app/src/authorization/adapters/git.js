// P2 / Task 17 — background Git tasks and the Git user operations.
// A new file outside the plan's file list: pure mapping plus observation, no decision.
//
// Contract: design §6.1.7. A background commit or push is a `system` task: it carries NO
// subject, so no account's time window can stop it, and it never borrows the last user's
// token. Its capability is `system_git_commit` or `system_git_push` on the Vault whose
// effective Git configuration and admission the runtime already checked.
//
// A user operation (`git_commit`, `git_push` through the tool) keeps its own subject and
// is recorded at the MCP boundary by the tool adapter (Task 10); nothing here replaces it.

import { verifiedActor } from "../actors.js";
import { withShadowRequest } from "../shadow.js";
import { authorizationOperation } from "../catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "../evaluate.js";

const C = AUTHORIZATION_DECISION_CODES;
const TASKS = Object.freeze({ commit: "system_git_commit", push: "system_git_push" });

/** The old worker's answer: the queued task started and the runtime will run it. */
export const GIT_LEGACY_VERDICTS = Object.freeze({
  allowed: Object.freeze({ allowed: true, code: C.ALLOWED }),
});

/** `systemGitActor({vaultId, task}) -> VerifiedActor|null` — no subject, one proof. */
export function systemGitActor({ vaultId, task } = {}) {
  if (typeof vaultId !== "string" || vaultId.length === 0 || !Object.hasOwn(TASKS, task)) return null;
  try {
    return verifiedActor("system", {
      subjectIds: [],
      credentialId: `system:git:${task}`,
      credentialEpochs: {},
      grantCeiling: null,
      audience: null,
      expiresAt: null,
      revoked: false,
      transferGeneration: 0,
      proof: { kind: "system", vaultId, task },
    });
  } catch {
    return null;
  }
}

/** `gitTaskAuthorizationRequest({vaultId, task})` -> `{actor, capability, target, surface}` */
export function gitTaskAuthorizationRequest({ vaultId, task } = {}) {
  const capability = TASKS[task];
  if (capability === undefined) return null;
  // A control operation with no boundary row of its own: its surface is declared in the
  // catalog, and the proof is the only thing that can authorize it.
  const operation = authorizationOperation(capability);
  if (operation === null || !operation.surfaces.includes("system")) return null;
  const actor = systemGitActor({ vaultId, task });
  if (actor === null) return null;
  // The transitional bridge phase: a background task is a trusted SYSTEM surface, decided by
  // the deployment's own config projection (P3/P6: the field disappears with the bridge).
  return { actor, capability, target: { kind: "vault", vaultId }, surface: "system", legacy: { phase: "system" } };
}

let taskSequence = 0;

/**
 * `observeGitTask({shadow, vaultId, task}) -> void`
 *
 * One row per background task that really started, in its own nested scope (the worker
 * may run outside any HTTP request). Observation only.
 */
export function observeGitTask({ shadow, vaultId, task } = {}) {
  if (shadow === null || shadow === undefined || typeof shadow.compare !== "function") return;
  const request = gitTaskAuthorizationRequest({ vaultId, task });
  if (request === null) return;
  const run = () => shadow.compare({ request, legacyDecision: GIT_LEGACY_VERDICTS.allowed, boundaryKey: request.capability, phase: "git" });
  if (typeof shadow.begin !== "function") {
    run();
    return;
  }
  const scope = shadow.begin({ requestId: `git-${taskSequence += 1}` });
  try {
    withShadowRequest(scope, run);
  } finally {
    scope.end();
  }
}
