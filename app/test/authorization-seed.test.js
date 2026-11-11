// Task 2 — one-way seed from the live legacy state.
//
// Contract: design §7 step 2 and §11 C5. With no document under the data directory, the first
// boot imports the frozen legacy state once and installs it at revision 1; a second boot never
// overwrites it, because a re-seed would erase an Admin edit. `seedFile` only decides whether
// there is anything to install — the store owns the single durable write — and a refused seed
// (a migration HOLD, a broken legacy policy document, or an unusable existing file) reaches the
// caller as an error so the boot stops instead of serving a document that allows.
//
// The last four tests spawn the real `server.js`, because both carried-over requirements live in
// its wiring, not in the module: the seed installs with no credential provider at all, and a
// refused seed ends the process before it serves a request.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LEGACY_POLICY_IMPORT_CODES } from "../src/authorization/legacy-policy-import.js";
import { LEGACY_IMPORT_CODES } from "../src/authorization/legacy-import.js";
import { createDeploymentDocument } from "../src/authorization/deployment-document.js";
import { createNodeAuthorizationIo } from "../src/authorization/node-io.js";
import { AUTHORIZATION_CATALOG_VERSION } from "../src/authorization/catalog.js";
import { parseAuthorizationDocument, validateAuthorizationDocument } from "../src/authorization/schema.js";
import { SEED_INPUTS, buildSeedDocument, seedFile, seedRefusalLine } from "../src/authorization/seed.js";
import { DEFAULT_VAULT_ID } from "../src/oauth/primitives.js";
import { SUBJECT, TIMEZONE, legacyDocument, legacyPolicy } from "./helpers/authorization-fidelity-matrix.js";
import {
  APP_DIR,
  freePort,
  seedVault,
  serverEnv,
  startServer,
  stopChild,
  writeCorruptPolicy,
} from "./helpers/server-spawn-fixtures.js";

const { MIGRATION_HOLD } = LEGACY_POLICY_IMPORT_CODES;
const DATA_ROOT = process.env.DATA_PATH;
const PRIMARY = DEFAULT_VAULT_ID;

// The deployed legacy window (§7): workdays 09:00–18:00, one enabled suspend policy over `all`.
const LIVE_WEEKLY = Object.freeze({
  mon: [["09:00", "18:00"]],
  tue: [["09:00", "18:00"]],
  wed: [["09:00", "18:00"]],
  thu: [["09:00", "18:00"]],
  fri: [["09:00", "18:00"]],
});

// A provider snapshot in the shape `persistence-methods.load()` leaves behind.
function providerSnapshot() {
  return {
    oauthUsers: {
      "user-1": {
        id: "user-1",
        username: "user-1",
        displayName: "User 1",
        allowedScopes: ["obsidian.read"],
        allowedVaults: [PRIMARY],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        disabledAt: null,
      },
    },
    apiKeys: {},
    accessTokens: {},
    refreshTokens: {},
    clients: {},
    oauthUsersInitialized: true,
  };
}

function seedInput(overrides = {}) {
  return {
    providerSnapshot: providerSnapshot(),
    policyDocument: null,
    timeConstraintsEnabled: true,
    // The environment key stays out of the fixture: `null` would read `process.env.API_KEY`.
    environmentKey: { configured: false },
    ...overrides,
  };
}

async function workdir(label) {
  assert.equal(typeof DATA_ROOT, "string", "DATA_PATH must point at the isolated test root");
  await mkdir(DATA_ROOT, { recursive: true });
  const dir = await mkdtemp(path.join(DATA_ROOT, `${label}-`));
  return { dir, file: path.join(dir, "authorization.json"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// The real io seam, wrapped so a test can see what reached the disk.
function recordingIo() {
  const base = createNodeAuthorizationIo();
  const calls = { mkdir: [], readFile: [], open: [], rename: [], unlink: [], chmod: [] };
  const io = {};
  for (const [name, fn] of Object.entries(base)) {
    io[name] = (...args) => {
      calls[name].push(args);
      return fn(...args);
    };
  }
  return { io, calls };
}

async function storedOnDisk(file) {
  const parsed = parseAuthorizationDocument((await readFile(file)).toString("utf8"));
  assert.equal(parsed.ok, true, `the document on disk must parse: ${parsed.code ?? ""}`);
  return parsed.document;
}

test("with no document the seed is installed once at revision 1, and the store owns the write", async () => {
  const work = await workdir("seed-once");
  const { io, calls } = recordingIo();
  let builds = 0;
  const build = () => {
    builds += 1;
    return buildSeedDocument(seedInput({ policyDocument: legacyDocument([legacyPolicy()]) }));
  };
  // The composition `server.js` wires: the seed hook hands the document to the store.
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => {
      const seeded = await seedFile({ file: work.file, io, build });
      assert.equal(seeded.seeded, true, "an absent document is a seed");
      return seeded.document;
    },
    deriveSubjects: (subjects) => subjects,
  });
  try {
    await deployment.ready;

    assert.equal(builds, 1, "the legacy state is imported once");
    const writes = calls.rename.filter(([, to]) => to === work.file);
    assert.equal(writes.length, 1, "the seed is written through exactly one atomic rename");

    const onDisk = await storedOnDisk(work.file);
    assert.equal(onDisk.revision, 1);
    assert.equal(onDisk.timeConstraintsEnabled, true, "the recorded legacy switch value is kept");
    assert.equal(onDisk.catalogVersion, AUTHORIZATION_CATALOG_VERSION);
    assert.equal(onDisk.constraints.length, 1, "the legacy policy becomes one constraint");
    assert.equal(onDisk.constraints[0].id, legacyPolicy().id, "the legacy policy id survives");
    assert.equal(deployment.store.snapshot().status, "ready");
    assert.equal(deployment.store.snapshot().revision, 1);
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a second seed with a different build reports seeded:false and changes no byte", async () => {
  const work = await workdir("seed-once-only");
  const { io, calls } = recordingIo();
  const installed = await seedFile({ file: work.file, io, build: () => buildSeedDocument(seedInput()) });
  assert.equal(installed.seeded, true);
  assert.equal(installed.document.revision, 1);
  // The decision is the whole job: writing is the store's, so no file appears yet.
  await assert.rejects(stat(work.file), { code: "ENOENT" }, "seedFile decides, it never writes");

  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => installed.document,
    deriveSubjects: (subjects) => subjects,
  });
  try {
    await deployment.ready;
    const before = await readFile(work.file);

    let laterBuilds = 0;
    const second = await seedFile({
      file: work.file,
      io,
      build: () => {
        laterBuilds += 1;
        return buildSeedDocument(seedInput({ timeConstraintsEnabled: false }));
      },
    });
    assert.equal(second.seeded, false, "an existing document is never re-seeded");
    assert.equal(second.document, null);
    assert.equal(laterBuilds, 0, "the build is not even called once the document exists");
    assert.deepEqual(await readFile(work.file), before, "the bytes on disk are unchanged");
    assert.equal(calls.rename.filter(([, to]) => to === work.file).length, 1, "no second write");
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a policy document that cannot be migrated holds, and no file appears", async () => {
  const work = await workdir("seed-hold");
  const { io } = recordingIo();
  // An unknown timezone: the legacy validator refuses the document, so the import holds.
  const broken = legacyDocument([legacyPolicy({ timezone: "Not/AZone" })]);

  await assert.rejects(
    () => seedFile({ file: work.file, io, build: () => buildSeedDocument(seedInput({ policyDocument: broken })) }),
    (error) => {
      assert.equal(error.code, MIGRATION_HOLD, "the HOLD carries its own code");
      return true;
    },
  );
  await assert.rejects(stat(work.file), { code: "ENOENT" }, "a held seed writes nothing");

  // Through the deployment the HOLD reaches `ready`, which is what stops the boot (§11 C5).
  const deployment = createDeploymentDocument({
    file: work.file,
    io,
    seed: async () => (await seedFile({ file: work.file, io, build: () => buildSeedDocument(seedInput({ policyDocument: broken })) })).document,
    deriveSubjects: (subjects) => subjects,
  });
  try {
    await assert.rejects(deployment.ready, (error) => {
      assert.equal(error.code, MIGRATION_HOLD);
      return true;
    });
    assert.equal(deployment.store.snapshot().status, "broken");
    await assert.rejects(stat(work.file), { code: "ENOENT" });
  } finally {
    await deployment.store.drain();
    await work.cleanup();
  }
});

test("a missing verified provider snapshot is a refusal, never an empty document", async () => {
  const work = await workdir("seed-no-snapshot");
  const { io } = recordingIo();
  await assert.rejects(
    () => seedFile({ file: work.file, io, build: () => buildSeedDocument({ timeConstraintsEnabled: true }) }),
    (error) => {
      assert.equal(error.code, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED, "the importer names the missing snapshot");
      return true;
    },
  );
  await assert.rejects(stat(work.file), { code: "ENOENT" });
  await work.cleanup();
});

test("the deployed legacy policy imports to exactly one constraint with that window", async () => {
  const document = buildSeedDocument(seedInput({
    policyDocument: legacyDocument([legacyPolicy({
      label: "workday window",
      subjects: [SUBJECT],
      capabilities: ["all"],
      timezone: TIMEZONE,
      weekly: LIVE_WEEKLY,
    })]),
  }));

  assert.equal(document.revision, 1);
  assert.equal(validateAuthorizationDocument(document).revision, 1, "the seed is a validated document");
  assert.equal(document.constraints.length, 1, "one legacy policy is one constraint");
  const [constraint] = document.constraints;
  assert.equal(constraint.mode, "suspend");
  assert.equal(constraint.enabled, true);
  assert.deepEqual(constraint.subjects, [SUBJECT]);
  assert.deepEqual(constraint.selector.anyOf, [{ surfaces: null, capabilities: null, targets: null }], "`all` stays one unrestricted branch");
  assert.deepEqual(constraint.schedule.weekly, LIVE_WEEKLY, "the window is that window");
  assert.equal(constraint.schedule.timezone, TIMEZONE);
});

test("a refusal names the input to repair, never its content", async () => {
  const work = await workdir("seed-input");
  const { io } = recordingIo();
  try {
    // A bad argument would otherwise refuse the seed and stop the boot with no hint why.
    await assert.rejects(() => seedFile({ file: "", io, build: () => buildSeedDocument(seedInput()) }), TypeError);
    await assert.rejects(() => seedFile({ file: 42, io, build: () => buildSeedDocument(seedInput()) }), TypeError);
    await assert.rejects(() => seedFile({ io }), TypeError);

    // A window conversion is the one refusal that points at the legacy policy document.
    await assert.rejects(
      () => seedFile({ file: work.file, io, build: () => buildSeedDocument(seedInput({ policyDocument: legacyDocument([legacyPolicy({ timezone: "Not/AZone" })]) })) }),
      (error) => {
        assert.equal(error.code, MIGRATION_HOLD);
        assert.equal(error.input, SEED_INPUTS.POLICY_DOCUMENT);
        return true;
      },
    );
    // Everything else points at the credential state.
    await assert.rejects(
      () => seedFile({ file: work.file, io, build: () => buildSeedDocument({ timeConstraintsEnabled: true }) }),
      (error) => {
        assert.equal(error.code, LEGACY_IMPORT_CODES.SNAPSHOT_UNVERIFIED);
        assert.equal(error.input, SEED_INPUTS.LEGACY_STATE);
        return true;
      },
    );
    await assert.rejects(stat(work.file), { code: "ENOENT" }, "no refusal writes anything");
  } finally {
    await work.cleanup();
  }
});

test("the boot line names the file to repair, the code, and nothing else", () => {
  const line = seedRefusalLine(Object.assign(new Error("the legacy policy document cannot be read"), {
    code: "authorization_migration_hold",
    input: SEED_INPUTS.POLICY_DOCUMENT,
  }));
  assert.equal(
    line,
    "[authorization] refusing to start: the authorization document was not seeded (authorization_migration_hold); repair the legacy policy document (access-policy.json)",
  );
  const uncoded = seedRefusalLine(new TypeError("boom"));
  assert.match(uncoded, /\(unknown: TypeError\)/, "an uncoded throw reports its error name");
  assert.ok(uncoded.includes(SEED_INPUTS.DOCUMENT), "the default input is the document itself");
  assert.ok(!uncoded.includes("boom"), "no message content reaches the log");
});

// ---- The two carried-over requirements, against the real process. ----

async function spawnRoot(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `authz-seed-${label}-`));
  await seedVault(root);
  return root;
}

// A boot that is expected to refuse: the code, the whole log, and whether it stayed up.
async function runUntilExit(env, limitMs = 90000) {
  const child = spawn(process.execPath, ["server.js"], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("still-running"), limitMs);
    timer.unref?.();
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  if (code === "still-running") child.kill("SIGKILL");
  return { code, output: output.join("") };
}

function refusalLine(output) {
  const lines = output.split("\n").filter((line) => line.includes("[authorization] refusing to start"));
  assert.equal(lines.length, 1, `exactly one refusal line: ${JSON.stringify(lines)}`);
  return lines[0];
}

test("no credential provider: the seed still installs, carrying the environment key", async () => {
  const root = await spawnRoot("no-provider");
  const env = serverEnv({ port: await freePort(), root, extra: { OAUTH_ENABLED: "false" } });
  const { child, base } = await startServer(env);
  try {
    assert.equal(String((await fetch(`${base}/healthz`)).status), "200", "the server serves");
    const onDisk = JSON.parse(await readFile(path.join(root, "data", "authorization.json"), "utf8"));
    assert.equal(onDisk.revision, 1);
    assert.deepEqual(Object.keys(onDisk.subjects), ["api-key:configured-env"], "the configured key is imported, not skipped");
    assert.equal(onDisk.timeConstraintsEnabled, false, "AUTHZ_ENABLED is off in this fixture");
    assert.ok(Object.values(onDisk.subjects)[0].grants.length > 0, "the key keeps a ceiling");
  } finally {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("feature off (no policy store): the seed installs an empty constraint list", async () => {
  const root = await spawnRoot("feature-off");
  const env = serverEnv({ port: await freePort(), root });
  const { child } = await startServer(env);
  try {
    const onDisk = JSON.parse(await readFile(path.join(root, "data", "authorization.json"), "utf8"));
    assert.equal(onDisk.revision, 1);
    assert.deepEqual(onDisk.constraints, [], "AUTHZ_ENABLED=false is the truthful no-constraints case");
    assert.equal(onDisk.timeConstraintsEnabled, false);
  } finally {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken legacy policy document refuses the seed and writes nothing", async () => {
  const root = await spawnRoot("broken-policy");
  await writeCorruptPolicy(root);
  const env = serverEnv({ port: await freePort(), root, extra: { AUTHZ_ENABLED: "true" } });
  const result = await runUntilExit(env);
  try {
    assert.equal(result.code, 1, "a broken legacy policy document must not serve: a document with no constraints allows");
    const line = refusalLine(result.output);
    assert.match(line, /\([a-z0-9_]+\)/, `the line carries a code: ${line}`);
    assert.ok(line.includes("access-policy.json"), `the line names the file to repair: ${line}`);
    await assert.rejects(stat(path.join(root, "data", "authorization.json")), { code: "ENOENT" }, "no empty document is written");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unusable existing document refuses the boot and keeps its bytes", async () => {
  const root = await spawnRoot("corrupt-document");
  const file = path.join(root, "data", "authorization.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{ not json", "utf8");
  const before = await readFile(file);
  const env = serverEnv({ port: await freePort(), root });
  const result = await runUntilExit(env);
  try {
    assert.equal(result.code, 1, "a refused seed stops the process instead of serving");
    const line = refusalLine(result.output);
    assert.match(line, /\([a-z0-9_]+\)/, `the line carries a code: ${line}`);
    assert.ok(line.includes("authorization.json"), `the line names the file to repair: ${line}`);
    assert.deepEqual(await readFile(file), before, "a seed never replaces an existing document");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
