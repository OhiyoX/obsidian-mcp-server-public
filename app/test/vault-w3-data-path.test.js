import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("W3 C-ENV binds before frozen config, owns only fallback data, and refuses binding drift", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "vault-w3-binding-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const explicit = path.join(temp, "caller-data");
  await fs.mkdir(explicit);
  const probe = `
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import path from "node:path";
    await import("./test/helpers/vault-w3-admin-harness.js");
    const binding = await import("./test/helpers/vault-w3-data-path.js");
    const config = await import("./src/config.js");
    assert.equal(config.DATA_PATH, binding.w3DataPath, "config must freeze the isolated binding");
    assert.notEqual(config.DATA_PATH, path.resolve("/data"));
    const expectedOwner = process.env.W3_EXPECT_OWNER === "fixture";
    assert.equal(binding.ownsW3DataPath, expectedOwner);
    assert.equal(path.dirname(binding.w3DataPath), expectedOwner ? process.env.TEMP : process.env.W3_CALLER_PARENT);
    process.env.DATA_PATH = path.join(binding.w3DataPath, "unknown");
    assert.throws(binding.assertW3DataPath, /known isolated binding/);
    process.env.DATA_PATH = binding.w3DataPath;
    await binding.cleanupW3DataPath();
    assert.equal(await fs.stat(binding.w3DataPath).then(() => true, () => false), !expectedOwner);
    console.log("W3_BINDING_PROBE=PASS");
  `;
  for (const owner of ["caller", "fixture"]) {
    const env = { ...process.env, TEMP: temp, TMP: temp, W3_EXPECT_OWNER: owner, W3_CALLER_PARENT: temp };
    if (owner === "caller") env.DATA_PATH = explicit;
    else delete env.DATA_PATH;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, `${owner}: ${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /W3_BINDING_PROBE=PASS/);
  }
  const refused = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./test/helpers/vault-w3-data-path.js")'], {
    env: { ...process.env, DATA_PATH: path.resolve("/data") }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(refused.error, undefined);
  assert.equal(refused.signal, null);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /product default data directory refused/);
});
