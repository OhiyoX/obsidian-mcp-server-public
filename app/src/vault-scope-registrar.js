// Wave C — MCP vault-scope registrar. Contract authority:
// `DEVELOPMENT - MCP 多库（vault scope）与按库 Git 配置` §6 (request context keys),
// §7 (canonical tool vault-scope registry), §7.3 (canonical vaultId schema), §8
// (registrar order), §9 (HTTP gate companion + §9.1 unknown tools), §28 (Wave C),
// §34 (authorization matrix), §43-3/§43-4 (no second set, no handler-level
// allowlist), §47 (RETURN conditions).
//
// Position in the chain (contract §8) — this module owns exactly one slot:
//
//   discovery -> access-policy -> vault-scope -> memory-guidance -> handler
//
// so that (a) a temporal deny never reaches Vault resolution, (b) the selected
// Vault is known before memory/author guidance establishes its own context, and
// (c) no handler ever guesses a default Vault.
//
// Responsibilities, and nothing else:
//   1. `inputSchema` — every vault-scoped tool gains the canonical optional
//      `vaultId` (§7.3). Global tools (`agent_bootstrap` / `server_info`, §7.1)
//      keep their schema untouched, and the tool count never changes (§7.4).
//   2. request-level defense-in-depth — with an `authInfo` carrying an
//      `allowedVaults` list, the selected Vault must be a member; otherwise the
//      call is refused structurally and the handler never runs (§7-7, §9).
//   3. existence — a non-default Vault is resolved against the canonical
//      inventory, so an authorized-but-unknown id fails closed instead of
//      silently inheriting primary storage (§34-9, SEC-MV06).
//   4. context — the *selected* `vaultId`, plus the resolved `vaultRuntime` when
//      this process has one for that Vault, are merged into the request context
//      with A4's patch semantics, so outer keys (`authzUsage`, `author`, ...) are
//      never clobbered (§6, A4 HANDOFF "patch 语义字面").
//
// Non-goals (frozen): no session-sticky Vault (§0-3), no handler-level allowlist
// duplication (§43-4), and no per-Vault *runtime factory*: secondary runtimes are
// Wave D/B wiring, so this module only ever reports a runtime it was given or that
// already exists for primary. It never hands a secondary Vault the primary runtime.
//
// `obsidian://vault/*` resources keep reading the primary Vault and never read the
// ambient selection (§19), but the same `allowedVaults` gate now covers them (P0
// finding: a secondary-only credential read the primary Vault's content through
// them). Instance-level resources such as `obsidian://agent/memory-policy` never
// touch a Vault and are delegated untouched.

import { z } from "zod/v4";
import { resolveWebVault } from "./app/vault-registry.js";
import { mcpAuthorizationRequest } from "./authorization/adapters/mcp.js";
import { createAuthorizationSeam } from "./authorization/runtime.js";
import { DEFAULT_VAULT_ID } from "./oauth-provider.js";
import { effectiveVaultId } from "./default-vault.js";
import { withRequestContextPatch } from "./request-context.js";
import { validateVaultId } from "./vault-runtime/descriptor.js";
import { primaryRuntime } from "./vault.js";
import { VAULT_ID_INPUT_SPEC, applyVaultIdSpec, isVaultScopedTool } from "./vault-scope.js";

/** Stable machine-readable refusal codes; consumers/tests never match on prose. */
export const VAULT_SCOPE_DENY_CODES = Object.freeze({
  ACCESS_DENIED: "vault_access_denied",
  INVALID_ID: "vault_id_invalid",
  UNAVAILABLE: "vault_unavailable",
});

/**
 * The canonical `vaultId` descriptor, translated to the zod vocabulary that
 * `server.registerTool({ inputSchema })` consumes. Every bound is read from A3's
 * frozen `VAULT_ID_INPUT_SPEC`, so the descriptor and the served JSON schema
 * cannot drift; only the transport shape differs (zod raw shape here, plain
 * object in the descriptor spec).
 */
export function canonicalVaultIdProperty() {
  const spec = VAULT_ID_INPUT_SPEC;
  return z.string().min(spec.minLength).max(spec.maxLength).optional().describe(spec.description);
}

function lastArg(args) {
  return args.length > 1 ? args[args.length - 1] : undefined;
}

/** The resource namespace whose handlers read the primary Vault's content. */
const VAULT_RESOURCE_PREFIX = "obsidian://vault/";

/** Refusal payload: the code plus the id the caller itself asked for, never inventory facts. */
function denyPayload(code, vaultId) {
  return { code, vaultId };
}

function denyResult(code, vaultId) {
  const payload = denyPayload(code, vaultId);
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}

/**
 * A refused resource read must still answer in the resource shape (`contents`): the SDK client
 * validates every read against it, so the tool shape would arrive as a parse error and lose the
 * code.
 */
function denyResourceResult(uri, code, vaultId) {
  const payload = denyPayload(code, vaultId);
  return {
    contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(payload) }],
    structuredContent: { ...payload },
    isError: true,
  };
}

/** Canonical inventory check (§34-9). Injectable so tests never touch a filesystem. */
async function canonicalVaultExists(vaultId) {
  try {
    await resolveWebVault(vaultId);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Runtime resolution seam. Primary is resolvable today; a secondary has no
 * runtime instance until the Wave D toolset wiring creates one, and this module
 * must never substitute the primary runtime for it (SEC-MV06 / §47 "secondary
 * error fallback primary").
 */
function defaultResolveVaultRuntime(vaultId) {
  return vaultId === DEFAULT_VAULT_ID ? primaryRuntime : undefined;
}

/**
 * Wrap an MCP server so every vault-scoped tool is schema-injected, authorized
 * and executed inside the selected Vault's request context. Returns a registrar
 * shaped like the access-policy / memory-guidance ones so it chains without
 * touching any tool module.
 *
 * @param {object} server upstream registrar or McpServer
 * @param {object} [options]
 * @param {(vaultId: string) => (object|undefined)} [options.resolveVaultRuntime]
 * @param {(vaultId: string) => Promise<boolean>} [options.vaultExists]
 * @param {object} [options.authorizationShadow] P2 shadow observer; observation only
 */
export function createVaultScopeRegistrar(server, { resolveVaultRuntime, vaultExists, authorization = null, accessRuntime = null, authorizationShadow = null } = {}) {
  const runtimeFor = typeof resolveVaultRuntime === "function" ? resolveVaultRuntime : defaultResolveVaultRuntime;
  const exists = typeof vaultExists === "function" ? vaultExists : canonicalVaultExists;
  const shadow = authorizationShadow;
  // P3: the runtime decides the Vault allowlist of this layer too — a duplicate defence
  // that calls the same `authorize()`, never a second rule.
  const decide = createAuthorizationSeam({ authorization, accessRuntime });

  /**
   * The selected Vault's admission decision. Repeating the transport's static rule is the
   * point: the wrapper re-asks, so a decision made earlier in the request cannot be spent.
   */
  function decideVault({ extra, name, args }) {
    const authInfo = extra?.authInfo;
    const request = mcpAuthorizationRequest({
      authInfo,
      name,
      args,
      primaryVaultId: DEFAULT_VAULT_ID,
      legacy: {
        phase: "vault-scope",
        scopes: [...(authInfo?.scopes ?? authInfo?.extra?.scopes ?? [])],
        allowedVaults: [...(authInfo?.allowedVaults ?? authInfo?.extra?.allowedVaults ?? [])],
      },
    });
    if (request === null) return null;
    return { request, decision: decide.authorize(request) };
  }

  /**
   * A Vault resource's admission decision. The read target is fixed (primary), so the
   * canonical request states it explicitly and the same runtime answers; the resource
   * namespace never reads the ambient selection (§19).
   */
  function decideResource({ extra, resourceUri }) {
    const authInfo = extra?.authInfo;
    const request = mcpAuthorizationRequest({
      authInfo,
      resourceUri,
      primaryVaultId: DEFAULT_VAULT_ID,
      legacy: {
        phase: "vault-scope",
        scopes: [...(authInfo?.scopes ?? authInfo?.extra?.scopes ?? [])],
        allowedVaults: [...(authInfo?.allowedVaults ?? authInfo?.extra?.allowedVaults ?? [])],
      },
    });
    if (request === null) return null;
    return { request, decision: decide.authorize(request) };
  }

  // One row per Vault-scope unit. The old verdict is either this layer's own decision or
  // the target-schema refusal below; the new verdict is computed from the same request.
  function observe({ extra, name, args, legacyDecision, request = null }) {
    if (shadow === null || typeof shadow.compare !== "function") return;
    const built = request ?? mcpAuthorizationRequest({ authInfo: extra?.authInfo, name, args, primaryVaultId: DEFAULT_VAULT_ID });
    if (built === null) return;
    shadow.compare({ request: built, legacyDecision, boundaryKey: name, phase: "vault-scope" });
  }

  /**
   * The same row, for a resource unit: the boundary key is the URI, and this layer is the
   * one that decided, so the record names its own verdict instead of leaving the outer
   * layer's allow standing.
   */
  function observeResource({ entry, resourceUri }) {
    if (shadow === null || typeof shadow.compare !== "function" || entry === null) return;
    shadow.compare({ request: entry.request, legacyDecision: entry.decision, boundaryKey: resourceUri, phase: "vault-scope" });
  }

  /** The existing refusal code for a decision, so no client sees a new family. */
  function vaultScopeCode(decision) {
    if (decision.code === "vault_id_invalid") return VAULT_SCOPE_DENY_CODES.INVALID_ID;
    if (decision.code === "vault_unavailable") return VAULT_SCOPE_DENY_CODES.UNAVAILABLE;
    return VAULT_SCOPE_DENY_CODES.ACCESS_DENIED;
  }

  const registrar = {
    server: server.server,
    getClientVersion: () => server.server?.getClientVersion?.() ?? server.getClientVersion?.(),
    registerTool(name, config, handler) {
      if (!isVaultScopedTool(name)) return server.registerTool(name, config, handler);
      // Fail closed if a tool module still hand-writes the local field, and take the canonical merge
      // from A3's spec primitive; the descriptor's plain-object shape is then translated to the zod
      // vocabulary `server.registerTool({ inputSchema })` consumes (§7.3).
      const declared = config?.inputSchema ?? {};
      const canonical = applyVaultIdSpec(declared);
      const inputSchema = {
        ...canonical,
        [VAULT_ID_INPUT_SPEC.name]: canonicalVaultIdProperty(),
      };
      const wrapped = async (...args) => {
        const extra = lastArg(args);
        const selected = effectiveVaultId(args[0], extra?.authInfo, DEFAULT_VAULT_ID);
        try {
          validateVaultId(selected);
        } catch {
          observe({ extra, name, args: args[0], legacyDecision: { allowed: false, code: VAULT_SCOPE_DENY_CODES.INVALID_ID } });
          return denyResult(VAULT_SCOPE_DENY_CODES.INVALID_ID, selected);
        }
        // Authorization before any Vault I/O (contract §8/§9, brief §2.3). The runtime
        // decides the Vault admission; this layer only repeats the same call.
        const entry = decideVault({ extra, name, args: args[0] });
        if (entry !== null && entry.decision.allowed !== true) {
          observe({ extra, name, args: args[0], request: entry.request, legacyDecision: entry.decision });
          return denyResult(vaultScopeCode(entry.decision), selected);
        }
        if (selected !== DEFAULT_VAULT_ID) {
          let known;
          try {
            known = await exists(selected);
          } catch {
            observe({ extra, name, args: args[0], legacyDecision: { allowed: false, code: VAULT_SCOPE_DENY_CODES.UNAVAILABLE } });
            return denyResult(VAULT_SCOPE_DENY_CODES.UNAVAILABLE, selected);
          }
          if (!known) {
            observe({ extra, name, args: args[0], legacyDecision: { allowed: false, code: VAULT_SCOPE_DENY_CODES.UNAVAILABLE } });
            return denyResult(VAULT_SCOPE_DENY_CODES.UNAVAILABLE, selected);
          }
        }
        if (entry !== null) observe({ extra, name, args: args[0], request: entry.request, legacyDecision: entry.decision });
        const vaultRuntime = runtimeFor(selected);
        return withRequestContextPatch(
          { vaultId: selected, vaultRuntime },
          () => handler(...args),
        );
      };
      return server.registerTool(name, { ...config, inputSchema }, wrapped);
    },
    registerResource(name, uri, config, handler) {
      if (typeof uri !== "string" || !uri.startsWith(VAULT_RESOURCE_PREFIX)) {
        return server.registerResource(name, uri, config, handler);
      }
      const wrapped = async (...args) => {
        // Before any Vault I/O. The runtime decides; this layer only repeats the same call,
        // so the resource can never carry its own allowlist rule.
        const entry = decideResource({ extra: lastArg(args), resourceUri: uri });
        observeResource({ entry, resourceUri: uri });
        if (entry !== null && entry.decision.allowed !== true) {
          return denyResourceResult(uri, vaultScopeCode(entry.decision), DEFAULT_VAULT_ID);
        }
        return handler(...args);
      };
      return server.registerResource(name, uri, config, wrapped);
    },
  };

  // The generic delegation below passes prompt registration (and any registrar
  // member not overridden above) straight through.

  for (const key of Object.keys(server)) {
    if (key in registrar) continue;
    const value = server[key];
    registrar[key] = typeof value === "function" ? value.bind(server) : value;
  }
  return registrar;
}
