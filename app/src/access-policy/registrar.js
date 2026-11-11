// AuthZ Wave B / B1 — MCP tool/resource temporal suspend gate.
//
// Contract: `scratch/authz/INTERFACE.md` §10.1 (frozen) + DEVELOPMENT §11.
// The registrar sits between the discovery registrar and the memory-guidance
// registrar (Wave C wiring) and is the one place where an MCP `tools/call` or
// resource read is checked against the access-policy runtime *before* any
// handler runs:
//
//   discovery membership -> temporal access gate -> memory-guidance -> handler
//
// Hard rules (fail closed, no invented semantics):
//  - metadata stays reachable while suspended or broken (A-07): the frozen
//    `METADATA_TOOLS` set and `MEMORY_POLICY_URI` bypass the gate entirely;
//  - a tool/resource the capability catalog does not know is *not* blocked
//    here — unknown-name semantics belong to discovery/protocol, never to the
//    temporal layer (INTERFACE §10.1);
//  - a deny never calls the handler and never leaks subject ids, schedules,
//    policy documents, Vault content or tokens;
//  - `status === "disabled"` is not short-circuited: the runtime decides, so a
//    disabled feature is provably zero-difference;
//  - `explain()` runs only on deny, so the hot path stays evaluate-only.

import { MEMORY_POLICY_URI } from "../agent-bootstrap.js";
import { DEFAULT_VAULT_ID } from "../oauth/primitives.js";
import { requestContext } from "../request-context.js";
import { mcpAuthorizationRequest } from "../authorization/adapters/mcp.js";
import { AUTHORIZATION_DECISION_CODES } from "../authorization/evaluate.js";
import { createAuthorizationSeam } from "../authorization/runtime.js";
import { capabilitiesForResource, capabilitiesForTool } from "./capabilities.js";
import { ACCESS_DENY_CODES } from "./errors.js";

/**
 * Tools that must remain callable while a principal is suspended and while the
 * policy store is broken (DEVELOPMENT A-07). Exported because the coverage
 * contract is frozen: Wave C and the architecture tests reference this set
 * instead of restating names.
 */
export const METADATA_TOOLS = Object.freeze(["server_info", "agent_bootstrap"]);

const METADATA_TOOL_SET = new Set(METADATA_TOOLS);

// Request-level usage state (A-10) established by the auth middleware under the
// frozen `authzUsage` key. The registrar only ever reads this key and only sets
// `denied` on the object it finds; it never creates the context or the key.
function markDenied() {
  const state = requestContext()?.authzUsage;
  if (!state || typeof state !== "object") return;
  try {
    state.denied = true;
  } catch {
    // A frozen/read-only context is not the caller's to fix here; the deny
    // result must still be returned.
  }
}

// Stable machine-readable deny payloads (INTERFACE §10.1, DEVELOPMENT §15).
// Explicit key lists keep both the JSON text and `structuredContent` byte-for-
// byte stable and identical.
function outsideWindowResult(decision) {
  const payload = {
    code: ACCESS_DENY_CODES.OUTSIDE_WINDOW,
    mode: decision.mode,
    policyId: decision.denyConstraintId,
    nextAllowedAt: decision.nextAllowedAt,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}

function policyUnavailableResult() {
  const payload = { code: ACCESS_DENY_CODES.POLICY_UNAVAILABLE };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}

function lastArg(args) {
  return args.length > 1 ? args[args.length - 1] : undefined;
}

/**
 * Wrap an MCP server so every registered tool/resource is gated by the access
 * policy runtime. Returns a registrar shaped like the memory-guidance and
 * discovery registrars (object literal + delegated members) so it can be
 * chained without changing any tool module.
 *
 * @param {object} server upstream registrar or McpServer
 * @param {object} options
 * @param {object} options.runtime access-policy runtime (A4)
 * @param {(name: string) => boolean} [options.isMetadataTool]
 * @param {(uri: string) => boolean} [options.isMetadataResource]
 * @param {object} [options.authorizationShadow] P2 shadow observer; observation only
 * @param {string} [options.primaryVaultId] primary Vault id for the shadow target
 */
export function createAccessPolicyRegistrar(server, { runtime, authorization = null, isMetadataTool, isMetadataResource, authorizationShadow = null, primaryVaultId = DEFAULT_VAULT_ID } = {}) {
  const shadow = authorizationShadow;
  // P3: the runtime decides here too. `runtime` stays as the audit sink and as the old
  // temporal plane the extracted legacy backend reads; it no longer answers anything by
  // itself.
  const decide = createAuthorizationSeam({ authorization, accessRuntime: runtime });

  /**
   * The one decision of this layer. The old capability set travels with the request as
   * frozen data, and the metadata plane states the bypass the old gate applied.
   */
  function decideTemporal({ extra, name, args, resourceUri = null, capabilities = null, bypass = false }) {
    const request = mcpAuthorizationRequest({
      authInfo: extra?.authInfo,
      name: resourceUri === null ? name : null,
      resourceUri,
      args,
      primaryVaultId,
      legacy: { phase: resourceUri === null ? "tool" : "resource", capabilities, bypass },
    });
    if (request === null) return null;
    return { request, decision: decide.authorize(request) };
  }

  function observeTemporal(entry, boundaryKey, phase) {
    if (shadow === null || typeof shadow.compare !== "function" || entry === null) return;
    shadow.compare({ request: entry.request, legacyDecision: entry.decision, boundaryKey, phase });
  }
  const overrideTool = typeof isMetadataTool === "function" ? isMetadataTool : null;
  const overrideResource = typeof isMetadataResource === "function" ? isMetadataResource : null;
  // Overrides are additive only: the frozen metadata plane can never be
  // removed from the bypass by a caller.
  const isMetadata = (name) => METADATA_TOOL_SET.has(name) || overrideTool?.(name) === true;
  const isMetadataUri = (uri) => uri === MEMORY_POLICY_URI || overrideResource?.(uri) === true;

  function deny(decision, capabilities) {
    markDenied();
    const broken = decision.code === AUTHORIZATION_DECISION_CODES.POLICY_UNAVAILABLE;
    // Exactly one `authz.deny` per denied request (INTERFACE §10.1 erratum,
    // DEVELOPMENT §20.10). The A4 runtime owns the field whitelist and stamps
    // `time` from its injected clock, so the registrar passes neither. A failing
    // audit sink must never turn a deny into an allow (A-10).
    try {
      runtime?.audit?.({
        action: "authz.deny",
        outcome: "failure",
        surface: "mcp",
        mode: decision.mode ?? null,
        policyId: decision.denyConstraintId ?? null,
        capabilities,
        nextAllowedAt: decision.nextAllowedAt ?? null,
        reason: broken ? "policy_unavailable" : "outside_window",
      });
    } catch {
      // Audit is best-effort; the deny result stands.
    }
    if (broken) return policyUnavailableResult();
    return outsideWindowResult(decision);
  }

  const registrar = {
    server: server.server,
    getClientVersion: () => server.server?.getClientVersion?.() ?? server.getClientVersion?.(),
    registerTool(name, config, handler) {
      const wrapped = async (...args) => {
        const extra = lastArg(args);
        const capabilities = isMetadata(name) ? null : capabilitiesForTool(name);
        // Unknown tool: discovery/protocol owns that semantics.
        if (!isMetadata(name) && capabilities === null) return handler(...args);
        // Metadata stays reachable while suspended or broken (A-07): the old plane never
        // evaluated it, so the decision states that bypass instead of inventing an answer.
        const entry = decideTemporal({ extra, name, args: args[0], capabilities, bypass: isMetadata(name) });
        // A boundary the adapter cannot normalize keeps the protocol's answer; nothing is
        // decided and nothing is recorded (P2 semantics, unchanged).
        if (entry === null) return handler(...args);
        observeTemporal(entry, name, "tool");
        if (entry.decision.allowed === true) return handler(...args);
        return deny(entry.decision, capabilities ?? []);
      };
      return server.registerTool(name, config, wrapped);
    },
    registerResource(name, uri, config, handler) {
      const wrapped = async (...args) => {
        const extra = lastArg(args);
        const capabilities = isMetadataUri(uri) ? null : capabilitiesForResource(uri);
        // Unknown URI: same rule as unknown tools.
        if (!isMetadataUri(uri) && capabilities === null) return handler(...args);
        const entry = decideTemporal({ extra, resourceUri: uri, name, capabilities, bypass: isMetadataUri(uri) });
        if (entry === null) return handler(...args);
        observeTemporal(entry, uri, "resource");
        if (entry.decision.allowed === true) return handler(...args);
        return deny(entry.decision, capabilities ?? []);
      };
      return server.registerResource(name, uri, config, wrapped);
    },
  };

  // Delegate the remaining registrar surface (prompts, discovery install/state)
  // so chaining never changes what a tool module can reach.
  for (const method of ["registerPrompt", "install"]) {
    if (typeof server[method] === "function") registrar[method] = server[method].bind(server);
  }
  for (const key of Object.keys(server)) {
    if (key in registrar) continue;
    const value = server[key];
    registrar[key] = typeof value === "function" ? value.bind(server) : value;
  }
  return registrar;
}
