// Focused tests for AuthZ Wave A / A2 identity normalization
// (app/src/access-policy/subjects.js). Read-only pure-module tests: no I/O, no
// clock, no Vault, no server. Contract: scratch/authz/INTERFACE.md §5.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONFIGURED_ENV_SUBJECT,
  SUBJECT_TYPES,
  isValidSubject,
  parseSubject,
  subjectsFromAuthInfo,
  subjectsFromMcpAuth,
  subjectsFromOAuthRecord,
  subjectsFromWebSession,
} from "../src/access-policy/subjects.js";

const MODULE_URL = new URL("../src/access-policy/subjects.js", import.meta.url);

function sorted(values) {
  return [...values].sort();
}

test("declares the frozen subject namespace and the configured-env sentinel", () => {
  assert.deepEqual(SUBJECT_TYPES, ["api-key", "oauth-client", "oauth-user"]);
  assert.equal(Object.isFrozen(SUBJECT_TYPES), true);
  assert.equal(CONFIGURED_ENV_SUBJECT, "api-key:configured-env");
});

test("parseSubject accepts every frozen type in the `<type>:<id>` shape", () => {
  assert.deepEqual(parseSubject("api-key:configured-env"), { type: "api-key", id: "configured-env" });
  assert.deepEqual(parseSubject("api-key:3f2a-9"), { type: "api-key", id: "3f2a-9" });
  assert.deepEqual(parseSubject("oauth-client:c-1"), { type: "oauth-client", id: "c-1" });
  assert.deepEqual(parseSubject("oauth-user:u-1"), { type: "oauth-user", id: "u-1" });
  assert.deepEqual(parseSubject(`api-key:${"x".repeat(160)}`), { type: "api-key", id: "x".repeat(160) });
  assert.equal(isValidSubject("oauth-user:u-1"), true);
  assert.equal(isValidSubject(CONFIGURED_ENV_SUBJECT), true);
});

test("parseSubject rejects wildcards, blanks, control characters, overlong ids and unknown prefixes", () => {
  const rejected = [
    "", "   ", "*", "api-key:", ":", "api-key: middle", "api-key:tail ",
    "api-key:bad id", "api-key:line\nbreak", "api-key:tab\tid", "api-key:null\u0000id",
    "api-key:del\u007fid", "api-key:*", "api-key:a*b", `api-key:${"x".repeat(161)}`,
    "user:u-1", "token:abc", "oauth-clientx:c", "oauth:u-1", "api-key", "oauth-user",
    null, undefined, 42, {}, [], true,
  ];
  for (const value of rejected) {
    assert.equal(parseSubject(value), null, `expected parseSubject(${JSON.stringify(value)}) === null`);
    assert.equal(isValidSubject(value), false);
  }
});

test("configured env API key maps to the sentinel, managed keys map to api-key:<keyId>", () => {
  assert.deepEqual(
    subjectsFromMcpAuth({ type: "api-key", keyId: "configured-env", clientId: "api-key:configured-env", scopes: ["obsidian.read"] }),
    [CONFIGURED_ENV_SUBJECT],
  );
  assert.deepEqual(
    subjectsFromMcpAuth({ type: "api-key", keyId: "3f2a", clientId: "api-key:3f2a", allowedVaults: ["main"] }),
    ["api-key:3f2a"],
  );
  // The sentinel is decided by keyId, never by a forgeable clientId string.
  assert.deepEqual(subjectsFromMcpAuth({ type: "api-key", keyId: "k1", clientId: "api-key:configured-env" }), ["api-key:k1"]);
  assert.deepEqual(subjectsFromMcpAuth({ type: "api-key", keyId: "configured-env", clientId: "api-key:other" }), [CONFIGURED_ENV_SUBJECT]);
  // An api-key identity without a usable keyId fails closed instead of falling
  // back to clientId.
  assert.deepEqual(subjectsFromMcpAuth({ type: "api-key", clientId: "api-key:abc" }), []);
  assert.deepEqual(subjectsFromMcpAuth({ type: "api-key", keyId: "" }), []);
});

test("OAuth access-token identity maps to client + user; client-only maps to client only", () => {
  const userToken = { token: "SECRET-TOKEN", type: "oauth", clientId: "client-1", userId: "user-1", scopes: ["obsidian.read"] };
  assert.deepEqual(subjectsFromMcpAuth(userToken), ["oauth-client:client-1", "oauth-user:user-1"]);
  assert.deepEqual(subjectsFromMcpAuth({ type: "oauth", clientId: "client-1", userId: null }), ["oauth-client:client-1"]);
  assert.deepEqual(subjectsFromMcpAuth({ type: "oauth", clientId: "client-1" }), ["oauth-client:client-1"]);
  // `userId` present without an explicit type still selects the OAuth branch.
  assert.deepEqual(subjectsFromMcpAuth({ clientId: "client-1", userId: "user-1" }), ["oauth-client:client-1", "oauth-user:user-1"]);
});

test("Web session identity maps to oauth-user only", () => {
  const session = { id: "raw-session-token", userId: "user-7", username: "alice", displayName: "Alice", vaultId: "main" };
  assert.deepEqual(subjectsFromWebSession(session), ["oauth-user:user-7"]);
});

test("OAuth record mapping covers client-only and client+user", () => {
  assert.deepEqual(subjectsFromOAuthRecord("client-1", "user-1"), ["oauth-client:client-1", "oauth-user:user-1"]);
  assert.deepEqual(subjectsFromOAuthRecord("client-1", null), ["oauth-client:client-1"]);
  assert.deepEqual(subjectsFromOAuthRecord("client-1", undefined), ["oauth-client:client-1"]);
  assert.deepEqual(subjectsFromOAuthRecord("client-1", ""), ["oauth-client:client-1"]);
});

test("authInfo identity covers SDK fields and the app's extra.* carrier", () => {
  assert.deepEqual(subjectsFromAuthInfo({ clientId: "client-1", userId: "user-1" }), ["oauth-client:client-1", "oauth-user:user-1"]);
  assert.deepEqual(subjectsFromAuthInfo({ clientId: "client-1", extra: { userId: "user-1" } }), ["oauth-client:client-1", "oauth-user:user-1"]);
  assert.deepEqual(subjectsFromAuthInfo({ extra: { clientId: "client-1", userId: "user-1" } }), ["oauth-client:client-1", "oauth-user:user-1"]);
  assert.deepEqual(subjectsFromAuthInfo({ clientId: "client-1" }), ["oauth-client:client-1"]);
  assert.deepEqual(
    subjectsFromAuthInfo({ type: "api-key", extra: { type: "api-key", keyId: "configured-env" } }),
    [CONFIGURED_ENV_SUBJECT],
  );
  assert.deepEqual(subjectsFromAuthInfo({ type: "api-key", keyId: "k9", clientId: "client-1" }), ["api-key:k9"]);
  assert.deepEqual(subjectsFromAuthInfo({ type: "api-key" }), []);
});

test("empty or missing ids are omitted, never turned into a wildcard subject", () => {
  const emptyCases = [
    subjectsFromMcpAuth({ type: "api-key", keyId: "" }),
    subjectsFromMcpAuth({ type: "api-key" }),
    subjectsFromMcpAuth({}),
    subjectsFromMcpAuth({ type: "oauth", clientId: "", userId: "" }),
    subjectsFromMcpAuth({ type: "oauth" }),
    subjectsFromWebSession({}),
    subjectsFromWebSession({ userId: "" }),
    subjectsFromOAuthRecord("", ""),
    subjectsFromOAuthRecord(undefined, undefined),
    subjectsFromOAuthRecord(null, null),
    subjectsFromAuthInfo({}),
    subjectsFromAuthInfo(null),
    subjectsFromAuthInfo({ type: "oauth", clientId: "", extra: {} }),
  ];
  for (const result of emptyCases) assert.deepEqual(result, []);
  // Partial identity keeps only the derivable half.
  assert.deepEqual(subjectsFromMcpAuth({ type: "oauth", clientId: "client-1", userId: "" }), ["oauth-client:client-1"]);
  assert.deepEqual(subjectsFromOAuthRecord("", "user-1"), ["oauth-user:user-1"]);
  assert.deepEqual(subjectsFromWebSession({ userId: "user-1" }), ["oauth-user:user-1"]);
});

test("outputs are sorted, deduplicated and never contain an empty-id suffix", () => {
  const outputs = [
    subjectsFromMcpAuth({ type: "oauth", clientId: "b-client", userId: "a-user" }),
    subjectsFromMcpAuth({ type: "api-key", keyId: "configured-env" }),
    subjectsFromWebSession({ userId: "user-1" }),
    subjectsFromOAuthRecord("client-1", "user-1"),
    subjectsFromAuthInfo({ clientId: "client-1", userId: "user-1" }),
  ];
  for (const output of outputs) {
    assert.deepEqual(output, sorted(output), "subjects must be lexicographically sorted");
    assert.equal(new Set(output).size, output.length, "subjects must be deduplicated");
    for (const subject of output) {
      assert.equal(isValidSubject(subject), true, `${subject} must be a valid subject`);
      assert.doesNotMatch(subject, /:(?:$|\*)/, "no bare or wildcard subject");
    }
  }
  // Sorting is independent of argument order and stable across calls.
  assert.deepEqual(subjectsFromOAuthRecord("b-client", "a-user"), ["oauth-client:b-client", "oauth-user:a-user"]);
  assert.deepEqual(subjectsFromOAuthRecord("client-1", "user-1"), subjectsFromOAuthRecord("client-1", "user-1"));
});

test("wildcard-shaped ids never reach the result", () => {
  assert.deepEqual(subjectsFromMcpAuth({ type: "api-key", keyId: "*" }), []);
  assert.deepEqual(subjectsFromMcpAuth({ type: "api-key", keyId: "a*b" }), []);
  assert.deepEqual(subjectsFromOAuthRecord("a*", "b"), ["oauth-user:b"]);
  assert.deepEqual(subjectsFromWebSession({ userId: "*" }), []);
  assert.deepEqual(subjectsFromMcpAuth({ type: "oauth", clientId: "*", userId: "user-1" }), ["oauth-user:user-1"]);
});

test("username/displayName are never used and tokens never leak into subjects", () => {
  const first = subjectsFromWebSession({ userId: "user-1", username: "alice", displayName: "Alice" });
  const second = subjectsFromWebSession({ userId: "user-1", username: "bob", displayName: "Bob" });
  assert.deepEqual(first, second);
  assert.deepEqual(subjectsFromWebSession({ username: "alice", displayName: "Alice" }), []);
  assert.deepEqual(subjectsFromMcpAuth({ username: "alice", displayName: "Alice" }), []);

  const leaky = [
    subjectsFromMcpAuth({ type: "api-key", keyId: "k1", secret: "SECRET-KEY", token: "SECRET-TOKEN" }),
    subjectsFromMcpAuth({ type: "oauth", clientId: "c1", userId: "u1", token: "SECRET-TOKEN", accessToken: "SECRET-TOKEN" }),
    subjectsFromOAuthRecord("c1", "u1"),
    subjectsFromWebSession({ userId: "u1", id: "RAW-SESSION-TOKEN" }),
    subjectsFromAuthInfo({ clientId: "c1", userId: "u1", token: "SECRET-TOKEN" }),
  ];
  for (const output of leaky) {
    assert.doesNotMatch(JSON.stringify(output), /SECRET|RAW-SESSION-TOKEN/);
  }
});

test("module stays pure: no clock, no environment, no I/O", async () => {
  const text = await readFile(MODULE_URL, "utf8");
  const lines = text.split(/\r?\n/);
  assert.ok(lines.length <= 500, `subjects.js is ${lines.length} lines`);
  assert.doesNotMatch(text, /Date\.now|process\.env|node:fs|node:child_process/);
  assert.doesNotMatch(text, /\.(?:username|displayName|token|secret)\b/);
});
