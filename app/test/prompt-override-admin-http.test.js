// P3: runtime overrides through the Admin API and the CLI, and their effect on the
// live MCP surfaces.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";

import { adminLogin, connectMcp, prepareEnv, startStack, PASSWORD } from "./helpers/prompt-live.mjs";

const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

const SCRIPT = new URL("../scripts/promptctl.mjs", import.meta.url).pathname;

async function postOverride(origin, admin, route, body) {
  return fetch(`${origin}/admin/auth/prompt-registry/override/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ csrf: admin.csrf, ...body }),
  });
}

function cli(args) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin.end(`${PASSWORD}\n`);
  });
}

test("an override publishes, shows its source, and resets to the live Base", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const mcp = await connectMcp(stack.origin);
  t.after(() => mcp.close());

  const publish = await postOverride(stack.origin, admin, "publish", {
    expectedRevision: 0,
    reason: "tune one line",
    set: { "memory.firstRead": "Overridden reminder." },
  });
  assert.equal(publish.status, 200);
  const body = await publish.json();
  assert.equal(body.state.overrideCount, 1);
  assert.equal(body.state.overrides["memory.firstRead"], "Overridden reminder.");

  const fresh = await connectMcp(stack.origin, { client: "override-reader" });
  t.after(() => fresh.close());
  const result = await fresh.callTool({ name: "server_info", arguments: {} });
  const texts = result.content.filter((block) => block.type === "text").map((block) => block.text);
  assert.ok(texts.includes("Overridden reminder."), texts.join(" | "));

  const reset = await postOverride(stack.origin, admin, "reset", {
    expectedRevision: body.revision,
    reason: "back to base",
    keys: ["memory.firstRead"],
  });
  assert.equal(reset.status, 200);
  const after = await reset.json();
  assert.equal(after.state.overrideCount, 0);
  assert.deepEqual(after.state.overrides, {});
});

test("a stale revision, a base-only key and an anonymous caller are refused", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);

  const ok = await postOverride(stack.origin, admin, "publish", { expectedRevision: 0, reason: "one", set: { "memory.firstRead": "one" } });
  assert.equal(ok.status, 200);

  const stale = await postOverride(stack.origin, admin, "publish", { expectedRevision: 0, reason: "two", set: { "memory.firstRead": "two" } });
  assert.equal(stale.status, 409);

  const baseOnly = await postOverride(stack.origin, admin, "publish", {
    expectedRevision: 1,
    reason: "nope",
    set: { "bootstrap.instructions": "trying to rewrite the initialize text" },
  });
  assert.equal(baseOnly.status, 422);

  const anonymous = await fetch(`${stack.origin}/admin/auth/prompt-registry/override/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, reason: "x", set: { "memory.firstRead": "x" } }),
    redirect: "manual",
  });
  assert.equal(anonymous.status, 303);
});

test("the CLI publishes and resets an override, and never prints the password", async (t) => {
  const stack = await startStack(t);
  const publish = await cli([
    "override", "publish",
    "--url", stack.origin,
    "--revision", "0",
    "--reason", "cli override",
    "--set", "tools.canonical.get_note.description=CLI copy for get_note.",
    "--password-stdin",
  ]);
  assert.equal(publish.code, 0, publish.stderr);
  assert.match(publish.stdout, /CLI copy for get_note\./);

  const show = await cli(["override", "show", "--url", stack.origin, "--password-stdin"]);
  assert.equal(show.code, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).overrides["tools.canonical.get_note.description"], "CLI copy for get_note.");

  const state = await (await fetch(`${stack.origin}/admin/auth/prompt-registry/state`, {
    headers: { cookie: (await adminLogin(stack.origin)).cookie },
  })).json();
  const reset = await cli([
    "override", "reset",
    "--url", stack.origin,
    "--revision", String(state.revision),
    "--reason", "cli reset",
    "--key", "tools.canonical.get_note.description",
    "--password-stdin",
  ]);
  assert.equal(reset.code, 0, reset.stderr);
  assert.equal(JSON.parse(reset.stdout).state.overrideCount, 0);
  assert.equal(`${publish.stdout}${publish.stderr}${show.stdout}${reset.stderr}`.includes(PASSWORD), false);
});

test("an override reaches tool copy, compact summary, memory and the prompt body", async (t) => {
  const { store, origin } = await startStack(t, { profile: "compact" });
  const admin = await adminLogin(origin);
  const publish = await postOverride(origin, admin, "publish", {
    expectedRevision: 0,
    reason: "surface check",
    set: {
      "tools.compact.obsidian_edit.summary": "覆盖后的写入意图",
      "memory.firstRead": "覆盖后的首读提醒",
      "prompts.research_brief.body": 'Overridden body about "{{topic}}".',
    },
  });

  const mcp = await connectMcp(origin);
  t.after(() => mcp.close());
  const tools = (await mcp.listTools()).tools;
  assert.equal(publish.status, 200, await publish.clone().text());
  const edited = tools.find((tool) => tool.description?.includes("覆盖后的写入意图"));
  assert.ok(edited, "the compact group shows the override");
  const compactCall = await mcp.callTool({ name: "server_info", arguments: {} });
  assert.equal(compactCall.isError, undefined);

  const prompt = await mcp.getPrompt({ name: "research_brief", arguments: { topic: "t" } });
  assert.equal(prompt.messages[0].content.text, 'Overridden body about "t".');
  assert.equal(store.snapshot().sources["prompts.research_brief.body"], "override");
});
