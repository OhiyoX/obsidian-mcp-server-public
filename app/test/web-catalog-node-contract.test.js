// Guards the frozen Node baseline for the Web Catalog driver.
//
// `sqlite-store.js` imports the built-in `node:sqlite` (DatabaseSync), which is
// supports the required FTS5 build from Node 22.16 — so the runtime/CI/deploy contract must not drift
// back to Node 20. If a different driver (or a compat layer) is ever chosen, this
// test is where the new contract is recorded.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "..");

test("the Web Catalog node:sqlite driver freezes the Node baseline at >= 22.16", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  assert.match(pkg.engines.node, />=\s*22\.16/, "package.json engines");
  const lock = JSON.parse(fs.readFileSync(path.join(appRoot, "package-lock.json"), "utf8"));
  assert.match(lock.packages[""].engines.node, />=\s*22\.16/, "package-lock root engines");

  assert.match(fs.readFileSync(path.join(appRoot, "Dockerfile"), "utf8"), /node:22\.16-alpine/, "Dockerfile");
  assert.match(fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8"), /node:22\.16-alpine/, ".env.example");

  const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  if (/actions\/setup-node/.test(ci)) {
    const versions = [...ci.matchAll(/node-version:\s*'([^']+)'/g)].map((match) => match[1]);
    assert.ok(versions.length >= 1, "CI must declare node-version when it installs Node");
    assert.ok(versions.every((version) => version === "22.16"), `CI node-version must be 22.16: ${versions.join(", ")}`);
  } else {
    // Self-hosted: the runner image provides Node, so nothing is installed via
    // actions/setup-node. The frozen baseline must still be declared and checked
    // against the runtime on every job, otherwise this contract could drift to
    // Node 20 without anyone noticing.
    assert.match(ci, /NODE_BASELINE:\s*'22\.16'/, "CI must declare the frozen Node baseline");
    assert.match(ci, /process\.versions\.node/, "CI must verify the runtime Node version against the baseline");
  }

  const store = fs.readFileSync(path.join(appRoot, "src", "app", "web-catalog", "sqlite-store.js"), "utf8");
  assert.match(store, /from "node:sqlite"/, "driver must be the built-in node:sqlite");
});

test("the supported runtime can create and query the actual FTS5 catalog", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(content)");
    db.prepare("INSERT INTO probe(content) VALUES (?)").run("catalog runtime contract");
    assert.equal(db.prepare("SELECT count(*) AS count FROM probe WHERE probe MATCH ?").get("catalog").count, 1);
  } finally {
    db.close();
  }
});
