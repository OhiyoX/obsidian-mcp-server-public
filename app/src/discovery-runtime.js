// Runtime Progressive Tool Discovery Phase 2B wiring.
//
// This is the only module that connects the pure capability-policy view to the
// live MCP server. It constrains tools/list, direct tools/call, and the
// server_info policy summary from the same per-request resolver:
//
//   canonical catalog -> current request granted scopes hard filter ->
//   immutable operator profile -> denyTools -> native-order membership filter
//
// Invariants:
// - Visibility is never authorization. The auth middleware still derives and
//   enforces scopes from the real tool name on every request.
// - The view is recomputed from extra.authInfo on every request. It is never
//   cached on the session, so revoked scopes or a different identity can never
//   reuse a broader list. A missing auth context fails closed unless the server
//   explicitly injected authDisabled (authMode === "none").
// - The SDK tool registry is never mutated (no enable/disable/remove and no
//   list_changed notification). A hidden tool stays registered but unreachable.

import { AsyncLocalStorage } from "node:async_hooks";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CAPABILITY_CATALOG, CAPABILITY_CATALOG_TOOL_COUNT } from "./capability-catalog.js";
import { buildCapabilityPolicyView } from "./capability-policy.js";
import { MCP_SCOPES } from "./scopes.js";
import { loadDiscoveryOperatorConfig } from "./discovery-config.js";
import { compactToolView, isCompactProfile, projectCompactCall } from "./compact-tools.js";
import { compactDescriptorFingerprint } from "./compact-descriptor-integrity.js";

export const DISCOVERY_RUNTIME_SCHEMA_VERSION = 1;

const ALL_SCOPES = Object.freeze([...MCP_SCOPES]);
const VALID_SCOPE_SET = new Set(MCP_SCOPES);
const CATALOG_NAME_SET = new Set(CAPABILITY_CATALOG.map((entry) => entry.name));
const viewStore = new AsyncLocalStorage();
const defaultOperatorConfig = loadDiscoveryOperatorConfig();

// A missing auth context grants every scope only when the server explicitly
// reports that authorization is disabled (authMode === "none"). The runtime
// option is injected by server.js; the resolver default is auth-expected so any
// future caller that forgets the option fails closed. A present context with a
// missing or malformed scope list always fails closed, even when disabled.
export function scopesFromAuthInfo(authInfo, { authDisabled = false } = {}) {
  if (!authInfo) return authDisabled ? [...ALL_SCOPES] : [];
  const scopes = authInfo.scopes;
  if (!Array.isArray(scopes)) return [];
  // Unknown scopes are dropped, never passed through to the policy view.
  return scopes.map((scope) => String(scope)).filter((scope) => VALID_SCOPE_SET.has(scope));
}

export function resolveDiscoveryView({ authInfo, authDisabled = false, operatorConfig = defaultOperatorConfig } = {}) {
  return buildCapabilityPolicyView({
    grantedScopes: scopesFromAuthInfo(authInfo, { authDisabled }),
    profile: operatorConfig.profile,
    toolsets: operatorConfig.toolsets,
    tools: operatorConfig.tools,
    denyTools: operatorConfig.denyTools,
  });
}

// View for the tools/call currently executing, if any. Tools such as
// server_info read this instead of recomputing policy.
export function currentDiscoveryView() {
  return viewStore.getStore() || null;
}

// Bounded, name-free summary. Counts only: hidden tool names never leak.
export function discoveryPolicySummary(view) {
  const granted = new Set(view.grantedScopes);
  const authorizedCount = CAPABILITY_CATALOG.filter((entry) => entry.scope.every((scope) => granted.has(scope))).length;
  return Object.freeze({
    schemaVersion: DISCOVERY_RUNTIME_SCHEMA_VERSION,
    profile: view.profile,
    catalogToolCount: CAPABILITY_CATALOG_TOOL_COUNT,
    authorizedToolCount: authorizedCount,
    visibleToolCount: view.exposedToolCount ?? view.toolNames.length,
    ...(view.exposedToolCount === undefined ? {} : { canonicalVisibleToolCount: view.toolNames.length }),
    hiddenByScope: Math.max(0, CAPABILITY_CATALOG_TOOL_COUNT - authorizedCount),
    hiddenByPolicy: Math.max(0, authorizedCount - view.toolNames.length),
    // Compact only: the digest of the exact descriptor set this request would
    // list, so a Host can reconcile a cached schema against the served one
    // (Issue #626). Never a scope or a policy input.
    ...(view.exposedSchemaFingerprint === undefined ? {} : { compactSchemaFingerprint: view.exposedSchemaFingerprint }),
  });
}

function unknownToolResult(name) {
  // Tiny local builder for the unknown-tool CallToolResult. It deliberately
  // does not reach into the private SDK `McpServer.createToolError` helper.
  // The pinned SDK renders a missing tool as exactly this shape (verified by
  // the real-transport parity characterization in discovery-runtime.test.js),
  // so an operator-hidden tool stays protocol-identical to a name that was
  // never registered. If a future SDK changes that shape, the characterization
  // test fails and this compatibility builder is the single place to update.
  return {
    content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }],
    isError: true,
  };
}

// Wraps a live McpServer for registration and installs the per-request view on
// tools/list and tools/call. Registration still flows through the real
// McpServer so descriptors, schemas, and handlers keep native parity.
export function createDiscoveryRuntimePolicy(server, operatorConfig = defaultOperatorConfig, { authDisabled = false } = {}) {
  const protocol = server?.server;
  if (!protocol || typeof protocol.setRequestHandler !== "function") {
    throw new Error("Discovery runtime policy requires an McpServer with an underlying protocol server");
  }
  const frozenAuthDisabled = Boolean(authDisabled);
  const frozenConfig = Object.freeze({
    ...operatorConfig,
    toolsets: Object.freeze([...(operatorConfig.toolsets || [])]),
    tools: Object.freeze([...(operatorConfig.tools || [])]),
    denyTools: Object.freeze([...(operatorConfig.denyTools || [])]),
  });
  const originalSetRequestHandler = protocol.setRequestHandler.bind(protocol);
  let nativeListTools = null;
  let nativeCallTool = null;

  // Capture the SDK handlers as McpServer installs them so the filtered view
  // delegates to the exact native descriptor builder and execution path.
  protocol.setRequestHandler = (schema, handler) => {
    if (schema === ListToolsRequestSchema) nativeListTools = handler;
    else if (schema === CallToolRequestSchema) nativeCallTool = handler;
    return originalSetRequestHandler(schema, handler);
  };

  let installed = false;
  function install() {
    if (installed) return;
    installed = true;
    protocol.setRequestHandler = originalSetRequestHandler;
    if (!nativeListTools || !nativeCallTool) {
      throw new Error("Discovery runtime policy could not capture native tool handlers");
    }

    protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const result = await nativeListTools(request, extra);
      const view = resolveDiscoveryView({ authInfo: extra?.authInfo, authDisabled: frozenAuthDisabled, operatorConfig: frozenConfig });
      const visible = new Set(view.toolNames);
      const nativeNames = result.tools.map((tool) => tool.name);
      const nativeSet = new Set(nativeNames);
      // Fail loudly instead of silently dropping a policy-visible name with no
      // native registration. The reverse direction catches a tool registered
      // outside the catalog. Neither is a policy decision, so neither is hidden.
      const missingNative = view.toolNames.filter((name) => !nativeSet.has(name));
      const uncataloged = nativeNames.filter((name) => !CATALOG_NAME_SET.has(name));
      if (missingNative.length || uncataloged.length) {
        throw new Error(`Discovery catalog/registration drift: missingNative=[${missingNative.join(", ")}] uncataloged=[${uncataloged.join(", ")}]`);
      }
      if (isCompactProfile(view.profile)) {
        // Virtual descriptors are generated from SDK-native schemas and the
        // *already authorized* original names; underlying registrations stay unchanged.
        return { ...result, tools: compactToolView(result.tools, view.toolNames).tools };
      }
      // Full/core/module/custom must retain exact original descriptor parity.
      return { ...result, tools: result.tools.filter((tool) => visible.has(tool.name)) };
    });

    protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const view = resolveDiscoveryView({ authInfo: extra?.authInfo, authDisabled: frozenAuthDisabled, operatorConfig: frozenConfig });
      if (!isCompactProfile(view.profile)) {
        if (!view.toolNames.includes(request.params.name)) return unknownToolResult(request.params.name);
        return viewStore.run(view, () => nativeCallTool(request, extra));
      }
      // Compact names never become independent capability/Scope authorities.
      // Recompute from the SDK's complete descriptors and caller's current
      // request policy; denyTools, revoked Scope and hidden actions fail closed.
      const native = await nativeListTools({ method: "tools/list", params: {} }, extra);
      const compact = compactToolView(native.tools, view.toolNames);
      const permitted = compact.routing.get(request.params.name);
      if (!permitted) return unknownToolResult(request.params.name);
      const payload = request.params.arguments;
      if (request.params.name === "agent_bootstrap" || request.params.name === "server_info") {
        return viewStore.run({
          ...view,
          exposedToolCount: compact.tools.length,
          exposedToolNames: compact.tools.map((tool) => tool.name),
          exposedSchemaFingerprint: compactDescriptorFingerprint(compact.tools),
        }, () => nativeCallTool(request, extra));
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          Object.keys(payload).some((key) => key !== "action" && key !== "params") ||
          !payload.params || typeof payload.params !== "object" || Array.isArray(payload.params)) {
        return unknownToolResult(request.params.name);
      }
      const projected = projectCompactCall(request.params.name, payload);
      if (!permitted.has(projected.name) || !view.toolNames.includes(projected.name)) {
        return unknownToolResult(request.params.name);
      }
      const delegated = { ...request, params: { ...request.params, name: projected.name, arguments: projected.args } };
      return viewStore.run({ ...view, exposedToolCount: compact.tools.length, exposedToolNames: compact.tools.map((tool) => tool.name) }, () => nativeCallTool(delegated, extra));
    });
  }

  const registrar = {
    server: protocol,
    getClientVersion: () => protocol.getClientVersion?.(),
    registerTool: (...args) => server.registerTool(...args),
    registerResource: (...args) => server.registerResource(...args),
    registerPrompt: (...args) => server.registerPrompt(...args),
    install,
    get operatorConfig() { return frozenConfig; },
    get authDisabled() { return frozenAuthDisabled; },
  };
  return Object.freeze(registrar);
}

export { loadDiscoveryOperatorConfig };
