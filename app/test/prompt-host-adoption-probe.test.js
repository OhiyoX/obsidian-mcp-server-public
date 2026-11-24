// P4 Task 4: server-visible is measurable; host adoption is not the server's claim.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import { adminLogin, connectMcp, prepareEnv, publishPack, shippedPack, startStack } from "./helpers/prompt-live.mjs";
import { classifyAdoption, descriptorDigest } from "../scripts/prompt-host-adoption-probe.mjs";

const run = promisify(execFile);
const envRoot = await prepareEnv();
test.after(() => rm(envRoot, { recursive: true, force: true }));

test("a cached host view is not adoption", async (t) => {
  const stack = await startStack(t);
  const admin = await adminLogin(stack.origin);
  const host = await connectMcp(stack.origin, { client: "simulated-host" });
  t.after(() => host.close());

  // The host fetched once and keeps that view, which is what a model context does.
  const cached = await host.listTools();
  const cachedDigest = descriptorDigest(cached.tools);

  const pack = await shippedPack();
  pack.files["tools/canonical/get_note.md"] = "Probe adoption copy.\n";
  await publishPack(stack.origin, admin, pack, 0);

  const fresh = await connectMcp(stack.origin, { client: "probe" });
  t.after(() => fresh.close());
  const serverDigest = descriptorDigest((await fresh.listTools()).tools);
  assert.notEqual(serverDigest, cachedDigest, "the server serves the new text");
  assert.equal(classifyAdoption({ serverDigest, hostDigest: cachedDigest }), false, "the cached host did not adopt it");
  assert.equal(classifyAdoption({ serverDigest }), null, "unmeasured is unknown, never true");
  assert.equal(classifyAdoption({ serverDigest, hostDigest: serverDigest }), true);
});

test("the probe reads a real endpoint and reports both states", async (t) => {
  const stack = await startStack(t);
  const script = new URL("../scripts/prompt-host-adoption-probe.mjs", import.meta.url).pathname;
  const { stdout } = await run(process.execPath, [script, "--url", `${stack.origin}/mcp`]);
  const report = JSON.parse(stdout);
  assert.equal(report.serverVisible, true);
  assert.equal(report.hostAdopted, null);
  assert.match(report.serverDigest, /^[0-9a-f]{64}$/);
  assert.ok(report.toolCount > 0);
  assert.match(report.note, /notification is not adoption/);
});

test("the digest is order-independent and covers descriptions", () => {
  const a = [{ name: "b", description: "two" }, { name: "a", description: "one" }];
  const b = [{ name: "a", description: "one" }, { name: "b", description: "two" }];
  assert.equal(descriptorDigest(a), descriptorDigest(b));
  assert.notEqual(descriptorDigest(a), descriptorDigest([{ name: "a", description: "changed" }, { name: "b", description: "two" }]));
});
