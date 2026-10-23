import { ok } from "../result.js";
import { effectiveVaultId } from "../default-vault.js";
import { deployedVersion, formatDeployTime } from "../release-version.js";
import { getVaultHealth } from "../vault.js";
import { getVaultIndexStats } from "../vault-index.js";
import { z } from "zod/v4";
import { listWebVaults, webVaultRegistry } from "../app/vault-registry.js";
// #647: the auth plane's primary Vault id. `server_info` used to derive this field from the
// REGISTRY plane (`defaultWebVaultId()` = WEB_DEFAULT_VAULT || basename(VAULT)), while the HTTP
// gate and the MCP registrar both use THIS constant (`WEB_DEFAULT_VAULT || "vault"`). With
// WEB_DEFAULT_VAULT unset and VAULT_PATH=<root>/alpha the two answer differently ("alpha" vs
// "vault"), so the metadata could name a Vault the routing boundary would never choose.
import { DEFAULT_VAULT_ID } from "../oauth/primitives.js";
import { defaultCapabilitiesFor } from "../vault-runtime/registry.js";
import { getAgentBootstrap, MEMORY_POLICY_URI, MEMORY_POLICY_VERSION } from "../agent-bootstrap.js";
import { authClientIdFromExtra, cleanAuthorField, getInitializedClientInfo, isGenericClientName, resolveRequestAuthor } from "../request-context.js";
import { currentDiscoveryView, discoveryPolicySummary, resolveDiscoveryView } from "../discovery-runtime.js";
import { getSessionAuthor, setSessionAuthor } from "../session-author.js";

// Contract §18.1 ("MCP / Web / Admin visibility") — the only safe Vault metadata an MCP caller
// may see: id/name/primary/writable/capabilities. Never the root, a data path, a remote or a
// credential. Wave F / F1 (§31) reads `capabilities` from the ONE canonical A2 registry descriptor
// (`src/app/vault-registry.js`), so this plane reports the same per-Vault runtime facts the Web
// face and Admin do; before the registry has published a usable snapshot the fail-closed A2
// default is reported instead of guessing (§3.4).
function safeVaultMetadata(vault) {
  return {
    id: vault.id,
    name: vault.name,
    primary: vault.primary === true,
    writable: vault.writable === true,
    capabilities: webVaultRegistry.get(String(vault.id))?.capabilities ?? defaultCapabilitiesFor(),
  };
}

/** Caller-filtered inventory: `allowedVaults ∩ registry` (contract §18.1, §34-9). */
async function visibleVaults(extra) {
  const allowed = extra?.authInfo?.allowedVaults;
  const permitted = Array.isArray(allowed) ? new Set(allowed.map(String)) : (extra?.authInfo ? new Set() : null);
  try {
    const inventory = await listWebVaults();
    return inventory.vaults
      .filter((vault) => !permitted || permitted.has(String(vault.id)))
      .map(safeVaultMetadata);
  } catch {
    // The global metadata plane stays reachable while the inventory is broken (SEC-MV08, A-07),
    // and it never fabricates a Vault it cannot prove.
    return [];
  }
}

function rememberSessionAuthor(server, args = {}, extra) {
  const label = String(args.client || "").trim();
  const model = String(args.model || "").trim();
  const authClientId = authClientIdFromExtra(extra);
  if (!label && !model) return getSessionAuthor(extra?.sessionId, authClientId);

  const clientName = getInitializedClientInfo(server).name;
  const genericClient = isGenericClientName(clientName);

  // Policy `client` is a label. It becomes write agent only when initialize used a
  // generic placeholder (Cursor often sends mcp-client) or it matches clientInfo.name.
  let agent;
  if (!genericClient && clientName) {
    agent = clientName;
  } else {
    agent = label || process.env.MCP_DEFAULT_AUTHOR_AGENT || clientName || "mcp-client";
  }

  const author = {
    agent: cleanAuthorField(agent, "agent"),
    model: cleanAuthorField(model || process.env.MCP_DEFAULT_AUTHOR_MODEL || getSessionAuthor(extra?.sessionId, authClientId)?.model || "unspecified", "model"),
  };
  setSessionAuthor(extra?.sessionId, author, authClientId);
  return author;
}

export function registerInfoTools(server) {
  server.registerTool("agent_bootstrap", {
    title: "Obsidian Agent Memory Bootstrap",
    description: "Start here for durable project work: load the shared recall, note-taking, verification and privacy workflow once per conversation. Pass client and model so writes get correct mcp_author when the host cannot send _meta (especially when clientInfo.name is mcp-client). Works with any agent; never stores the conversation.",
    inputSchema: {
      client: z.string().trim().min(1).max(80).optional().describe("Optional client label, e.g. codex, cursor, workbuddy, openclaw, hermes. When MCP initialize used a generic name (mcp-client), this becomes the session write author."),
      model: z.string().trim().min(1).max(160).optional().describe("Optional model name for mcp_author on later writes (e.g. grok, composer, gpt-5.6). Sticky across MCP session reconnects for the same auth client when the host cannot send _meta."),
      project: z.string().trim().max(200).optional().describe("Optional non-secret project name for the suggested initial search; do not send full prompts or credentials."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args = {}, extra) => {
    const policy = getAgentBootstrap(args);
    const author = rememberSessionAuthor(server, args, extra);
    const derived = author || (() => {
      try { return resolveRequestAuthor(server, extra || {}); } catch { return undefined; }
    })();
    return ok({
      ...policy,
      ...(derived ? { writeAuthor: derived } : {}),
    });
  });
  server.registerTool(
    "server_info",
    {
      title: "Obsidian Server Info",
      description: "Return server configuration, health, tools and memory onboarding. For shared project-memory conventions start with agent_bootstrap.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => {
      const view = currentDiscoveryView() || resolveDiscoveryView({ authInfo: extra?.authInfo });
      const release = deployedVersion();
      const vaults = await visibleVaults(extra);
      const effective = effectiveVaultId({}, extra?.authInfo, DEFAULT_VAULT_ID);
      const effectiveVisible = vaults.some((vault) => vault.id === effective);
      return ok({
        ...(await getVaultHealth()),
        version: release.version,
        commit: release.commit,
        deployedAt: release.deployedAt,
        deployedAtFormatted: formatDeployTime(release.deployedAt),
        defaultVaultId: DEFAULT_VAULT_ID,
        effectiveDefaultVaultId: effectiveVisible ? effective : null,
        defaultVaultSource: extra?.authInfo?.defaultVaultId ? "credential" : "server",
        vaults,
        tools: view.exposedToolNames || view.toolNames,
        discovery: discoveryPolicySummary(view),
        index: getVaultIndexStats(),
        onboarding: { tool: "agent_bootstrap", policyUri: MEMORY_POLICY_URI, policyVersion: MEMORY_POLICY_VERSION },
      });
    },
  );
}
