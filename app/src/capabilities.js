import { TOOL_NAMES } from "./config.js";
import { registerFileTools } from "./tools/files.js";
import { registerInfoTools } from "./tools/info.js";
import { registerLinkTools } from "./tools/links.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerResources } from "./resources.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerGitTools } from "./tools/git.js";
import { registerIntelligenceTools } from "./tools/intelligence.js";
import { registerContextTools } from "./tools/context.js";
import { registerPublishTools } from "./tools/publish.js";
import { registerPlanTools } from "./tools/plans.js";
import { registerPrompts } from "./prompts.js";
import { createMemoryGuidanceRegistrar } from "./memory-guidance.js";
import { createAccessPolicyRegistrar } from "./access-policy/registrar.js";
import { createVaultScopeRegistrar } from "./vault-scope-registrar.js";

export { TOOL_NAMES };

// Registration/invocation order (INTERFACE §10.1 + contract §8): discovery
// membership -> temporal access gate -> vault scope -> memory guidance -> real
// handler. The access-policy registrar wraps the discovery registrar first, so it
// sits *inside* the discovery membership check and *outside* vault scope: a
// temporal deny never triggers Vault resolution. Vault scope then sits outside
// memory guidance, so the selected `vaultId`/`vaultRuntime` are established before
// the guidance layer builds its own context (A4 patch semantics) and the handler
// can read them. A disabled runtime still evaluates (allow-all), which is what
// makes Stage 0 a structural zero difference instead of a short-circuit.
// P2: `authorizationShadow` is the observation-only seam. P3: `authorization` is the one
// runtime every MCP boundary decides through. Both default to null, so the registration
// graph is byte-for-byte the legacy one when nothing is injected.
export function registerObsidianCapabilities(server, { accessRuntime, authorization = null, vaultScope, authorizationShadow = null } = {}) {
  if (accessRuntime || authorization) server = createAccessPolicyRegistrar(server, { runtime: accessRuntime, authorization, authorizationShadow });
  server = createVaultScopeRegistrar(server, { ...vaultScope, authorization, accessRuntime, authorizationShadow });
  server = createMemoryGuidanceRegistrar(server);
  registerInfoTools(server);
  registerNoteTools(server);
  registerSearchTools(server);
  registerFileTools(server);
  registerLinkTools(server);
  registerWorkflowTools(server);
  registerGitTools(server);
  registerIntelligenceTools(server);
  registerContextTools(server);
  registerPublishTools(server);
  registerPlanTools(server);
  registerResources(server);
  registerPrompts(server);
}
