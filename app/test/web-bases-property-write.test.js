// The property page's write face (`property-write.js`) — lane desktop-re/bases-property-submenu.
//
// The point of this file is the #624 lesson: a write with NO precondition (428) and a write whose
// revision is stale (409) are different facts with different repairs, so they must stay different
// branches — never one "conflict". Also pinned: the mutation the page writes, the CAS header and
// body, and `value: null` (= delete the key) passing through unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import {
  PROPERTY_WRITE_ENDPOINT,
  createPropertyWriter,
  displayNameMutation,
  patchPropertyDisplayName,
  propertyWriteError,
} from "../frontend/app/features/bases/property-write.js";

function fakeFetch(response, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  };
}

test("the request is a CAS PATCH with the if-match header and body revision", async () => {
  const calls = [];
  const result = await patchPropertyDisplayName({
    fetchImpl: fakeFetch({ status: 200, body: { revision: "rev-2" } }, calls),
    path: "A.base",
    revision: "rev-1",
    property: "status",
    value: "状态",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PROPERTY_WRITE_ENDPOINT);
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].options.headers["if-match"], '"rev-1"');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    path: "A.base",
    mutations: [{ op: "set-property-display-name", property: "status", value: "状态" }],
    ifMatch: "rev-1",
  });
  assert.equal(result.revision, "rev-2");
});

test("the writer never adds a second, case-variant content-type (fetch APPENDS those)", async () => {
  const calls = [];
  await patchPropertyDisplayName({
    fetchImpl: fakeFetch({ status: 200, body: {} }, calls),
    path: "A.base",
    revision: "rev-1",
    property: "status",
    value: "x",
  });
  const keys = Object.keys(calls[0].options.headers);
  // `fetch(url, { headers })` APPENDS a plain object's entries, so `content-type` next to
  // `Content-Type` sends `application/json, application/json`; `express.json` then does not match
  // the media type, the route sees no `path`, and the write dies as 400 `invalid-path` — exactly
  // what the lane's first Chromium probe hit. Content type belongs to the api() wrapper alone.
  const contentTypes = keys.filter((key) => key.toLowerCase() === "content-type");
  assert.ok(contentTypes.length <= 1, `content-type must appear at most once, got ${JSON.stringify(keys)}`);
});

test("clearing the field sends value:null and nothing else (delete the key)", async () => {
  const calls = [];
  await patchPropertyDisplayName({
    fetchImpl: fakeFetch({ status: 200, body: {} }, calls),
    path: "A.base",
    revision: "rev-1",
    property: "status",
    value: null,
  });
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.mutations, [{ op: "set-property-display-name", property: "status", value: null }]);
});

test("428 and 409 are SEPARATE branches, with the 409 carrying the server's currentRevision", () => {
  const required = propertyWriteError(428, { code: "precondition-required", error: "missing If-Match" });
  assert.equal(required.status, 428);
  assert.equal(required.code, "precondition-required");
  assert.equal(required.currentRevision, undefined, "428 says nothing about a revision: there was no precondition");

  const stale = propertyWriteError(409, { code: "revision-conflict", currentRevision: "rev-9" });
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "revision-conflict");
  assert.equal(stale.currentRevision, "rev-9");
  assert.notEqual(stale.message, required.message, "the two faces must not be told apart by status alone");
});

test("a write with no revision is refused locally as 428 and never reaches the network", async () => {
  const calls = [];
  await assert.rejects(
    () => patchPropertyDisplayName({ fetchImpl: fakeFetch({ status: 200, body: {} }, calls), path: "A.base", revision: null, property: "status", value: "x" }),
    (error) => error.status === 428 && error.code === "precondition-required",
  );
  assert.equal(calls.length, 0);
});

test("the writer adopts a fresh revision and reloads on success; a 409 adopts and rethrows WITHOUT reloading", async () => {
  const state = { path: "A.base", revision: "rev-1" };
  let reloads = 0;
  const ok = createPropertyWriter({
    fetchImpl: () => fakeFetch({ status: 200, body: { revision: "rev-2" } }),
    state,
    reload: () => { reloads += 1; },
  });
  await ok({ property: "status", value: "状态" });
  assert.equal(state.revision, "rev-2");
  assert.equal(reloads, 1);

  const stale = createPropertyWriter({
    fetchImpl: () => fakeFetch({ status: 409, body: { code: "revision-conflict", currentRevision: "rev-7" } }),
    state,
    reload: () => { reloads += 1; },
  });
  await assert.rejects(() => stale({ property: "status", value: "again" }), (error) => error.status === 409);
  assert.equal(state.revision, "rev-7", "the stale revision is replaced by the one the document really has");
  // Review D1: a reload here would rebuild the page, dropping the reader's text and the inline
  // error — i.e. it would hide the very refusal it is reporting. Adoption happens without it.
  assert.equal(reloads, 1, "the 409 path must not reload");
});

test("the mutation helper is the route's own vocabulary", () => {
  assert.deepEqual(displayNameMutation("k", null), { op: "set-property-display-name", property: "k", value: null });
});
