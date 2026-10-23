import { HttpApiError } from "./http-error.js";
import { createMutationJournal } from "./mutation-journal.js";

function sameIdentity(left, right) {
  return Boolean(left)
    && Boolean(right)
    && left.vaultId === right.vaultId
    && left.path === right.path
    && left.epoch === right.epoch;
}

/**
 * Document session state machine for open/refresh/save races.
 * Pure regarding transport: callers supply request executors and read live editor text.
 *
 * Active identity (vaultId/path/epoch/base*) only changes on successful commitOpen.
 * Navigation uses a pending ticket so failed/abandoned opens leave the current document intact.
 */
export function createDocumentSession({
  createMutationId = () => globalThis.crypto?.randomUUID?.() || `mutation:${Date.now()}:${Math.random()}`,
} = {}) {
  let vaultId = null;
  let path = null;
  let epoch = 0;
  let baseRevision = null;
  let baseText = "";
  let liveText = "";
  let editVersion = 0;
  let remoteRevision = null;
  let deleted = false;
  let loadSeq = 0;
  let refreshSeq = 0;
  let saveSeq = 0;
  let conflict = null;
  let saveInFlight = null;
  let saveChain = Promise.resolve();
  let pendingOpen = null;
  let writesSuspended = false;
  const mutationJournal = createMutationJournal({
    getInFlightMutation: () => saveInFlight,
    getBaseRevision: () => baseRevision,
  });

  function identity() {
    return { vaultId, path, epoch };
  }

  function isDirty() {
    return liveText !== baseText;
  }

  function statusFlags() {
    return {
      dirty: isDirty(),
      deleted,
      conflict: conflict ? { ...conflict } : null,
      remoteRevision,
      baseRevision,
      editVersion,
      path,
      vaultId,
      epoch,
      saveInFlight: Boolean(saveInFlight),
      pendingOpen: Boolean(pendingOpen),
      writesSuspended,
    };
  }

  function beginOpen({ vaultId: nextVaultId, path: nextPath }) {
    loadSeq += 1;
    // Invalidate in-flight refresh at the clear navigation point.
    refreshSeq += 1;
    const ticket = {
      kind: "open",
      requestSeq: loadSeq,
      targetVaultId: nextVaultId ?? vaultId,
      targetPath: nextPath,
      editVersion,
      baseRevision,
      saveSeq,
      // Active identity stays until successful commit.
      activeVaultId: vaultId,
      activePath: path,
      activeEpoch: epoch,
    };
    pendingOpen = ticket;
    return ticket;
  }

  function abandonOpen(request) {
    if (!request || request.kind !== "open") return false;
    if (pendingOpen && pendingOpen.requestSeq === request.requestSeq) {
      pendingOpen = null;
      return true;
    }
    return false;
  }

  function commitOpen(request, { content = "", revision = null, path: resolvedPath = null, vaultId: resolvedVaultId = null } = {}) {
    if (!request || request.kind !== "open") return { applied: false, reason: "invalid-request" };
    if (!pendingOpen || pendingOpen.requestSeq !== request.requestSeq || request.requestSeq !== loadSeq) {
      return { applied: false, reason: "stale-request" };
    }

    const targetPath = resolvedPath || request.targetPath;
    const targetVaultId = resolvedVaultId != null ? resolvedVaultId : request.targetVaultId;
    const sameActiveTarget = path != null
      && path === request.targetPath
      && vaultId === request.targetVaultId
      && path === targetPath
      && vaultId === targetVaultId;

    // Confirmation applies only to edits that existed when navigation/reload began.
    // New typing must survive even when the target is a DIFFERENT document.
    if (request.editVersion !== editVersion) {
      if (sameActiveTarget) remoteRevision = revision || remoteRevision || "changed";
      pendingOpen = null;
      return {
        applied: false,
        reason: "local-edit",
        recordRemoteOnly: true,
        remoteRevision,
        ...statusFlags(),
      };
    }
    if (sameActiveTarget && (request.baseRevision !== baseRevision || request.saveSeq !== saveSeq)) {
      pendingOpen = null;
      return { applied: false, reason: "save-baseline-changed", ...statusFlags() };
    }

    // Successful navigation/reload: bump epoch only here so prior saves keep matching until commit.
    epoch += 1;
    vaultId = targetVaultId;
    path = targetPath;
    baseText = String(content ?? "");
    liveText = baseText;
    baseRevision = revision;
    editVersion = 0;
    remoteRevision = null;
    deleted = false;
    conflict = null;
    pendingOpen = null;
    // Clear point: invalidate older refresh after identity changes.
    refreshSeq += 1;
    return {
      applied: true,
      content: liveText,
      revision: baseRevision,
      path,
      vaultId,
      ...statusFlags(),
    };
  }

  // Issue #410 (audit Cut D): drop the document identity entirely (the in-app welcome
  // workspace). A later save/refresh/guard can never touch the document that is no longer on
  // screen: the epoch bump fences every in-flight request of it, and the vault stays selected
  // — exactly the state a first load of the welcome page starts from. Callers ask the shared
  // unsaved-changes guard (features/session/unsaved-guard.js) before calling this.
  function closeDocument() {
    epoch += 1; path = null; baseRevision = null; baseText = ""; liveText = ""; editVersion = 0;
    remoteRevision = null; deleted = false; conflict = null; pendingOpen = null;
    loadSeq += 1; refreshSeq += 1;
    return { applied: true, ...statusFlags() };
  }

  function noteLocalEdit(text) {
    liveText = String(text ?? "");
    editVersion += 1;
    if (deleted && isDirty()) {
      // Local edits on a tombstone remain local; deleted flag stays until reload/recreate.
    }
    return statusFlags();
  }

  function setLiveText(text) {
    liveText = String(text ?? "");
    return statusFlags();
  }

  function beginRefresh() {
    if (!path) return null;
    if (pendingOpen) return null;
    refreshSeq += 1;
    // The refresh ticket is the identity plus the exact versions this GET starts from; the
    // caller's commit gates compare them field by field.
    return { vaultId, path, epoch, editVersion, loadSeq, refreshSeq, saveSeq, baseRevision, kind: "refresh", requestSeq: refreshSeq };
  }

  function commitRefresh(request, { content = "", revision = null, path: resolvedPath = null } = {}, { getLiveText } = {}) {
    if (!request || request.kind !== "refresh") return { applied: false, reason: "invalid-request" };
    if (pendingOpen) return { applied: false, reason: "pending-navigation" };
    if (!sameIdentity(request, identity())) return { applied: false, reason: "identity-mismatch" };
    if (request.requestSeq !== refreshSeq) return { applied: false, reason: "stale-request" };
    // Old refresh must not regress a successful save that landed while the GET was in flight.
    if (request.baseRevision !== baseRevision) return { applied: false, reason: "base-revision-changed", ...statusFlags() };
    if (request.saveSeq !== saveSeq) return { applied: false, reason: "save-seq-changed", ...statusFlags() };

    if (typeof getLiveText === "function") liveText = String(getLiveText() ?? "");

    const editedDuringRequest = request.editVersion !== editVersion || liveText !== baseText || isDirty();
    if (editedDuringRequest) {
      remoteRevision = revision || remoteRevision || "changed";
      return {
        applied: false,
        reason: "local-edit",
        recordRemoteOnly: true,
        remoteRevision,
        ...statusFlags(),
      };
    }

    if (revision != null && revision === baseRevision) {
      return { applied: false, reason: "same-revision", ...statusFlags() };
    }

    baseText = String(content ?? "");
    liveText = baseText;
    baseRevision = revision;
    remoteRevision = null;
    deleted = false;
    conflict = null;
    editVersion = 0;
    if (resolvedPath) path = resolvedPath;
    return {
      applied: true,
      content: liveText,
      revision: baseRevision,
      path,
      ...statusFlags(),
    };
  }

  function createSaveMutation() {
    if (!path) return null;
    saveSeq += 1;
    const mutationId = createMutationId();
    mutationJournal.begin(mutationId);
    return {
      kind: "save",
      vaultId,
      path,
      epoch,
      submittedText: liveText,
      submittedVersion: editVersion,
      baseRevision,
      mutationId,
      requestSeq: saveSeq,
      saveSeq,
    };
  }

  function rememberMutationRevision(mutationId, revision) {
    mutationJournal.commit(mutationId, revision);
  }

  function isSelfEchoEvent(event) {
    return mutationJournal.isSelfEcho(event);
  }

  function commitSave(mutation, { revision = null } = {}, { getLiveText } = {}) {
    if (!mutation || mutation.kind !== "save") return { applied: false, reason: "invalid-request" };
    if (!sameIdentity(mutation, identity())) {
      return { applied: false, reason: "identity-mismatch", touchCurrent: false };
    }
    if (typeof getLiveText === "function") liveText = String(getLiveText() ?? "");

    baseRevision = revision;
    baseText = mutation.submittedText;
    // A remote event can arrive after this save was accepted by the server but
    // before its response reaches the client. Do not let the older response
    // erase that newer remote state. A matching revision is the save's own
    // echo (or equivalent bytes) and is safe to clear.
    if (remoteRevision == null || remoteRevision === revision) {
      remoteRevision = null;
      deleted = false;
    }
    conflict = null;
    rememberMutationRevision(mutation.mutationId, revision);
    const dirty = liveText !== mutation.submittedText;
    return {
      applied: true,
      touchCurrent: true,
      revision: baseRevision,
      ...statusFlags(),
      dirty,
    };
  }

  function rejectSave(mutation, error) {
    const apiError = error instanceof HttpApiError ? error : new HttpApiError(error?.message || "保存失败", {
      status: error?.status || 0,
      code: error?.code,
      data: error?.data,
    });
    if (!mutation || !sameIdentity(mutation, identity())) {
      return { applied: false, reason: "identity-mismatch", error: apiError, touchCurrent: false };
    }
    // 409 is "the revision you gave is stale"; 428 is "you gave no revision for a note that exists"
    // (`precondition-required`, the shape #624 unified with PATCH /base). Both mean the same thing to
    // the operator — the local copy is not safe to write — so both enter the conflict state. The 428
    // body carries no revision, hence `remoteRevision` must tolerate the missing field (it already
    // falls back), and the "从磁盘重新载入" action refetches instead of trusting it.
    if (apiError.status === 409 || apiError.status === 428) {
      conflict = {
        status: apiError.status,
        code: apiError.code,
        message: apiError.message,
        localText: liveText,
        submittedText: mutation.submittedText,
        baseRevision: mutation.baseRevision,
        remoteRevision: apiError.data?.revision || remoteRevision || "conflict",
      };
      remoteRevision = conflict.remoteRevision;
      return {
        applied: true,
        hasConflict: true,
        error: apiError,
        touchCurrent: true,
        ...statusFlags(),
      };
    }
    return {
      applied: true,
      hasConflict: false,
      error: apiError,
      touchCurrent: true,
      ...statusFlags(),
    };
  }

  function resolveConflictByDiscardLocal(remote) {
    if (!conflict && !remote) return statusFlags();
    baseText = String(remote?.content ?? liveText);
    liveText = baseText;
    baseRevision = remote?.revision ?? baseRevision;
    conflict = null;
    remoteRevision = null;
    deleted = false;
    editVersion += 1;
    return { applied: true, content: liveText, revision: baseRevision, ...statusFlags() };
  }

  function clearConflictKeepingLocal() {
    conflict = null;
    return statusFlags();
  }

  function markDeleted(revision = "deleted") {
    deleted = true;
    remoteRevision = revision || "deleted";
    // Tombstone: retain liveText/baseText so the user can copy or save-as.
    return { applied: true, content: liveText, ...statusFlags() };
  }

  function markRemoteChanged(revision = "changed") {
    remoteRevision = revision || "changed";
    return statusFlags();
  }

  /**
   * Serialize saves. Identity is captured at enqueue time; if the active document
   * changes before the ticket runs, the save is dropped and never advances another note.
   */
  function enqueueSave(executor, { getLiveText } = {}) {
    if (writesSuspended) {
      const error = new HttpApiError("Vault 切换中，暂不能保存", { status: 0, code: "writes_suspended" });
      error.sessionResult = { applied: false, reason: "writes-suspended", touchCurrent: false, ...statusFlags() };
      return Promise.reject(error);
    }
    if (!path) return Promise.resolve(null);

    const captured = { vaultId, path, epoch };

    const run = saveChain.then(async () => {
      if (!sameIdentity(captured, identity())) {
        return { applied: false, reason: "identity-mismatch", touchCurrent: false };
      }
      if (writesSuspended) {
        return { applied: false, reason: "writes-suspended", touchCurrent: false, ...statusFlags() };
      }
      if (typeof getLiveText === "function") liveText = String(getLiveText() ?? "");
      if (!path) return null;

      // Queued work after a conflict must not auto-retry into another POST. The status reported here
      // is the conflict's own (409 stale revision, or 428 precondition-required): the operator's
      // recovery path is the same, and a hard-coded 409 would mislabel a 428-originated conflict.
      // The 428 body carries no revision, so `revision` is only forwarded when we actually have one.
      if (conflict) {
        // A revision is `sha256:<hex>` (src/vault-runtime/local-fs.js#fileRevision; the local
        // `revision(buffer)` in src/app/vault-registry.js:388 builds the same shape). Everything else that
        // can end up in `remoteRevision` is an internal SENTINEL, not a revision: "conflict" (no body
        // revision at all), "changed" (a refresh saw a different revision without storing it) and
        // "deleted" (a tombstone). Forwarding any of them as `data.revision` would put a non-revision
        // into an API payload, so the guard is a shape check, not a blacklist of one string.
        const remote = conflict.remoteRevision;
        const knownRevision = typeof remote === "string" && /^sha256:[0-9a-f]{64}$/.test(remote) ? remote : null;
        const error = new HttpApiError(conflict.message || "存在未解决的保存冲突", {
          status: conflict.status ?? 409,
          code: conflict.code,
          data: knownRevision ? { revision: knownRevision } : {},
        });
        error.sessionResult = {
          applied: false,
          reason: "unresolved-conflict",
          hasConflict: true,
          touchCurrent: true,
          ...statusFlags(),
        };
        throw error;
      }
      if (!isDirty()) return null;

      const mutation = createSaveMutation();
      if (!sameIdentity(mutation, captured)) {
        return { applied: false, reason: "identity-mismatch", touchCurrent: false };
      }
      saveInFlight = mutation;
      try {
        const result = await executor(mutation);
        if (!sameIdentity(mutation, identity())) {
          return { applied: false, reason: "identity-mismatch", touchCurrent: false };
        }
        return commitSave(mutation, result, { getLiveText });
      } catch (error) {
        const rejected = rejectSave(mutation, error);
        const wrapped = rejected.error || (error instanceof Error ? error : new Error(String(error || "保存失败")));
        wrapped.sessionResult = rejected;
        throw wrapped;
      } finally {
        if (saveInFlight === mutation) saveInFlight = null;
      }
    });
    saveChain = run.catch(() => {});
    return run;
  }

  function setWritesSuspended(value) {
    writesSuspended = Boolean(value);
    return statusFlags();
  }

  function invalidateInFlightReads() {
    loadSeq += 1;
    refreshSeq += 1;
    pendingOpen = null;
    return statusFlags();
  }

  function whenSavesIdle() {
    return saveChain.then(() => null, () => null);
  }

  function getState() {
    return {
      ...statusFlags(),
      baseText,
      liveText,
      loadSeq,
      refreshSeq,
      saveSeq,
      identity: identity(),
      pendingOpen: pendingOpen ? { ...pendingOpen } : null,
    };
  }

  return {
    HttpApiError,
    beginOpen,
    abandonOpen,
    commitOpen,
    closeDocument,
    beginRefresh,
    commitRefresh,
    noteLocalEdit,
    setLiveText,
    createSaveMutation,
    commitSave,
    rejectSave,
    enqueueSave,
    markDeleted,
    markRemoteChanged,
    resolveConflictByDiscardLocal,
    clearConflictKeepingLocal,
    isSelfEchoEvent,
    rememberMutationRevision,
    setWritesSuspended,
    invalidateInFlightReads,
    whenSavesIdle,
    isDirty,
    getState,
    identity,
    statusFlags,
    get conflict() { return conflict ? { ...conflict } : null; },
    get deleted() { return deleted; },
    get remoteRevision() { return remoteRevision; },
    get baseRevision() { return baseRevision; },
    get editVersion() { return editVersion; },
    get path() { return path; },
    get vaultId() { return vaultId; },
    get epoch() { return epoch; },
    get liveText() { return liveText; },
    get baseText() { return baseText; },
    get saveInFlight() { return saveInFlight; },
    get pendingOpen() { return pendingOpen ? { ...pendingOpen } : null; },
    get writesSuspended() { return writesSuspended; },
  };
}
