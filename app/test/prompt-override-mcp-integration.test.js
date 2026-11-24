// P3 Task 6 / #827 F-13: an override has to reach the surfaces a host actually reads,
// not only the effective snapshot. One session, one publish, no restart, and the
// server says which copy it served.

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { adminLogin, connectMcp, prepareEnv, startStack } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

async function publishOverride(origin, admin, body) {
  const response = await fetch(`${origin}/admin/auth/prompt-registry/override/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ csrf: admin.csrf, reason: "override e2e", ...body }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

test("an override reaches tools/list, prompts/get and agent_bootstrap without a restart", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const client = await connectMcp(stack.origin, { client: "override-e2e" });
  t.after(async () => client.close());

  const toolKey = "tools.canonical.get_note.description";
  const promptKey = "prompts.research_brief.title";
  const before = await client.listTools();
  assert.doesNotMatch(before.tools.find((tool) => tool.name === "get_note").description, /OVERRIDE-COPY/);

  const published = await publishOverride(stack.origin, admin, {
    expectedRevision: 0,
    set: { [toolKey]: "OVERRIDE-COPY: read one note by path.", [promptKey]: "OVERRIDE-COPY research brief" },
  });
  assert.equal(published.revision, 1);

  const tools = await client.listTools();
  assert.match(tools.tools.find((tool) => tool.name === "get_note").description, /OVERRIDE-COPY/);

  const prompts = await client.listPrompts();
  assert.equal(prompts.prompts.find((prompt) => prompt.name === "research_brief").title, "OVERRIDE-COPY research brief");

  const boot = await client.callTool({ name: "agent_bootstrap", arguments: {} });
  const bootstrap = JSON.parse(boot.content[0].text);
  assert.equal(bootstrap.promptRevision, 1, "the host can report which copy it read");
  assert.equal(bootstrap.promptSource, "base+override");

  // Reset restores the Base text, and the host can tell that too.
  const reset = await fetch(`${stack.origin}/admin/auth/prompt-registry/override/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ csrf: admin.csrf, reason: "override e2e", expectedRevision: 1, keys: [toolKey, promptKey] }),
  });
  assert.equal(reset.status, 200);
  const after = await client.listTools();
  assert.doesNotMatch(after.tools.find((tool) => tool.name === "get_note").description, /OVERRIDE-COPY/);
  const bootAfter = await client.callTool({ name: "agent_bootstrap", arguments: {} });
  assert.equal(JSON.parse(bootAfter.content[0].text).promptSource, "base");
});

test("an override may not touch Base-only copy or invent a key", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  for (const [key, expected] of [
    ["bootstrap.instructions", 422],
    ["tools.canonical.not_a_tool.description", 422],
  ]) {
    const response = await fetch(`${stack.origin}/admin/auth/prompt-registry/override/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ csrf: admin.csrf, reason: "override e2e", expectedRevision: 0, set: { [key]: "nope" } }),
    });
    assert.equal(response.status, expected, key);
  }
  assert.equal(stack.store.status().revision, 0);
});
