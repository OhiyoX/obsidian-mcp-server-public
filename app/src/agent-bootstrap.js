import { WRITE_TOOLS } from "./capability-catalog.js";
import { MEMORY_PATH, READ_ONLY, SKILLS_PATH } from "./config.js";
import { bundledPromptRegistry } from "./prompt-registry/bundled.js";
import { livePromptSnapshot } from "./prompt-registry/live.js";
import { renderPromptTemplate } from "./prompt-registry/schema.js";
import { vaultLayout } from "./vault-layout.js";

export const MEMORY_POLICY_VERSION = "1.2.0";
export const MEMORY_POLICY_URI = "obsidian://agent/memory-policy";
export const MEMORY_POLICY_NOTE = `${vaultLayout.system}/Agent/AI 笔记规范.md`;

/** Values a Base template may interpolate here; everything else is code-owned fact. */
const TEMPLATE_VALUES = Object.freeze({ memoryPolicyNote: MEMORY_POLICY_NOTE });

/** Phase order is code; each phase's wording comes from the Base pack. */
const WORKFLOW_PHASES = Object.freeze(["start", "reuse-and-improve", "checkpoint", "doc-hygiene", "write", "verify"]);
const BOUNDARY_COUNT = 8;

function copyOf(promptSnapshot, key) {
  const text = promptSnapshot.values[key];
  if (typeof text !== "string") throw new Error(`Base pack is missing ${key}`);
  return renderPromptTemplate(text, TEMPLATE_VALUES);
}

/**
 * Initialize instructions for a new MCP session. Base-only: this text is read
 * when a session is created, so an existing session keeps the copy it got.
 */
export function getInitializeInstructions(promptSnapshot = livePromptSnapshot()) {
  return copyOf(promptSnapshot, "bootstrap.instructions");
}

// Backwards-compatible constant: the bundled pack's text, not a second copy.
export const AGENT_INSTRUCTIONS = getInitializeInstructions();

export function getAgentBootstrap({ client = "generic", project = "", promptSnapshot = livePromptSnapshot() } = {}) {
  if (promptSnapshot === null || typeof promptSnapshot !== "object" || typeof promptSnapshot.values !== "object") {
    throw new TypeError("getAgentBootstrap needs a prompt snapshot");
  }
  return {
    policyVersion: MEMORY_POLICY_VERSION,
    // Which copy the host actually read: a revision number and whether an override
    // is in force, so a session can report its own version instead of guessing.
    promptRevision: Number.isInteger(promptSnapshot.revision) ? promptSnapshot.revision : 0,
    promptSource: (promptSnapshot.overrideCount ?? 0) > 0 ? "base+override" : "base",
    policySource: "server-maintained contract; not generated from retrieved notes",
    policyUri: MEMORY_POLICY_URI,
    client,
    scope: "User-authorized durable project memory; not blanket authority to change other systems.",
    instructions: getInitializeInstructions(promptSnapshot),
    writes: {
      enabled: !READ_ONLY,
      mode: READ_ONLY ? "read-only; prepare a local pending note if needed" : "meaningful-checkpoints-only",
      requires: ["user permits memory", "durable new information", "no credentials", "client write permission"],
      // #276: "writes.enabled: true" without a name left an agent free to conclude it had no write
      // tool at all. The names come from the scope table, so this cannot drift from what ships.
      // A host that exposes the v2 domain tools sees these actions under its own names
      // (`obsidian_edit_write_nonidempotent` and friends); the actions are the same.
      tools: READ_ONLY ? [] : [...WRITE_TOOLS],
    },
    workflow: WORKFLOW_PHASES.map((phase) => ({
      phase,
      action: copyOf(promptSnapshot, `bootstrap.workflow.${phase}`),
    })),
    entrypoints: {
      conventions: MEMORY_POLICY_NOTE,
      documentRouting: `${SKILLS_PATH}/vault-workspace-maintenance/references/doc-routing.md`,
      capabilityImprovement: `${SKILLS_PATH}/vault-workspace-maintenance/references/capability-loop.md`,
      projects: `${vaultLayout.projects}/README.md`,
      memories: `${MEMORY_PATH}/README.md`,
      skills: `${SKILLS_PATH}/README.md`,
      home: vaultLayout.home,
    },
    routing: {
      projectState: `${vaultLayout.projects}/<existing-project>/README.md`,
      datedProjectHistory: `${vaultLayout.projects}/<existing-project>/History/<date> <topic>.md`,
      activeProjectTask: `${vaultLayout.projects}/<existing-project>/TODO - <topic>.md (or existing domain TODO)`,
      currentOperationsState: `${vaultLayout.ops}/{Hosts,Services,Agents}/<existing-item>/README.md`,
      documentationPolicy: `${SKILLS_PATH}/vault-workspace-maintenance/references/doc-routing.md`,
      durableMemory: MEMORY_PATH,
      reusableProcedure: SKILLS_PATH,
      personalNotes: "Preserve location and format; no mandatory frontmatter or automatic reorganization.",
    },
    boundaries: Array.from({ length: BOUNDARY_COUNT }, (_, index) => copyOf(promptSnapshot, `bootstrap.boundary.${index + 1}`)),
    nextRead: project ? { tool: "search_notes", arguments: { query: project, limit: 5 } }
      : { tool: "get_note", arguments: { path: `${vaultLayout.projects}/README.md`, format: "content" } },
    compatibility: {
      clients: ["codex", "cursor", "workbuddy", "openclaw", "hermes", "generic MCP clients"],
      toolNaming: copyOf(promptSnapshot, "bootstrap.compatibility.toolNaming"),
      fallback: copyOf(promptSnapshot, "bootstrap.compatibility.fallback"),
      activation: copyOf(promptSnapshot, "bootstrap.compatibility.activation"),
    },
  };
}
