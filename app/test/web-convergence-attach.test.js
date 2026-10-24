// Integration tests for the F2 convergence wiring: the reconnect attach module
// (global listener ownership + hint + session-expired hand-off) and the outgoing
// links attach module (API client + document-switch identity guard).
//
// Both attach modules are the only place that owns side effects, so these tests
// assert the exact contract `core/app.js` relies on: one call mounts everything,
// `stop`/`destroy` remove it, and the outgoing section never re-fetches for an
// unchanged document identity (the outline refresh hook runs on every edit).
import assert from "node:assert/strict";
import test from "node:test";
import { createDomHarness } from "./helpers/base-dom.mjs";
import { attachReconnect } from "../frontend/app/features/sync/attach-reconnect.js";
import { attachOutgoingLinks } from "../frontend/app/features/context/attach-outgoing.js";

const dom = createDomHarness();
dom.install();

function fakeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event = { type }) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    count(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

function fakeSupervisor() {
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    getState: () => ({ phase: "online", since: 0, attempts: 0, lastProbeAt: null }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reportOnline: () => calls.push("online"),
    reportOffline: () => calls.push("offline"),
    reportVisible: () => calls.push("visible"),
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

// ---------------------------------------------------------------------------
// attach-reconnect
// ---------------------------------------------------------------------------

test("attachReconnect mounts the hint, starts the supervisor and owns the listeners", () => {
  const host = dom.createElement("span");
  const win = fakeEventTarget();
  const supervisor = fakeSupervisor();
  const expired = [];
  const attached = attachReconnect({ host, win, doc: dom.document, supervisor, onSessionExpired: () => expired.push(1) });

  assert.deepEqual(supervisor.calls, ["start"]);
  assert.equal(host.childNodes.length, 1);
  assert.equal(attached.supervisor, supervisor);
  assert.equal(attached.hint.element, host.childNodes[0]);

  supervisor.emit({ type: "state", state: { phase: "offline" } });
  assert.equal(attached.hint.element.hidden, false);
  assert.equal(attached.hint.element.getAttribute("data-phase"), "offline");
  assert.match(attached.hint.element.textContent, /网络已断开/);

  // A confirmed 401 surfaces once and never navigates.
  supervisor.emit({ type: "session-expired", state: { phase: "session-expired" } });
  assert.equal(expired.length, 1);
  assert.match(attached.hint.element.textContent, /登录已失效/);

  win.dispatch("online");
  win.dispatch("offline");
  dom.document.hidden = false;
  dom.document.dispatchEvent({ type: "visibilitychange" });
  assert.deepEqual(supervisor.calls, ["start", "online", "offline", "visible"]);

  dom.document.hidden = true;
  dom.document.dispatchEvent({ type: "visibilitychange" });
  assert.deepEqual(supervisor.calls, ["start", "online", "offline", "visible"], "hidden documents do not probe");

  attached.stop();
  assert.equal(host.childNodes.length, 0, "the hint is removed from its host");
  assert.equal(win.count("online"), 0);
  assert.equal(win.count("offline"), 0);
  assert.deepEqual(supervisor.calls, ["start", "online", "offline", "visible", "stop"]);
  dom.document.hidden = false;
  dom.document.dispatchEvent({ type: "visibilitychange" });
  win.dispatch("online");
  assert.deepEqual(supervisor.calls, ["start", "online", "offline", "visible", "stop"], "stop() unregisters every listener");
  dom.document.hidden = undefined;
});

test("attachReconnect tolerates a missing host without registering listeners", () => {
  const win = fakeEventTarget();
  const supervisor = fakeSupervisor();
  assert.throws(() => attachReconnect({ host: null, win, doc: dom.document, supervisor }), /host element/);
  assert.equal(win.count("online"), 0);
  assert.deepEqual(supervisor.calls, [], "nothing starts before the host is valid");
});

// ---------------------------------------------------------------------------
// attach-outgoing
// ---------------------------------------------------------------------------

const NOTE_ITEM = { target: "Beta", kind: "note", resolvedPath: "Notes/Beta.md", alias: null, heading: null };

function outgoingFixture() {
  const host = dom.createElement("nav");
  const requests = [];
  const opened = [];
  const vault = { id: "vault-1" };
  const fetchImpl = async (url, options) => {
    requests.push({ url, signal: options?.signal });
    return { ok: true, status: 200, json: async () => ({ links: [NOTE_ITEM] }) };
  };
  const attached = attachOutgoingLinks({
    host,
    openNote: (path) => opened.push(path),
    vaultId: () => vault.id,
    fetchImpl,
  });
  return { host, requests, opened, vault, attached };
}

test("attachOutgoingLinks fetches the note-context API for a note and clears on Base/empty", async () => {
  const { host, requests, attached } = outgoingFixture();

  await attached.setDocument({ path: "Notes/A B.md", documentKind: "note" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/web/v1/note-context/outgoing?path=Notes%2FA%20B.md");
  assert.match(host.textContent, /Beta/);
  assert.equal(attached.setDocument({ path: null, documentKind: "note" }).status, "idle");

  await attached.setDocument({ path: "Project.base", documentKind: "base" });
  assert.match(host.textContent, /Base 文档没有出链/);
  assert.equal(requests.length, 1, "Base documents never hit the API");

  await attached.setDocument({ path: "Notes/A B.md", documentKind: "note" });
  assert.equal(requests.length, 2, "returning to a note reloads after the Base clear");

  await attached.setDocument({ path: "Notes/A B.md", documentKind: "note" });
  assert.equal(requests.length, 2, "the same document identity is not re-fetched");

  attached.destroy();
  assert.equal(host.childNodes.length, 0);
});

test("attachOutgoingLinks keeps the outline-refresh hook idempotent across edits", async () => {
  const { requests, vault, attached } = outgoingFixture();
  await attached.setDocument({ path: "Notes/Gamma.md", documentKind: "note" });
  assert.equal(requests.length, 1);
  // The editor change callback calls refreshOutlineFromSource on every debounced
  // edit; those must not spam the API.
  for (let index = 0; index < 5; index += 1) await attached.setDocument({ path: "Notes/Gamma.md", documentKind: "note" });
  assert.equal(requests.length, 1);
  // Switching vaults changes the identity, so the same path reloads.
  vault.id = "vault-2";
  await attached.setDocument({ path: "Notes/Gamma.md", documentKind: "note" });
  assert.equal(requests.length, 2);
});
