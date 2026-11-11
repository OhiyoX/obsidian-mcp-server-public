// P2 / Task 14 — the SSE stream: one row per delivered frame and per heartbeat.
//
// Contract: design §6.1.4 and §10 P2. A stream is re-authorized at three points: when
// it opens (the route's read gate), before EVERY delivered content frame, and on every
// heartbeat. Each of those is its own authorization unit, so one long stream gives many
// rows — the open row must never hide the delivery checks.
//
// The old gate decides: the heartbeat still closes a stream whose session or Vault
// membership is gone, and the shadow closes nothing. `deniedContentFrames` must stay 0
// in shadow mode, and a queued event is delivered exactly as before.
//
// Determinism: a barrier (the response's first chunk) instead of a sleep, and the
// heartbeat is exercised with a short interval on the real heartbeat module.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ALLOW, candidateFor, prepareEnv, startWebApp } from "./helpers/web-shadow-app.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-sse-"));
const { vaultRoot } = await prepareEnv(root);
await fs.writeFile(path.join(vaultRoot, "Note.md"), "# Readable note\n", "utf8");
process.env.WEB_EVENTS_ENABLED = "true";

test.after(async () => fs.rm(root, { recursive: true, force: true }));

const GRANTED = Object.freeze(["get_note", "write_note", "list_notes"]);

/** Open the live stream and resolve once the hello frame has arrived (a barrier). */
async function openStream(app, cookie) {
  const controller = new AbortController();
  const response = await fetch(`${app.base}/api/web/v1/events`, {
    headers: { Cookie: cookie, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200, "the stream must open");
  const frames = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let waiters = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          frames.push(chunk);
          for (const resolve of waiters) resolve();
          waiters = [];
          index = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // The stream closed; the frames already collected stand.
    }
  })();
  const waitFor = (predicate, label) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${label}: ${JSON.stringify(frames)}`)), 10_000);
    const check = () => {
      if (!predicate(frames)) return false;
      clearTimeout(deadline);
      resolve();
      return true;
    };
    if (check()) return;
    waiters.push(() => check());
  });
  await waitFor((all) => all.some((frame) => frame.includes("event: hello")), "hello");
  return {
    frames,
    waitFor,
    async close() {
      controller.abort();
      await pump;
    },
  };
}

test("sse_shadow_observes_open_heartbeat_and_delivery_without_double_sending", async () => {
  const document = await candidateFor(GRANTED);
  const shadowed = await startWebApp({ label: "sse-shadow", legacyDecision: ALLOW, document });
  const baseline = await startWebApp({ label: "sse-baseline", legacyDecision: ALLOW, shadow: false, document });
  try {
    const session = await shadowed.newSession();
    const baselineSession = await baseline.newSession();
    const stream = await openStream(shadowed, session.cookie);
    const baselineStream = await openStream(baseline, baselineSession.cookie);
    try {
      // The open is one unit of the streaming REQUEST; its row is flushed when the
      // request ends (a stream ends at close), so only the frame rows are visible now.
      assert.equal(shadowed.summary().compared, 0, "nothing is flushed while the request is still open");
      assert.equal(baseline.summary().compared, 0);

      // Deliver three real mutations through the same Web write path the client uses.
      for (let index = 0; index < 3; index += 1) {
        const written = await shadowed.post("/api/web/v1/note", {
          cookie: session.cookie,
          csrf: session.csrf,
          body: { path: `stream-${index}.md`, content: `# frame ${index}\n` },
        });
        assert.equal(written.status, 200, written.body.slice(0, 120));
        await baseline.post("/api/web/v1/note", {
          cookie: baselineSession.cookie,
          csrf: baselineSession.csrf,
          body: { path: `stream-${index}.md`, content: `# frame ${index}\n` },
        });
      }
      await stream.waitFor((all) => all.filter((frame) => frame.includes("event: note.")).length >= 3, "three content frames");
      await baselineStream.waitFor((all) => all.filter((frame) => frame.includes("event: note.")).length >= 3, "three baseline frames");

      const contentFrames = stream.frames.filter((frame) => frame.includes("event: note."));
      const baselineFrames = baselineStream.frames.filter((frame) => frame.includes("event: note."));
      assert.equal(contentFrames.length, 3, "the shadow sends every frame exactly once");
      assert.equal(baselineFrames.length, 3, "the baseline sends the same three frames");

      // One row per delivered frame — the frame rows are emitted at once, and the open
      // stream's own unit cannot swallow them.
      const summary = shadowed.summary();
      assert.equal(summary.compared, 6, "three Web writes and three delivered frames are six units");
      assert.equal(summary.differences, 0);
      const frameRows = shadowed.rows().filter((row) => row.phase === "stream");
      assert.equal(frameRows.length, 3, "one stream-phase row per delivered frame");
      assert.equal(new Set(frameRows.map((row) => row.requestId)).size, 3, "each delivered frame has its own request id");
      assert.equal(baseline.summary().compared, 0, "the baseline records nothing");
    } finally {
      await stream.close();
      await baselineStream.close();
    }
    // Closing the stream ends its request, and the open unit flushes as one more row.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(shadowed.summary().compared, 7, "three writes + three frames + the open stream = seven units");
  } finally {
    await shadowed.close();
    await baseline.close();
  }
});

test("a_heartbeat_re_authorization_is_visible_and_shadow_closes_nothing", async () => {
  const { createSseBroker } = await import("../src/app/events/sse-broker.js");
  const { startSubscriberHeartbeat } = await import("../src/app/events/heartbeat.js");
  const { createShadowRecorder } = await import("../src/authorization/shadow.js");
  const { createAuthorizationRuntime } = await import("../src/authorization/runtime.js");
  const { createShadowCandidate } = await import("../src/authorization/shadow.js");
  const { observeStreamDelivery, currentWebSessionIdentity } = await import("../src/authorization/adapters/web.js");

  const recorder = createShadowRecorder({ capacity: 64 });
  const document = await candidateFor(GRANTED);
  const runtime = createAuthorizationRuntime({
    store: createShadowCandidate({ liveRevision: () => 1, build: () => ({ status: "ready", document }) }),
    // The live session half comes from the adapter's request scope, exactly as in
    // production (`server.js`); without it every web-session actor is invalid.
    identitySnapshot: () => ({ subjects: { "oauth-user:user-1": { credentialEpoch: 0, disabled: false } }, sessions: currentWebSessionIdentity()?.sessions ?? {} }),
    vaultSnapshot: () => ({ vault: { admitted: true, readOnly: false } }),
    publicationSnapshot: () => null,
    deployment: () => ({ readOnly: false }),
    now: () => Date.now(),
    mode: "shadow",
    shadow: recorder,
  });
  await runtime.ready;

  const broker = createSseBroker({
    bootId: "test", replaySize: 4, maxSubscribers: 4, maxSessionConnections: 2,
    buildEventDto: (input) => ({ ...input, occurredAt: new Date().toISOString() }),
    formatSseFrame: (event) => `id: ${event.id ?? "x"}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    dedup: { seen: () => false, remember: () => {} },
    onWatcherRelease: () => {},
  });
  const writes = [];
  const res = { writableEnded: false, ended: false, write(frame) { writes.push(frame); return true; }, end() { this.ended = true; } };
  const session = { id: "session-1", userId: "user-1", credentialId: "web-session:abc", vaultId: "vault", allowedVaults: ["vault"], expiresAt: Date.now() + 60_000 };
  const deliver = () => {
    observeStreamDelivery({ shadow: runtime.shadow, session, vaultId: "vault" });
    return null; // shadow mode: no verdict, so nothing is ever closed early
  };
  const subscriber = broker.register({ res, vaultId: "vault", sessionId: session.id, acquiredWatcher: true, authorizeDelivery: deliver });

  // Baseline: the same stream without the hook sends the same frames.
  const plainWrites = [];
  const plainRes = { writableEnded: false, ended: false, write(frame) { plainWrites.push(frame); return true; }, end() { this.ended = true; } };
  const plainSubscriber = broker.register({ res: plainRes, vaultId: "vault", sessionId: "session-2", acquiredWatcher: false });

  broker.publish({ type: "note.changed", vaultId: "vault", path: "a.md", revision: "r1" });
  broker.publish({ type: "note.changed", vaultId: "vault", path: "b.md", revision: "r2" });
  assert.equal(writes.length, plainWrites.length, "the shadow sends exactly the baseline frames");
  assert.equal(recorder.summary().compared, 2, "one row per delivered frame");

  // The heartbeat re-authorization is its own visible unit: one row per tick.
  let ticks = 0;
  startSubscriberHeartbeat({
    subscriber, broker, vaultId: "vault", intervalMs: 10,
    revalidate: async () => { ticks += 1; return session; },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearInterval(subscriber.heartbeat);
  assert.ok(ticks >= 2, `the heartbeat must tick: ${ticks}`);
  const after = recorder.summary();
  assert.ok(after.compared >= 2 + ticks, `each heartbeat is a row: compared ${after.compared}, ticks ${ticks}`);
  assert.equal(after.differences, 0);
  const contentFrames = (list) => list.filter((frame) => frame.includes("event:")).length;
  assert.equal(contentFrames(writes), contentFrames(plainWrites), "no content frame is written twice");
  assert.equal(writes.length > contentFrames(writes), true, "the heartbeat writes comments, as before");
  assert.equal(broker.isActive(subscriber), true, "shadow mode closes nothing");

  // The old gate still closes a stream whose session is no longer usable.
  startSubscriberHeartbeat({
    subscriber, broker, vaultId: "vault", intervalMs: 10,
    revalidate: async () => null,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(broker.isActive(subscriber), false, "a lost session closes the stream");
  assert.equal(broker.isActive(plainSubscriber), true);
  broker.reset();
});
