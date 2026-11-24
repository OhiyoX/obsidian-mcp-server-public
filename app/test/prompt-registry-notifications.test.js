// P2 Task 5: publish-time notifications. The protocol hint reaches live sessions;
// a closed session is skipped; a publish never fails because a notification did.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { createPromptNotificationFanout } from "../src/prompt-registry/notification-fanout.js";
import { adminLogin, connectMcp, prepareEnv, publishPack, shippedPack, startStack } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

function fakeSession({ tools = true, prompts = true, closed = false, fail = false } = {}) {
  const calls = [];
  const server = {
    server: {
      async sendToolListChanged() {
        calls.push("tools");
        if (fail) throw new Error("sse closed");
      },
      async sendPromptListChanged() {
        calls.push("prompts");
        if (fail) throw new Error("sse closed");
      },
    },
  };
  return { record: { server, closed }, calls: { list: calls, tools, prompts } };
}

test("a publish notifies every live session once and skips closed ones", async () => {
  const live = fakeSession();
  const dead = fakeSession({ closed: true });
  const sessions = new Map([["a", live.record], ["b", dead.record]]);
  const fanout = createPromptNotificationFanout({ sessions });

  const result = await fanout.notifyPublished({ revision: 1, values: { "tools.canonical.get_note.description": "x" } });
  assert.equal(result.sessions, 1);
  assert.deepEqual(live.calls.list, ["tools", "prompts"]);
  assert.deepEqual(dead.calls.list, [], "a closed record is not notified");
  assert.deepEqual(fanout.status(), { sent: 1, failed: 0, publishes: 1 });
});

test("a failing transport is counted and never thrown", async () => {
  const broken = fakeSession({ fail: true });
  const fanout = createPromptNotificationFanout({ sessions: new Map([["a", broken.record]]), log: () => {} });
  await assert.doesNotReject(fanout.notifyPublished({ revision: 1, values: {} }));
  assert.deepEqual(fanout.status(), { sent: 0, failed: 1, publishes: 1 });
});

test("only the changed class of prompt is announced", async () => {
  const live = fakeSession();
  const fanout = createPromptNotificationFanout({ sessions: new Map([["a", live.record]]), log: () => {} });
  await fanout.notifyPublished({ revision: 1, values: { "prompts.research_brief.title": "a" } }, { values: {} });
  assert.deepEqual(live.calls.list, ["prompts"]);

  const second = fakeSession();
  const fanout2 = createPromptNotificationFanout({ sessions: new Map([["b", second.record]]), log: () => {} });
  await fanout2.notifyPublished({ revision: 1, values: { "tools.canonical.get_note.description": "a" } }, { values: {} });
  assert.deepEqual(second.calls.list, ["tools"]);
});

test("a real publish notifies connected sessions and succeeds when none listen", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const pack = await shippedPack();
  pack.files["tools/canonical/get_note.md"] = "Notified description.\n";
  const published = await publishPack(stack.origin, admin, pack, 0);
  assert.equal(published.revision, 1);
  assert.equal(published.notified, 1, "one subscriber (the fanout) was told");
  assert.equal(stack.notifications.status().sent, 1, "the open session was attempted");

  // A publish with no listeners is still a success.
  await mcp.close();
  // The server-side transport only notices a client close on its next request, so
  // the harness drops the record the way the reaper would.
  stack.sessions.clear();
  const second = await shippedPack();
  second.files["tools/canonical/get_note.md"] = "Notified description two.\n";
  const again = await publishPack(stack.origin, admin, second, 1);
  assert.equal(again.revision, 2);
  assert.deepEqual(again.notificationFailures, []);
  assert.equal(stack.notifications.status().sent, 1, "no live session was attempted");
});

// #827 F-6: `sent` counted sessions that got nothing. A counter that reports work it
// did not do makes `/healthz` claim adoption the protocol never delivered.
test("the sent counter counts only notifications actually handed to a session", async () => {
  const live = fakeSession();
  const sessions = new Map([["a", live.record]]);
  const fanout = createPromptNotificationFanout({ sessions });

  await fanout.notifyPublished({ revision: 1, values: { "tools.canonical.get_note.description": "x" } });
  assert.equal(fanout.status().sent, 1);

  // Same text again: nothing changed, so nothing is sent and nothing is counted.
  await fanout.notifyPublished({ revision: 1, values: { "tools.canonical.get_note.description": "x" } });
  assert.equal(fanout.status().sent, 1);

  // A session whose transport has no list_changed methods is not a delivery either.
  const mute = { record: { server: { server: {} }, closed: false } };
  const quiet = createPromptNotificationFanout({ sessions: new Map([["m", mute.record]]) });
  await quiet.notifyPublished({ revision: 2, values: { "tools.canonical.get_note.description": "y" } });
  assert.equal(quiet.status().sent, 0);
  assert.equal(quiet.status().publishes, 1);
});

test("a closed fanout stops notifying, and a failed send is counted as failed", async () => {
  const failing = fakeSession({ fail: true });
  const fanout = createPromptNotificationFanout({ sessions: new Map([["a", failing.record]]) });
  await fanout.notifyPublished({ revision: 1, values: { "tools.canonical.get_note.description": "x" } });
  assert.equal(fanout.status().failed, 1);
  assert.equal(fanout.status().sent, 0);

  fanout.close();
  const before = failing.calls.list.length;
  await fanout.notifyPublished({ revision: 2, values: { "tools.canonical.get_note.description": "z" } });
  assert.equal(failing.calls.list.length, before, "a closed fanout sends nothing");
});
