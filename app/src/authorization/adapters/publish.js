// P2 / Task 16 — the anonymous Publish delegation.
// A new file outside the plan's file list: pure mapping plus observation, no decision.
//
// Contract: design §6.1.6. A public link is ONE exact record: the actor is
// `publication` with the proof of that record, the target is that record, and nothing
// from the URL can name a Vault or a path. The publisher's account is never consulted,
// so narrowing or owning the publisher cannot revoke a link, and a link can never lend
// its publisher's rights to another document.
//
// The verified record is carried to the runtime through a request scope, the same way
// the Web session half of the identity projection travels: only the service that read
// the record can put it there.

import { AsyncLocalStorage } from "node:async_hooks";

import { verifiedActor } from "../actors.js";
import { withShadowRequest } from "../shadow.js";
import { authorizationOperation, capabilityForBoundary, isOutsideTemporalPlane, surfaceForBoundary } from "../catalog.js";
import { AUTHORIZATION_DECISION_CODES } from "../evaluate.js";

const C = AUTHORIZATION_DECISION_CODES;
// The document read's boundary. Every caller that omits `boundary` gets it, so the one
// existing public route keeps its answer bit for bit; the folder routes pass their own.
const BOUNDARY = "GET /publish/:id";

/** The old public read's answer: the record is servable, or it is not found. */
export const PUBLISH_LEGACY_VERDICTS = Object.freeze({
  allowed: Object.freeze({ allowed: true, code: C.ALLOWED }),
  notFound: Object.freeze({ allowed: false, code: C.INVALID_CREDENTIAL }),
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * `publicationVerifiedActor({id}) -> VerifiedActor|null`
 *
 * Kind `publication`, no subject at all (a link is not a person's credential), and the
 * record id as the proof. A caller cannot choose the id: the service passes the id of
 * the record it already read.
 */
export function publicationVerifiedActor({ id } = {}) {
  if (typeof id !== "string" || id.length === 0 || id.length > 160) return null;
  try {
    return verifiedActor("publication", {
      subjectIds: [],
      credentialId: `publication:${id}`,
      credentialEpochs: {},
      grantCeiling: null,
      audience: null,
      expiresAt: null,
      revoked: false,
      transferGeneration: 0,
      proof: { kind: "publication", id },
    });
  } catch {
    return null;
  }
}

/**
 * `publicationAuthorizationRequest({id, boundary}) -> AuthorizationRequest|null`
 *
 * The one capability of the publish surface, on the record's own target. An exempt or
 * unknown boundary returns `null`, so nothing calls `authorize()` for it. `boundary`
 * defaults to the document read, so a caller that predates the folder routes is unchanged.
 */
export function publicationAuthorizationRequest({ id, boundary = BOUNDARY } = {}) {
  const capability = capabilityForBoundary(boundary);
  const surface = surfaceForBoundary(boundary);
  if (capability === null || surface !== "publish") return null;
  if (authorizationOperation(capability) === null || isOutsideTemporalPlane(capability)) return null;
  const actor = publicationVerifiedActor({ id });
  if (actor === null) return null;
  // The transitional bridge phase: the public read is a trusted lifecycle surface, decided by
  // the record itself (P3/P6: the field disappears with the bridge).
  return { actor, capability, target: { kind: "publication", id }, surface, legacy: { phase: "publish" } };
}

/** The verified active record of the public read in flight, or `null`. */
const publicationScope = new AsyncLocalStorage();

/** Run `fn` with this read's verified record visible to the runtime's snapshot. */
export function withPublicationRecord(record, fn) {
  const verified = isRecord(record) && typeof record.id === "string"
    ? Object.freeze({
      id: record.id,
      vaultId: typeof record.vaultId === "string" ? record.vaultId : null,
      path: typeof record.path === "string" ? record.path : null,
      active: record.active !== false,
    })
    : null;
  return publicationScope.run(verified, fn);
}

/** The verified record of the read in flight (the runtime's publication snapshot). */
export function currentPublicationRecord() {
  return publicationScope.getStore() ?? null;
}

let readSequence = 0;

/**
 * `observePublicationRead({shadow, record, legacyDecision, boundary}) -> void`
 *
 * One row per public read, recorded after the service verified the record and before it
 * reads the body. The record itself is the snapshot, so a refusal can only be about
 * this document: a link cannot borrow its publisher's rights or reach another file.
 */
export function observePublicationRead({ shadow, record, legacyDecision = PUBLISH_LEGACY_VERDICTS.allowed, boundary = BOUNDARY } = {}) {
  if (shadow === null || shadow === undefined || typeof shadow.compare !== "function") return;
  if (!isRecord(record) || typeof record.id !== "string") return;
  const scope = typeof shadow.begin === "function" ? shadow.begin({ requestId: `publish-${readSequence += 1}` }) : null;
  const run = () => withPublicationRecord(record, () => {
    const request = publicationAuthorizationRequest({ id: record.id, boundary });
    if (request === null) return;
    shadow.compare({ request, legacyDecision, boundaryKey: boundary, phase: "publish" });
  });
  if (scope === null) {
    run();
    return;
  }
  try {
    withShadowRequest(scope, run);
  } finally {
    scope.end();
  }
}

/**
 * `mapPublicationAuthorizationDenial(decision, {page}) -> {status, body}|null`
 *
 * The P3/P4 bridge. A public link that the model refuses is answered exactly like a
 * retired one: 404, with no body and no hint about the Vault or the publisher.
 */
export function mapPublicationAuthorizationDenial(decision, { page = false } = {}) {
  if (!isRecord(decision) || decision.allowed === true) return null;
  if (decision.code === C.OUTSIDE_WINDOW || decision.code === C.POLICY_UNAVAILABLE || decision.code === C.STATE_UNAVAILABLE) {
    // A public link keeps its own contract: a broken permission file neither promotes
    // nor revokes it (design §9). Only the record's own lifecycle answers 404.
    return page ? { status: 404 } : { status: 404, body: { error: "Not found" } };
  }
  return page ? { status: 404 } : { status: 404, body: { error: "Not found" } };
}
