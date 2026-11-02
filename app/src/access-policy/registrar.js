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
import { requestContext } from "../request-context.js";
import { capabilitiesForResource, capabilitiesForTool } from "./capabilities.js";
import { ACCESS_DENY_CODES } from "./errors.js";
import { subjectsFromAuthInfo } from "./subjects.js";

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
function outsideWindowResult(decision, nextAllowedAt) {
  const payload = {
    code: ACCESS_DENY_CODES.OUTSIDE_WINDOW,
    mode: decision.mode,
    policyId: decision.denyPolicyId,
    nextAllowedAt,
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
 */
export function createAccessPolicyRegistrar(server, { runtime, isMetadataTool, isMetadataResource } = {}) {
  const overrideTool = typeof isMetadataTool === "function" ? isMetadataTool : null;
  const overrideResource = typeof isMetadataResource === "function" ? isMetadataResource : null;
  // Overrides are additive only: the frozen metadata plane can never be
  // removed from the bypass by a caller.
  const isMetadata = (name) => METADATA_TOOL_SET.has(name) || overrideTool?.(name) === true;
  const isMetadataUri = (uri) => uri === MEMORY_POLICY_URI || overrideResource?.(uri) === true;

  function deny(decision, subjects, capabilities) {
    markDenied();
    const broken = decision.reason === "policy_unavailable";
    // `explain` only runs for a real temporal deny; the broken plane has no
    // meaningful next window (INTERFACE §10.1, DEVELOPMENT A-11).
    const explained = broken ? null : runtime.explain({ subjects, capabilities });
    const nextAllowedAt = explained?.nextAllowedAt ?? null;
    // Exactly one `authz.deny` per denied request (INTERFACE §10.1 erratum,
    // DEVELOPMENT §20.10). The A4 runtime owns the field whitelist and stamps
    // `time` from its injected clock, so the registrar passes neither. A failing
    // audit sink must never turn a deny into an allow (A-10).
    try {
      runtime.audit?.({
        action: "authz.deny",
        outcome: "failure",
        surface: "mcp",
        mode: decision.mode ?? null,
        policyId: decision.denyPolicyId ?? null,
        capabilities,
        nextAllowedAt,
        reason: decision.reason,
      });
    } catch {
      // Audit is best-effort; the deny result stands.
    }
    if (broken) return policyUnavailableResult();
    return outsideWindowResult(decision, nextAllowedAt);
  }

  const registrar = {
    server: server.server,
    getClientVersion: () => server.server?.getClientVersion?.() ?? server.getClientVersion?.(),
    registerTool(name, config, handler) {
      const wrapped = async (...args) => {
        if (isMetadata(name)) return handler(...args);
        const extra = lastArg(args);
        const subjects = subjectsFromAuthInfo(extra?.authInfo);
        const capabilities = capabilitiesForTool(name);
        // Unknown tool: discovery/protocol owns that semantics.
        if (capabilities === null) return handler(...args);
        const decision = runtime.evaluate({ subjects, capabilities });
        if (decision?.allowed) return handler(...args);
        return deny(decision, subjects, capabilities);
      };
      return server.registerTool(name, config, wrapped);
    },
    registerResource(name, uri, config, handler) {
      const wrapped = async (...args) => {
        if (isMetadataUri(uri)) return handler(...args);
        const capabilities = capabilitiesForResource(uri);
        // Unknown URI: same rule as unknown tools.
        if (capabilities === null) return handler(...args);
        const extra = lastArg(args);
        const subjects = subjectsFromAuthInfo(extra?.authInfo);
        const decision = runtime.evaluate({ subjects, capabilities });
        if (decision?.allowed) return handler(...args);
        return deny(decision, subjects, capabilities);
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
