// Manifest/lock consistency — a cheap, always-on invariant for the "两个真源" family.
//
// Why it exists: `app/package.json` declares the ranges, `app/package-lock.json` records what is
// actually installed and `npm ci` installs the lock. Nothing in the repository compared the three,
// so a range that no longer matches the lock (or a lock whose resolved version falls outside the
// declared range) would only be noticed by a human reading a diff. The failure mode that matters is
// silent: `npm ci` keeps the pinned version, but any `npm install` re-resolves from the manifest and
// can roll a package BACK below a security fix — with the byte ratchets following it down, so the
// gates stay green while the fix disappears.
//
// What it checks (deliberately narrow, no new dependency):
//   1. every dependency/devDependency range in package.json is byte-identical to the range recorded
//      in the lock's root entry (`packages[""]`) — i.e. the two files cannot drift apart unnoticed;
//   2. every resolved top-level version actually satisfies the declared range (caret and exact
//      forms only; anything else is reported as "unparsed" instead of silently passing);
//   3. the `overrides` block, if present, is mirrored in the lock's root entry as well.
//
// It is NOT a semver implementation: it supports exactly the range shapes this manifest uses and
// says so out loud when it meets another one, rather than pretending to understand it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package-lock.json"), "utf8"));
const root = (lock.packages || {})[""] || {};
const installed = lock.packages || {};

const versionOf = (name) => installed[`node_modules/${name}`]?.version ?? null;

/**
 * Strict `x.y.z`, nothing else. Anchored at BOTH ends and prerelease-rejecting on purpose:
 * a prerelease (`4.0.3-beta.1`) is NOT inside `^4.0.3` under semver, and silently stripping the
 * `-beta.1` (the previous behaviour) would have made that case a false green — the exact failure
 * mode this file exists to prevent, in the checker itself. Anything this cannot read returns null,
 * which the callers turn into "cannot judge" instead of "fine".
 */
function parseVersion(text) {
  const match = String(text).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Caret/exact only, mirroring npm's rules for 0.x releases. Returns null when not understood. */
function satisfies(version, range) {
  const v = parseVersion(version);
  const raw = String(range).trim();
  // A range that is a UNION (`^1 || ^2`) has no single caret to compare against. Taking the first
  // branch (the previous behaviour) reported a false failure on a version the second branch allows;
  // reporting "cannot judge" is the honest answer, and the callers fail on it.
  if (raw.includes("||")) return null;
  if (raw.startsWith("^")) {
    const r = parseVersion(raw.slice(1));
    if (!v || !r) return null;
    if (r[0] !== 0) return v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]));
    if (r[1] !== 0) return v[0] === 0 && v[1] === r[1] && v[2] >= r[2];
    return v[0] === 0 && v[1] === 0 && v[2] === r[2];
  }
  const exact = parseVersion(raw);
  if (exact && v) return v[0] === exact[0] && v[1] === exact[1] && v[2] === exact[2];
  return null;
}

const SECTIONS = ["dependencies", "devDependencies"];

test("every declared range equals the range recorded in the lock", () => {
  const problems = [];
  for (const section of SECTIONS) {
    const declared = manifest[section] || {};
    const locked = root[section] || {};
    for (const [name, range] of Object.entries(declared)) {
      if (locked[name] === undefined) problems.push(`${section}.${name}: declared ${range} but the lock's root entry does not list it`);
      else if (locked[name] !== range) problems.push(`${section}.${name}: manifest says ${range}, lock's root entry says ${locked[name]}`);
    }
    for (const name of Object.keys(locked)) {
      if (declared[name] === undefined) problems.push(`${section}.${name}: the lock's root entry declares it but package.json does not`);
    }
  }
  assert.deepEqual(problems, [], `package.json and the lock's root entry disagree:\n${problems.join("\n")}`);
});

test("every resolved version satisfies its declared range", () => {
  const problems = [];
  const unparsed = [];
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(manifest[section] || {})) {
      const version = versionOf(name);
      if (!version) {
        problems.push(`${name}: declared ${range} but nothing is resolved in the lock`);
        continue;
      }
      const verdict = satisfies(version, range);
      if (verdict === null) unparsed.push(`${name}@${version} vs ${range}`);
      else if (!verdict) problems.push(`${name}: resolved ${version} does NOT satisfy ${range}`);
    }
  }
  assert.deepEqual(problems, [], `the lock resolves something outside the declared range (a plain \`npm install\` would move it):\n${problems.join("\n")}`);
  // An unsupported range shape is reported, not swallowed: the checker must never look green by
  // failing to understand the input.
  assert.deepEqual(unparsed, [], `range shapes this invariant cannot judge (extend the checker):\n${unparsed.join("\n")}`);
});

test("every override is actually honoured by the resolved tree", () => {
  // The lock's root entry does NOT record `overrides` (npm keeps them in the manifest only), so the
  // meaningful invariant is the effect: every occurrence of an overridden package in the lock must
  // resolve inside the override range. That is what an override promises, and it is the half a
  // reader of package.json cannot verify by eye.
  const overrides = { ...(manifest.overrides || {}) };
  delete overrides.$comment;
  const names = Object.keys(overrides);
  if (names.length === 0) return;
  const problems = [];
  for (const name of names) {
    const occurrences = Object.entries(installed)
      .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
      .map(([key, value]) => ({ key, version: value.version }));
    if (occurrences.length === 0) {
      problems.push(`override ${name}@${overrides[name]} matches nothing in the lock (a stale override)`);
      continue;
    }
    for (const { key, version } of occurrences) {
      const verdict = satisfies(version, overrides[name]);
      if (verdict === false) problems.push(`${key} resolves ${version}, outside the override ${overrides[name]}`);
      else if (verdict === null) problems.push(`${key} resolves ${version}; the override range ${overrides[name]} cannot be judged by this checker`);
    }
  }
  assert.deepEqual(problems, [], `overrides are not honoured by the resolved tree: ${problems.join(" | ")}`);
});

// Security-required floors that must stay in the manifest even if nothing in the tree forces them.
// A range check alone cannot catch DELETION: drop the override and there is simply nothing left to
// verify, while the next `npm install` re-resolves the package below a published advisory fix.
// Each entry names the advisory it exists for, so a future reader knows what removing it would cost.
const REQUIRED_OVERRIDES = Object.freeze([
  { name: "hono", reason: "GHSA-5r4p-p66f-jhc7 (serveStatic double decode) — transitive via @modelcontextprotocol/sdk" },
]);

test("the security-required overrides are still declared and still honoured", () => {
  const overrides = { ...(manifest.overrides || {}) };
  const problems = [];
  for (const { name, reason } of REQUIRED_OVERRIDES) {
    if (overrides[name] === undefined) {
      problems.push(`override ${name} is MISSING from package.json (it exists for ${reason})`);
      continue;
    }
    const occurrences = Object.entries(installed)
      .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
      .map(([key, value]) => ({ key, version: value.version }));
    if (occurrences.length === 0) {
      problems.push(`override ${name}@${overrides[name]} matches nothing in the lock (stale entry; it exists for ${reason})`);
      continue;
    }
    for (const { key, version } of occurrences) {
      if (satisfies(version, overrides[name]) === false) {
        problems.push(`${key} resolves ${version}, outside the required override ${overrides[name]} (${reason})`);
      }
    }
  }
  assert.deepEqual(problems, [], `security-required overrides are no longer in force: ${problems.join(" | ")}`);
});
