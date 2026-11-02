import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentSession, HttpApiError } from "../frontend/app/features/session/index.js";
import { normalizeLiveEvent } from "../frontend/app/features/sync/live-events.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openDoc(session, { vaultId = "vault-a", path = "A.md", content = "base", revision = "r1" } = {}) {
  const request = session.beginOpen({ vaultId, path });
  const result = session.commitOpen(request, { content, revision, path, vaultId });
  assert.equal(result.applied, true);
  return result;
}

test("refresh does not overwrite edits made before response body settles", async () => {
  const session = createDocumentSession();
  openDoc(session, { content: "old", revision: "r1" });

  const request = session.beginRefresh();
  session.noteLocalEdit("new local typing");

  const result = session.commitRefresh(request, {
    content: "remote",
    revision: "r2",
  }, { getLiveText: () => "new local typing" });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "local-edit");
  assert.equal(result.recordRemoteOnly, true);
  assert.equal(session.liveText, "new local typing");
  assert.equal(session.isDirty(), true);
  assert.equal(session.baseRevision, "r1");
  assert.equal(session.remoteRevision, "r2");
});

test("stale refresh for previous note cannot contaminate the active note", () => {
  const session = createDocumentSession();
  openDoc(session, { path: "A.md", content: "A local", revision: "r2" });

  const refreshA = session.beginRefresh();
  openDoc(session, { path: "B.md", content: "B content", revision: "B-r1" });

  const result = session.commitRefresh(refreshA, {
    content: "A remote",
    revision: "r3",
    path: "A.md",
  });

  assert.equal(result.applied, false);
  assert.ok(["identity-mismatch", "stale-request"].includes(result.reason));
  assert.equal(session.path, "B.md");
  assert.equal(session.liveText, "B content");
  assert.equal(session.baseRevision, "B-r1");
});

test("stale open response cannot replace a newer note selection", () => {
  const session = createDocumentSession();
  const openA = session.beginOpen({ vaultId: "vault-a", path: "A.md" });
  const openB = session.beginOpen({ vaultId: "vault-a", path: "B.md" });

  const stale = session.commitOpen(openA, { content: "A remote", revision: "A-r3", path: "A.md" });
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, "stale-request");

  const fresh = session.commitOpen(openB, { content: "B content", revision: "B-r1", path: "B.md" });
  assert.equal(fresh.applied, true);
  assert.equal(session.liveText, "B content");
  assert.equal(session.path, "B.md");
});

test("pending B open leaves A identity so typing and save stay on A", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-a" });
  openDoc(session, { path: "A.md", content: "A base", revision: "A1" });

  const openB = session.beginOpen({ vaultId: "vault-a", path: "B.md" });
  assert.equal(session.path, "A.md");
  assert.equal(session.pendingOpen?.targetPath, "B.md");
  assert.equal(session.beginRefresh(), null);

  session.noteLocalEdit("A typed during B open");
  const submissions = [];
  const saved = await session.enqueueSave(async (mutation) => {
    submissions.push({ path: mutation.path, text: mutation.submittedText });
    return { revision: "A2" };
  });

  assert.deepEqual(submissions, [{ path: "A.md", text: "A typed during B open" }]);
  assert.equal(saved.applied, true);
  assert.equal(session.path, "A.md");
  assert.equal(session.baseRevision, "A2");
  assert.equal(session.liveText, "A typed during B open");

  session.abandonOpen(openB);
  assert.equal(session.path, "A.md");
  assert.equal(session.liveText, "A typed during B open");
  assert.equal(session.pendingOpen, null);
});

test("failed latest open then older response cannot apply", () => {
  const session = createDocumentSession();
  openDoc(session, { path: "A.md", content: "A", revision: "A1" });

  const openB = session.beginOpen({ vaultId: "vault-a", path: "B.md" });
  const openC = session.beginOpen({ vaultId: "vault-a", path: "C.md" });
  session.abandonOpen(openC);

  assert.equal(session.path, "A.md");
  assert.equal(session.liveText, "A");

  const lateB = session.commitOpen(openB, { content: "B late", revision: "B1", path: "B.md" });
  assert.equal(lateB.applied, false);
  assert.equal(lateB.reason, "stale-request");
  assert.equal(session.path, "A.md");
  assert.equal(session.liveText, "A");

  const lateC = session.commitOpen(openC, { content: "C late", revision: "C1", path: "C.md" });
  assert.equal(lateC.applied, false);
  assert.equal(session.path, "A.md");
});

test("A/B reversal: late A cannot replace committed B", () => {
  const session = createDocumentSession();
  const openA = session.beginOpen({ vaultId: "vault-a", path: "A.md" });
  const openB = session.beginOpen({ vaultId: "vault-a", path: "B.md" });

  assert.equal(session.path, null);

  const b = session.commitOpen(openB, { content: "B content", revision: "B1", path: "B.md" });
  assert.equal(b.applied, true);
  session.noteLocalEdit("B local typing");

  const a = session.commitOpen(openA, { content: "A content", revision: "A1", path: "A.md" });
  assert.equal(a.applied, false);
  assert.equal(a.reason, "stale-request");
  assert.equal(session.path, "B.md");
  assert.equal(session.liveText, "B local typing");
});

test("same-document reload protects edits made while reload pending", () => {
  const session = createDocumentSession();
  openDoc(session, { path: "A.md", content: "disk", revision: "r1" });
  const reload = session.beginOpen({ vaultId: "vault-a", path: "A.md" });
  session.noteLocalEdit("typed during reload");
  const result = session.commitOpen(reload, { content: "disk-new", revision: "r2", path: "A.md" });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "local-edit");
  assert.equal(session.liveText, "typed during reload");
  assert.equal(session.baseRevision, "r1");
  assert.equal(session.remoteRevision, "r2");
  assert.equal(session.path, "A.md");
});

test("save during new input keeps dirty and updates baseline revision", async () => {
  let live = "save snapshot";
  const session = createDocumentSession({ createMutationId: () => "m1" });
  openDoc(session, { content: "old", revision: "r1" });
  session.noteLocalEdit(live);

  const gate = deferred();
  const started = deferred();
  const pending = session.enqueueSave(async (mutation) => {
    started.resolve(mutation);
    await gate.promise;
    return { revision: "saved-r" };
  }, { getLiveText: () => live });

  const mutation = await started.promise;
  assert.equal(mutation.submittedText, "save snapshot");
  live = "typed after request";
  session.noteLocalEdit(live);
  gate.resolve();

  const result = await pending;
  assert.equal(result.applied, true);
  assert.equal(result.dirty, true);
  assert.equal(session.baseRevision, "saved-r");
  assert.equal(session.baseText, "save snapshot");
  assert.equal(session.liveText, "typed after request");
  assert.equal(session.isDirty(), true);
});

test("save requests are serialized and a queued save uses latest text", async () => {
  const session = createDocumentSession({
    createMutationId: (() => {
      let n = 0;
      return () => `m${++n}`;
    })(),
  });
  openDoc(session, { content: "v0", revision: "r0" });

  let live = "v1";
  session.noteLocalEdit(live);
  const firstGate = deferred();
  const firstStarted = deferred();
  const submissions = [];

  const first = session.enqueueSave(async (mutation) => {
    submissions.push(mutation.submittedText);
    firstStarted.resolve(mutation);
    await firstGate.promise;
    return { revision: "r1" };
  }, { getLiveText: () => live });

  await firstStarted.promise;
  live = "v2";
  session.noteLocalEdit(live);
  const second = session.enqueueSave(async (mutation) => {
    submissions.push(mutation.submittedText);
    return { revision: "r2" };
  }, { getLiveText: () => live });

  firstGate.resolve();
  const firstResult = await first;
  const secondResult = await second;

  assert.deepEqual(submissions, ["v1", "v2"]);
  assert.equal(firstResult.dirty, true);
  assert.equal(secondResult.dirty, false);
  assert.equal(session.baseRevision, "r2");
  assert.equal(session.isDirty(), false);
});

test("queued save for A is dropped after switch to B and never posts B", async () => {
  const session = createDocumentSession({
    createMutationId: (() => {
      let n = 0;
      return () => `m${++n}`;
    })(),
  });
  openDoc(session, { path: "A.md", content: "A0", revision: "A0" });
  session.noteLocalEdit("A dirty");

  const gate = deferred();
  const started = deferred();
  const submissions = [];

  const first = session.enqueueSave(async (mutation) => {
    submissions.push(mutation.path);
    started.resolve(mutation);
    await gate.promise;
    return { revision: "A1" };
  });

  await started.promise;
  // Queue another save while A is in flight, then switch to B before it runs.
  const queued = session.enqueueSave(async (mutation) => {
    submissions.push(mutation.path);
    return { revision: "should-not-matter" };
  });
  openDoc(session, { path: "B.md", content: "B0", revision: "B0" });
  gate.resolve();

  const firstResult = await first;
  const queuedResult = await queued;
  assert.equal(firstResult.applied, false);
  assert.equal(firstResult.reason, "identity-mismatch");
  assert.equal(firstResult.touchCurrent, false);
  assert.equal(queuedResult.applied, false);
  assert.equal(queuedResult.reason, "identity-mismatch");
  assert.deepEqual(submissions, ["A.md"]);
  assert.equal(session.path, "B.md");
  assert.equal(session.baseRevision, "B0");
  assert.equal(session.liveText, "B0");
});

test("409 conflict blocks queued follow-up save", async () => {
  const session = createDocumentSession({
    createMutationId: (() => {
      let n = 0;
      return () => `m${++n}`;
    })(),
  });
  openDoc(session, { content: "local", revision: "r1" });
  session.noteLocalEdit("local edited");

  const gate = deferred();
  const started = deferred();
  let posts = 0;

  const first = session.enqueueSave(async () => {
    posts += 1;
    started.resolve();
    await gate.promise;
    throw new HttpApiError("版本冲突", {
      status: 409,
      code: "conflict",
      data: { revision: "disk-r2" },
    });
  });

  await started.promise;
  const queued = session.enqueueSave(async () => {
    posts += 1;
    return { revision: "should-not-run" };
  });

  gate.resolve();
  await assert.rejects(() => first, (error) => error.status === 409);
  await assert.rejects(() => queued, (error) => error.status === 409);
  assert.equal(posts, 1);
  assert.equal(session.conflict?.status, 409);
});

test("refresh issued before save success completing after cannot regress revision", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-refresh-race" });
  openDoc(session, { content: "v0", revision: "r0" });
  session.noteLocalEdit("v1");

  const saveGate = deferred();
  const saveStarted = deferred();
  const saving = session.enqueueSave(async () => {
    saveStarted.resolve();
    await saveGate.promise;
    return { revision: "r1" };
  });

  await saveStarted.promise;
  const refresh = session.beginRefresh();
  assert.equal(refresh.baseRevision, "r0");
  assert.equal(refresh.saveSeq, session.getState().saveSeq);

  saveGate.resolve();
  const saved = await saving;
  assert.equal(saved.applied, true);
  assert.equal(session.baseRevision, "r1");

  const refreshResult = session.commitRefresh(refresh, { content: "stale remote", revision: "r0-stale" });
  assert.equal(refreshResult.applied, false);
  assert.ok(["base-revision-changed", "save-seq-changed"].includes(refreshResult.reason));
  assert.equal(session.baseRevision, "r1");
  assert.equal(session.liveText, "v1");
});

test("409 conflict persists until explicit reload or discard resolution", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-conflict" });
  openDoc(session, { content: "local", revision: "r1" });
  session.noteLocalEdit("local edited");

  await assert.rejects(
    () => session.enqueueSave(async () => {
      throw new HttpApiError("版本冲突", {
        status: 409,
        code: "conflict",
        data: { revision: "disk-r2" },
      });
    }, { getLiveText: () => session.liveText }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.sessionResult.hasConflict, true);
      return true;
    },
  );

  assert.equal(session.conflict?.status, 409);
  assert.equal(session.liveText, "local edited");
  assert.equal(session.baseRevision, "r1");

  await assert.rejects(
    () => session.enqueueSave(async () => ({ revision: "should-not-run" }), { getLiveText: () => session.liveText }),
    (error) => error.status === 409,
  );

  const reloaded = session.resolveConflictByDiscardLocal({ content: "disk text", revision: "disk-r2" });
  assert.equal(reloaded.applied, true);
  assert.equal(session.conflict, null);
  assert.equal(session.liveText, "disk text");
  assert.equal(session.baseRevision, "disk-r2");
  assert.equal(session.isDirty(), false);
});

// #624: the legacy write face unifies "you gave no precondition for an existing note" onto HTTP 428
// (`precondition-required`, the same body shape as `PATCH /base`), while a STALE revision stays 409.
// The client keys its whole conflict UX (conflict bar, "从磁盘重新载入" / "复制本地内容") on 409
// alone — see `core/app.js`'s save catch as well — so without this the operator would fall into the
// generic `保存失败 (428)` branch and lose the recovery path. This test is the pin: a 428 must land
// in the SAME conflict state, and the 428 body carries NO revision, so nothing may depend on one.
test("428 precondition-required enters the same conflict state as 409 (no revision in the body)", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-precondition" });
  openDoc(session, { content: "local", revision: "r1" });
  session.noteLocalEdit("local edited");

  await assert.rejects(
    () => session.enqueueSave(async () => {
      // Exactly the body the server now returns: error/code/message, and no revision.
      throw new HttpApiError("Precondition required: existing notes need If-Match", {
        status: 428,
        code: "precondition-required",
        data: { error: "precondition-required", code: "precondition-required" },
      });
    }, { getLiveText: () => session.liveText }),
    (error) => {
      assert.equal(error.status, 428);
      assert.equal(error.sessionResult.hasConflict, true, "428 must set the conflict state, not a generic failure");
      return true;
    },
  );

  assert.equal(session.conflict?.status, 428);
  assert.equal(session.conflict?.code, "precondition-required");
  // The 428 body has no revision: the fallback must be a non-empty placeholder, never undefined.
  assert.equal(typeof session.conflict?.remoteRevision, "string");
  assert.notEqual(session.conflict?.remoteRevision, "undefined");
  assert.equal(session.liveText, "local edited", "the local edit must survive so the operator can copy it");
  assert.equal(session.baseRevision, "r1");

  // The queued follow-up save is still blocked while the conflict stands.
  await assert.rejects(
    () => session.enqueueSave(async () => ({ revision: "should-not-run" }), { getLiveText: () => session.liveText }),
    (error) => error.status === 428,
  );

  // The internal sentinels are NOT revisions. `remoteRevision` can hold "conflict" (no body revision),
  // "changed" (a refresh observed a different revision without storing it) or "deleted" (a tombstone);
  // forwarding any of them as `data.revision` would put a non-revision into an API payload. This axis
  // had no assertion when the guard was a single-string blacklist (review follow-up B2).
  for (const sentinel of ["conflict", "changed", "deleted"]) {
    const s = createDocumentSession({ createMutationId: () => `m-sentinel-${sentinel}` });
    openDoc(s, { content: "base", revision: "sha256:" + "a".repeat(64) });
    s.noteLocalEdit("edited");
    // Put THIS sentinel into the conflict object through the same field the server uses, so the loop
    // really exercises three different values instead of the same default three times.
    await assert.rejects(
      () => s.enqueueSave(async () => {
        throw new HttpApiError("冲突", { status: 409, code: "conflict", data: { revision: sentinel } });
      }, { getLiveText: () => s.liveText }),
      () => true,
    );
    assert.equal(s.conflict?.remoteRevision, sentinel, "the sentinel must be what the conflict object holds");
    await assert.rejects(
      () => s.enqueueSave(async () => ({ revision: "should-not-run" }), { getLiveText: () => s.liveText }),
      (error) => {
        assert.equal(error.data?.revision, undefined, `the ${sentinel} sentinel must never travel as data.revision`);
        return true;
      },
    );
  }

  // A real revision (sha256:<64 hex>) IS forwarded, so the guard is a shape check and not a blanket drop.
  {
    const s = createDocumentSession({ createMutationId: () => "m-real-rev" });
    const real = "sha256:" + "b".repeat(64);
    openDoc(s, { content: "base", revision: real });
    s.noteLocalEdit("edited");
    await assert.rejects(
      () => s.enqueueSave(async () => {
        throw new HttpApiError("版本冲突", { status: 409, code: "conflict", data: { revision: real } });
      }, { getLiveText: () => s.liveText }),
      () => true,
    );
    await assert.rejects(
      () => s.enqueueSave(async () => ({ revision: "should-not-run" }), { getLiveText: () => s.liveText }),
      (error) => {
        assert.equal(error.data?.revision, real, "a genuine sha256 revision must still be forwarded");
        return true;
      },
    );
  }

  // "从磁盘重新载入" refetches; it must work without ever having received a revision.
  const reloaded = session.resolveConflictByDiscardLocal({ content: "disk text", revision: "disk-r2" });
  assert.equal(reloaded.applied, true);
  assert.equal(session.conflict, null);
  assert.equal(session.liveText, "disk text");
  assert.equal(session.baseRevision, "disk-r2");
});

test("deletion tombstone keeps content and does not pretend save succeeded", () => {
  const session = createDocumentSession();
  openDoc(session, { content: "keep me", revision: "r1" });
  const flags = session.markDeleted("deleted");
  assert.equal(flags.deleted, true);
  assert.equal(flags.content, "keep me");
  assert.equal(session.liveText, "keep me");
  assert.equal(session.baseText, "keep me");
  assert.notEqual(session.remoteRevision, null);
  assert.equal(session.isDirty(), false);
});

test("save response for a previous note does not touch the current document", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-old" });
  openDoc(session, { path: "A.md", content: "A", revision: "A1" });
  session.noteLocalEdit("A edited");

  const gate = deferred();
  const started = deferred();
  const pending = session.enqueueSave(async (mutation) => {
    assert.equal(mutation.path, "A.md");
    started.resolve(mutation);
    await gate.promise;
    return { revision: "A2" };
  }, { getLiveText: () => session.liveText });

  await started.promise;
  openDoc(session, { path: "B.md", content: "B", revision: "B1" });
  gate.resolve();
  const result = await pending;
  assert.equal(result.applied, false);
  assert.equal(result.reason, "identity-mismatch");
  assert.equal(result.touchCurrent, false);
  assert.equal(session.path, "B.md");
  assert.equal(session.baseRevision, "B1");
  assert.equal(session.liveText, "B");
});

test("self echo matches exact mutation id and revision; newer remote is not hidden", async () => {
  const session = createDocumentSession({ createMutationId: () => "web:tab:mut-1" });
  openDoc(session, { content: "text", revision: "r1" });
  session.noteLocalEdit("text saved");
  const saved = await session.enqueueSave(async () => ({ revision: "r2" }));
  assert.equal(saved.applied, true);
  assert.equal(session.baseRevision, "r2");

  assert.equal(
    session.isSelfEchoEvent({ mutationId: "web:tab:mut-1", revision: "r2", origin: "web" }),
    true,
  );
  assert.equal(
    session.isSelfEchoEvent({ mutationId: "web:tab:mut-1", revision: "r3", origin: "web" }),
    false,
  );
  assert.equal(
    session.isSelfEchoEvent({ mutationId: null, revision: "r3", origin: "web:tab" }),
    false,
  );
  assert.equal(
    session.isSelfEchoEvent({ mutationId: null, revision: "r2", origin: "web:tab" }),
    false,
  );
});

test("save success preserves a newer remote revision observed while the request is in flight", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-remote-during-save" });
  openDoc(session, { content: "base", revision: "r1" });
  session.noteLocalEdit("local save");

  const gate = deferred();
  const started = deferred();
  const pending = session.enqueueSave(async () => {
    started.resolve();
    await gate.promise;
    return { revision: "r2" };
  });

  await started.promise;
  session.markRemoteChanged("r3");
  gate.resolve();

  const result = await pending;
  assert.equal(result.applied, true);
  assert.equal(session.baseRevision, "r2");
  assert.equal(session.remoteRevision, "r3");
  assert.equal(result.remoteRevision, "r3");
});

test("save success preserves a deletion tombstone observed while the request is in flight", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-delete-during-save" });
  openDoc(session, { content: "base", revision: "r1" });
  session.noteLocalEdit("local save");

  const gate = deferred();
  const started = deferred();
  const pending = session.enqueueSave(async () => {
    started.resolve();
    await gate.promise;
    return { revision: "r2" };
  });

  await started.promise;
  session.markDeleted("deleted-after-save");
  gate.resolve();

  const result = await pending;
  assert.equal(result.applied, true);
  assert.equal(session.baseRevision, "r2");
  assert.equal(session.deleted, true);
  assert.equal(session.remoteRevision, "deleted-after-save");
  assert.equal(result.deleted, true);
  assert.equal(result.remoteRevision, "deleted-after-save");
});

test("save success clears an in-flight remote marker when it matches the committed revision", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-matching-remote-during-save" });
  openDoc(session, { content: "base", revision: "r1" });
  session.noteLocalEdit("local save");

  const gate = deferred();
  const started = deferred();
  const pending = session.enqueueSave(async () => {
    started.resolve();
    await gate.promise;
    return { revision: "r2" };
  });

  await started.promise;
  session.markRemoteChanged("r2");
  gate.resolve();

  const result = await pending;
  assert.equal(result.applied, true);
  assert.equal(session.baseRevision, "r2");
  assert.equal(session.remoteRevision, null);
  assert.equal(session.deleted, false);
});

test("writes suspended blocks enqueue and idle wait resolves after in-flight save", async () => {
  const session = createDocumentSession({ createMutationId: () => "m-vault" });
  openDoc(session, { content: "a", revision: "r1" });
  session.noteLocalEdit("a2");

  const gate = deferred();
  const started = deferred();
  const pending = session.enqueueSave(async () => {
    started.resolve();
    await gate.promise;
    return { revision: "r2" };
  });
  await started.promise;

  session.setWritesSuspended(true);
  await assert.rejects(
    () => session.enqueueSave(async () => ({ revision: "nope" })),
    (error) => error.code === "writes_suspended",
  );

  gate.resolve();
  await session.whenSavesIdle();
  assert.equal(session.baseRevision, "r2");
  session.setWritesSuspended(false);
  await pending;
});

test("HttpApiError preserves HTTP status codes from API failures", () => {
  const error = new HttpApiError("太大", { status: 413, code: "payload_too_large", data: { error: "太大" } });
  assert.equal(error.status, 413);
  assert.equal(error.code, "payload_too_large");
  assert.equal(error.message, "太大");
});

test("asset.changed live events normalize without requiring note path equality", () => {
  const event = normalizeLiveEvent("asset.changed", {
    type: "asset.changed",
    vaultId: "vault-a",
    path: "images/pic.png",
    revision: "sha256:abc",
    origin: "filesystem",
    mutationId: "fs:1",
  });
  assert.equal(event.isAssetEvent, true);
  assert.equal(event.isNoteEvent, false);
  assert.equal(event.path, "images/pic.png");
  assert.equal(event.revision, "sha256:abc");
  assert.equal(event.mutationId, "fs:1");
});

test("clean refresh applies when identity and editVersion stay stable", () => {
  const session = createDocumentSession();
  openDoc(session, { content: "old", revision: "r1" });
  const request = session.beginRefresh();
  const result = session.commitRefresh(request, { content: "remote", revision: "r2" });
  assert.equal(result.applied, true);
  assert.equal(session.liveText, "remote");
  assert.equal(session.baseRevision, "r2");
  assert.equal(session.isDirty(), false);
  assert.equal(session.remoteRevision, null);
});

test("statusFlags always expose complete path/revision/dirty for UI sync", () => {
  const session = createDocumentSession();
  openDoc(session, { path: "A.md", content: "x", revision: "r1" });
  const flags = session.statusFlags();
  assert.equal("path" in flags, true);
  assert.equal("baseRevision" in flags, true);
  assert.equal("dirty" in flags, true);
  assert.equal(flags.path, "A.md");
  assert.equal(flags.baseRevision, "r1");
  assert.equal(flags.dirty, false);

  const rejected = session.rejectSave(
    { kind: "save", vaultId: "other", path: "Z.md", epoch: 99, submittedText: "z", baseRevision: "z0" },
    new HttpApiError("fail", { status: 500 }),
  );
  assert.equal(rejected.touchCurrent, false);
  assert.equal(session.statusFlags().path, "A.md");
  assert.equal(session.statusFlags().baseRevision, "r1");
});
