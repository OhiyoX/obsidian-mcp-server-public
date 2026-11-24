// P2 Task 6: concurrency and safety across sessions, plus the three acceptance
// states. A listing is never half old and half new; a copy edit never widens a scope;
// an already-open session keeps the instructions it was initialized with.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { adminLogin, connectMcp, prepareEnv, publishPack, shippedPack, startStack } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

/** Mark two different tools so one listing can prove its own consistency. */
function markedPack(pack, marker) {
  pack.files["tools/canonical/get_note.md"] = `${marker} note copy.\n`;
  pack.files["tools/canonical/search_notes.md"] = `${marker} search copy.\n`;
  return pack;
}

test("a listing during a publish is entirely one revision", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const writer = await connectMcp(stack.origin, { client: "writer" });
  const reader = await connectMcp(stack.origin, { scopes: ["obsidian.read"], client: "reader" });
  t.after(async () => {
    await writer.close();
    await reader.close();
  });

  const first = markedPack(await shippedPack(), "REVISION-ONE");
  await publishPack(stack.origin, admin, first, 0);
  const second = markedPack(await shippedPack(), "REVISION-TWO");

  const listings = [];
  const publish = publishPack(stack.origin, admin, second, 1);
  for (let index = 0; index < 8; index += 1) listings.push(await reader.listTools());
  await publish;

  for (const { tools } of listings) {
    const note = tools.find((tool) => tool.name === "get_note")?.description ?? "";
    const search = tools.find((tool) => tool.name === "search_notes")?.description ?? "";
    const noteMark = note.includes("REVISION-TWO") ? "two" : note.includes("REVISION-ONE") ? "one" : "none";
    const searchMark = search.includes("REVISION-TWO") ? "two" : search.includes("REVISION-ONE") ? "one" : "none";
    assert.equal(noteMark, searchMark, "one request, one revision");
    assert.notEqual(noteMark, "none");
  }
});

test("the scope decides membership before any copy is projected", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const readOnly = await connectMcp(stack.origin, { scopes: ["obsidian.read"], client: "read-only" });
  const full = await connectMcp(stack.origin, { client: "full" });
  t.after(async () => {
    await readOnly.close();
    await full.close();
  });

  const pack = await shippedPack();
  pack.files["tools/canonical/get_note.md"] = "Mentions write_note and delete_note on purpose.\n";
  await publishPack(stack.origin, admin, pack, 0);

  const readNames = (await readOnly.listTools()).tools.map((tool) => tool.name);
  const fullNames = (await full.listTools()).tools.map((tool) => tool.name);
  assert.ok(!readNames.includes("write_note"));
  assert.ok(fullNames.includes("write_note"));
  assert.ok(readNames.every((name) => fullNames.includes(name)), "the read view is a subset");

  const denied = await readOnly.callTool({ name: "write_note", arguments: { path: "x.md", content: "y" } });
  assert.equal(denied.isError, true);
});

test("an open session keeps its initialize instructions; a new one gets the new Base", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const old = await connectMcp(stack.origin, { client: "old" });
  t.after(() => old.close());
  const before = old.getInstructions();

  const pack = await shippedPack();
  pack.files["bootstrap/instructions.md"] = "New Base instructions for new sessions.\n";
  await publishPack(stack.origin, admin, pack, 0);

  assert.equal(old.getInstructions(), before, "an initialized session is not rewritten");

  const fresh = await connectMcp(stack.origin, { client: "fresh" });
  t.after(() => fresh.close());
  assert.equal(fresh.getInstructions(), "New Base instructions for new sessions.");
});

test("the acceptance vocabulary is three states, and adoption is not the server's to claim", async (t) => {
  // PERSISTED: the revision is durable.
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const pack = await shippedPack();
  pack.files["tools/canonical/get_note.md"] = "State vocabulary test.\n";
  const published = await publishPack(stack.origin, admin, pack, 0);

  assert.equal(published.revision, 1);
  assert.equal(stack.store.status().status, "ready");

  // SERVER-VISIBLE: the next request of an open session already carries it.
  const listed = (await mcp.listTools()).tools.find((tool) => tool.name === "get_note");
  assert.match(listed.description, /State vocabulary test\./);

  // HOST-ADOPTED is not observable here: the server only knows that it asked, so the
  // publish reports what it did (a subscriber was told), never that a model adopted it.
  assert.equal(typeof published.notified, "number");
});
