// A4 lane evidence: contract §6 `withRequestContextPatch` (merge/patch over the ambient context).
// Scope: the context primitive only. Vault *selection* logic (registrar / auth / server_info) is Wave C
// and is intentionally not exercised here.
import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryGuidanceRegistrar } from "../src/memory-guidance.js";
import { requestContext, withRequestContext, withRequestContextPatch } from "../src/request-context.js";

const AUTHOR = { agent: "patch-test", model: "test-model" };
const RUNTIME_A = Object.freeze({ root: "/vaults/a" });
const RUNTIME_B = Object.freeze({ root: "/vaults/b" });
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("patch keeps every outer field and overrides only the keys it names", async () => {
  const usage = { denied: false };
  const parent = { authzUsage: usage, author: AUTHOR, tool: "get_note", sessionId: "s1", authClientId: "c1" };
  await withRequestContext(parent, async () => {
    await withRequestContextPatch({ vaultId: "a", tool: "write_note" }, async () => {
      const context = requestContext();
      assert.equal(context.tool, "write_note");
      assert.equal(context.vaultId, "a");
      assert.equal(context.author, AUTHOR);
      assert.equal(context.sessionId, "s1");
      assert.equal(context.authClientId, "c1");
      assert.equal(context.authzUsage, usage);
    });
    assert.equal(requestContext(), parent);
    assert.equal(Object.hasOwn(parent, "vaultId"), false);
  });
});

test("an undefined value in the patch never erases an outer field", async () => {
  await withRequestContext({ author: AUTHOR, tool: "get_note", authzUsage: { denied: false } }, () =>
    withRequestContextPatch({ vaultId: "a", author: undefined, tool: undefined, sessionId: undefined }, () => {
      const context = requestContext();
      assert.equal(context.author, AUTHOR);
      assert.equal(context.tool, "get_note");
      assert.equal(context.vaultId, "a");
      assert.equal(context.authzUsage.denied, false);
      assert.equal(Object.hasOwn(context, "sessionId"), false);
    }));
});

test("two nested patch layers compose and keep authzUsage plus the outer vault", async () => {
  const usage = { denied: false };
  const context = await withRequestContext({ authzUsage: usage }, () =>
    withRequestContextPatch({ vaultId: "a", vaultRuntime: RUNTIME_A }, () =>
      withRequestContextPatch({ author: AUTHOR, tool: "get_note", sessionId: "s1" }, () => requestContext())));
  assert.equal(context.authzUsage, usage);
  assert.equal(context.vaultId, "a");
  assert.equal(context.vaultRuntime, RUNTIME_A);
  assert.equal(context.author, AUTHOR);
  assert.equal(context.tool, "get_note");
  assert.equal(context.sessionId, "s1");
});

test("authzUsage keeps reference identity through patch, so a later deny flip reaches the parent state", async () => {
  const usage = { denied: false };
  await withRequestContext({ authzUsage: usage }, () =>
    withRequestContextPatch({ vaultId: "a" }, () => requestContext().authzUsage.denied = true));
  assert.equal(usage.denied, true);
});

test("patch outside any context starts a context, and leaves nothing behind after it returns", async () => {
  const seen = await withRequestContextPatch({ vaultId: "a", vaultRuntime: RUNTIME_A }, () => requestContext());
  assert.equal(seen.vaultId, "a");
  assert.equal(seen.vaultRuntime, RUNTIME_A);
  assert.equal(requestContext(), undefined);
});

test("vault keys are readable in scope and do not leak into later calls", async () => {
  const observed = [];
  await withRequestContext({ tool: "outer" }, async () => {
    await withRequestContextPatch({ vaultId: "a", vaultRuntime: RUNTIME_A }, async () => {
      observed.push([requestContext().vaultId, requestContext().vaultRuntime]);
    });
    observed.push([requestContext().vaultId, requestContext().vaultRuntime]);
  });
  assert.deepEqual(observed, [["a", RUNTIME_A], [undefined, undefined]]);
});

test("concurrent patch scopes keep independent vault context and never mutate the parent", async () => {
  // Independence is the property; the ORDER in which two timers fire is the scheduler's business.
  // This test used to assert `deepEqual(seen, [b, a])`, i.e. that a 1 ms tick lands before a 5 ms one.
  // When the loop is blocked for longer than 5 ms (a full-suite run on a busy machine) both timers are
  // ready at once and fire in insertion order, so `a` lands first and the assertion fails while the
  // isolation it means to test is perfectly intact. Observe each scope by name instead, and prove
  // overlap separately — that is what a leak would break.
  const parent = { tool: "outer" };
  const seen = new Map();
  const window = { slowStart: 0, slowEnd: 0, fastStart: 0, fastEnd: 0 };
  await withRequestContext(parent, async () => {
    const slow = withRequestContextPatch({ vaultId: "a", vaultRuntime: RUNTIME_A }, async () => {
      window.slowStart = Date.now();
      await tick(5);
      const context = requestContext();
      window.slowEnd = Date.now();
      seen.set("a", { vaultId: context.vaultId, vaultRuntime: context.vaultRuntime, sameRuntime: context.vaultRuntime === RUNTIME_A });
    });
    const fast = withRequestContextPatch({ vaultId: "b", vaultRuntime: RUNTIME_B }, async () => {
      window.fastStart = Date.now();
      await tick(1);
      const context = requestContext();
      window.fastEnd = Date.now();
      seen.set("b", { vaultId: context.vaultId, vaultRuntime: context.vaultRuntime, sameRuntime: context.vaultRuntime === RUNTIME_B });
    });
    await Promise.all([slow, fast]);
    assert.equal(requestContext(), parent);
    assert.deepEqual(parent, { tool: "outer" });
  });
  assert.equal(seen.size, 2, "both scopes must have observed their own context");
  assert.deepEqual(seen.get("a"), { vaultId: "a", vaultRuntime: RUNTIME_A, sameRuntime: true }, "scope a must see A's runtime");
  assert.deepEqual(seen.get("b"), { vaultId: "b", vaultRuntime: RUNTIME_B, sameRuntime: true }, "scope b must see B's runtime");
  // The two scopes really did overlap (the patch is per-async-scope, not a global swap). If either
  // scope had to wait for the other, this fails — and a shared/global context would fail the checks
  // above instead.
  assert.ok(window.fastStart <= window.slowEnd && window.slowStart <= window.fastEnd, `the scopes must overlap, got ${JSON.stringify(window)}`);
});

test("withRequestContext keeps whole-object replacement semantics", async () => {
  await withRequestContext({ vaultId: "a", tool: "outer", author: AUTHOR }, () =>
    withRequestContext({ tool: "inner" }, () => {
      const context = requestContext();
      assert.equal(context.tool, "inner");
      assert.equal(Object.hasOwn(context, "vaultId"), false);
      assert.equal(Object.hasOwn(context, "author"), false);
    }));
});

test("memory-guidance merges over the ambient context (Wave C switched it to patch semantics)", async () => {
  let handler;
  const server = {
    getClientVersion: () => ({ name: "", version: "" }),
    registerTool: (name, config, receive) => { handler = receive; },
  };
  createMemoryGuidanceRegistrar(server).registerTool("write_note", { description: "write" }, async (args, extra) => requestContext());
  const extra = { sessionId: "s1", authInfo: { clientId: "c1", userId: "u1" }, _meta: { "obsidian/author": AUTHOR } };

  const context = await handler({ path: "x.md" }, extra);
  assert.deepEqual(context.author, AUTHOR);
  assert.equal(context.authClientId, "c1");
  assert.equal(context.authUserId, "u1");
  assert.equal(context.tool, "write_note");
  assert.equal(context.sessionId, "s1");

  // Wave C contract §8: the vault-scope registrar sits *outside* this layer, so guidance must merge
  // instead of replacing — the selected vault context has to reach the handler unchanged.
  const patched = await withRequestContextPatch({ vaultId: "a", vaultRuntime: RUNTIME_A }, () => handler({ path: "x.md" }, extra));
  assert.equal(patched.vaultId, "a");
  assert.equal(patched.vaultRuntime, RUNTIME_A);
  assert.deepEqual(patched.author, AUTHOR);
  assert.equal(patched.tool, "write_note");
  assert.equal(patched.sessionId, "s1");
  assert.equal(patched.authClientId, "c1");
  assert.equal(patched.authUserId, "u1");
});
