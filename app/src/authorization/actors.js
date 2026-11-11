// P1 / Task 8 — trusted actors for the authorization plane.
//
// Contract: design §6 (VerifiedActor) and §5.2 (identity kinds). An actor is built
// only from a verified authentication result, by `verifiedActor()`. A request body,
// a `_meta` object, a header or any other caller-supplied object can never become
// one: see the brand below, which `runtime.js` requires and which does not survive
// a copy or a JSON round trip.
//
// Every fact an actor carries must be stated explicitly by the verifier: a missing
// `grantCeiling` is refused rather than read as "no tightening", because that
// default would be a fail-open.

import { isValidSubject } from "../access-policy/subjects.js";

export const VERIFIED_ACTOR_KINDS = Object.freeze([
  "oauth", "api-key", "environment-key", "web-session", "admin-session", "publication", "system", "deployment-anonymous",
]);

const SUBJECT_KINDS = new Set(["oauth", "api-key", "environment-key", "web-session"]);
const PROOF_KINDS = new Set(["admin-session", "publication", "system", "deployment-anonymous"]);
const VERIFICATION_KEYS = Object.freeze([
  "subjectIds", "credentialId", "credentialEpochs", "grantCeiling", "audience",
  "expiresAt", "revoked", "transferGeneration", "proof", "authMode",
]);
const MAX_CREDENTIAL_ID_LENGTH = 160;
const UNSAFE_ID_PATTERN = /[\s\u0000-\u001f\u007f*]/;

// A private, non-serializable brand: `{...actor}`, `JSON.parse(JSON.stringify(actor))`
// and any object a transport could build all lose it.
const BRAND = Symbol("authorization.verified-actor");

function refuse(reason) {
  const error = new TypeError(`invalid verification: ${reason}`);
  error.code = "authorization_actor_invalid";
  throw error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function normalizeSubjectIds(raw, kind) {
  if (!Array.isArray(raw)) refuse("subjectIds must be an array");
  const seen = new Set();
  for (const subjectId of raw) {
    if (!isValidSubject(subjectId)) refuse("subjectIds carries an invalid subject id");
    if (seen.has(subjectId)) refuse("subjectIds repeats a subject");
    seen.add(subjectId);
  }
  if (SUBJECT_KINDS.has(kind) && raw.length === 0) refuse("a credential actor needs at least one subject");
  return [...raw];
}

function normalizeCredentialId(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CREDENTIAL_ID_LENGTH || UNSAFE_ID_PATTERN.test(raw)) {
    refuse("credentialId must be a printable identifier, never a secret");
  }
  return raw;
}

function normalizeEpochs(raw, subjectIds) {
  if (!isRecord(raw)) refuse("credentialEpochs must be a record");
  const expected = [...subjectIds].sort();
  const keys = Object.keys(raw).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    refuse("credentialEpochs must state exactly the claimed subjects");
  }
  const epochs = {};
  for (const subjectId of expected) {
    const epoch = raw[subjectId];
    if (!Number.isInteger(epoch) || epoch < 0) refuse("credentialEpochs must be non-negative integers");
    epochs[subjectId] = epoch;
  }
  return epochs;
}

function normalizeGrantCeiling(raw) {
  if (raw === null) return null;
  if (!Array.isArray(raw)) refuse("grantCeiling must be null or an array");
  return raw.map((grant) => {
    if (!isRecord(grant) || !isRecord(grant.target)) refuse("a grant needs a target");
    const { target } = grant;
    if (target.kind === "vault") {
      if (typeof target.vaultId !== "string" || target.vaultId.length === 0) refuse("a Vault grant needs a Vault id");
    } else if (target.kind !== "instance") {
      refuse("a grant target is a Vault or the instance");
    }
    if (!Array.isArray(grant.capabilities) || grant.capabilities.some((capability) => typeof capability !== "string")) {
      refuse("a grant needs a capability list");
    }
    return deepFreeze({ target: { ...target }, capabilities: [...grant.capabilities] });
  });
}

function normalizeProof(raw, kind, authMode) {
  if (raw === null) {
    if (kind === "admin-session" || kind === "publication" || kind === "system" || kind === "deployment-anonymous") {
      refuse(`a ${kind} actor needs its proof`);
    }
    return null;
  }
  if (!isRecord(raw) || !PROOF_KINDS.has(raw.kind)) refuse("unknown proof");
  if (kind === "admin-session") {
    if (raw.kind !== "admin-session") refuse("the proof does not match the actor kind");
    return deepFreeze({ kind: "admin-session" });
  }
  if (kind === "publication") {
    if (raw.kind !== "publication" || typeof raw.id !== "string" || raw.id.length === 0) refuse("a publication proof needs its record id");
    return deepFreeze({ kind: "publication", id: raw.id });
  }
  if (kind === "system") {
    if (raw.kind !== "system" || typeof raw.vaultId !== "string" || (raw.task !== "commit" && raw.task !== "push")) {
      refuse("a system proof needs a Vault and a task");
    }
    return deepFreeze({ kind: "system", vaultId: raw.vaultId, task: raw.task });
  }
  if (kind === "deployment-anonymous") {
    // §5.2: only the composition root may inject this actor, and only when the
    // deployment explicitly runs without authentication.
    if (raw.kind !== "deployment-anonymous") refuse("the proof does not match the actor kind");
    if (authMode !== "none") refuse("a no-auth deployment must be stated explicitly");
    return deepFreeze({ kind: "deployment-anonymous" });
  }
  refuse("a credential actor must not carry a proof");
}

/**
 * `verifiedActor(kind, verification) -> VerifiedActor`.
 * The verification is the output of a verifier, never a transport payload.
 */
export function verifiedActor(kind, verification) {
  if (typeof kind !== "string" || !VERIFIED_ACTOR_KINDS.includes(kind)) refuse("unknown actor kind");
  if (!isRecord(verification)) refuse("verification must be an object");
  for (const key of Object.keys(verification)) {
    if (!VERIFICATION_KEYS.includes(key)) refuse(`unknown verification field ${key}`);
  }
  for (const key of VERIFICATION_KEYS) {
    if (key === "authMode") continue; // only the anonymous deployment needs it
    if (!Object.hasOwn(verification, key)) refuse(`the verifier must state ${key}`);
  }

  const subjectIds = normalizeSubjectIds(verification.subjectIds, kind);
  const credentialId = normalizeCredentialId(verification.credentialId);
  const credentialEpochs = normalizeEpochs(verification.credentialEpochs, subjectIds);

  const grantCeiling = normalizeGrantCeiling(verification.grantCeiling);
  // The same invariant `authorize()` enforces for a direct caller: a ceiling needs a
  // subject to bind it, so a trusted kind with no subjects carries no ceiling.
  if (subjectIds.length === 0 && grantCeiling !== null) refuse("a grant ceiling needs a subject to bind it");
  // A background task or the console is not a person's credential: a subject there
  // would let one account's window stop a task, or turn a user revoke into a
  // transport refusal of the console.
  if ((kind === "system" || kind === "admin-session") && subjectIds.length > 0) refuse(`a ${kind} actor must not carry a subject`);
  const { audience, expiresAt, revoked, transferGeneration } = verification;
  if (audience !== null && (typeof audience !== "string" || audience.length === 0)) refuse("audience must be null or a non-empty string");
  if (expiresAt !== null && !(typeof expiresAt === "number" && Number.isFinite(expiresAt))) refuse("expiresAt must be null or epoch milliseconds");
  if (typeof revoked !== "boolean") refuse("revoked must be boolean");
  if (transferGeneration !== null && !(Number.isInteger(transferGeneration) && transferGeneration >= 0)) {
    refuse("transferGeneration must be null or a non-negative integer");
  }
  const proof = normalizeProof(verification.proof, kind, verification.authMode);

  const actor = {
    kind,
    subjectIds,
    credentialId,
    credentialEpochs,
    grantCeiling,
    audience,
    expiresAt,
    revoked,
    transferGeneration,
    proof,
  };
  // The brand goes on before the freeze: a frozen object cannot take a new key.
  Object.defineProperty(actor, BRAND, { value: true, enumerable: false, configurable: false, writable: false });
  return Object.freeze(actor);
}

/** True only for an object that `verifiedActor()` built in this process. */
export function isVerifiedActor(value) {
  return Boolean(value) && typeof value === "object" && value[BRAND] === true;
}
